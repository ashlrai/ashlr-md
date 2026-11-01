import base64
import json
import os
import shutil
from unittest import mock
import importlib.util
import io
from pathlib import Path
import plistlib
import struct
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('assembly', Path(__file__).with_name('assemble-updater.py'))
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)

class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
    def tearDown(self): self.tmp.cleanup()
    def payload(self, target, name, data):
        leg = self.root / a.LEGS[target]; leg.mkdir(exist_ok=True)
        path = leg / name; path.write_bytes(data); path.with_name(path.name + '.sig').write_text('test-only')
        return path
    def test_linux_inventory_and_rejections(self):
        target = 'linux-x86_64'; data = b'\x7fELF\x02\x01' + bytes(12) + b'\x3e\x00'
        p = self.payload(target, 'Ashlr MD_0.4.0_amd64.AppImage', data)
        self.assertEqual(a.inventory(self.root, target, '0.4.0')[0], p)
        with self.assertRaises(ValueError): a.inventory(self.root, target, '1.0.0')
        self.payload(target, 'other.AppImage', data)
        with self.assertRaises(ValueError): a.inventory(self.root, target, '0.4.0')
        p.write_bytes(data[:-2] + b'\xb7\x00')
        with self.assertRaises(ValueError): a.verify_platform(p, target, '0.4.0')
    def test_linux_payload_arch_and_version_fail_closed(self):
        exe = b'\x7fELF\x02\x01' + bytes(12) + b'\x3e\x00'
        listing = f'Path = usr/bin/md-opener\nMode = -rwxr-xr-x\nSize = {len(exe)}\n\n'.encode()
        tool = self.root / '7zz'; tool.write_bytes(b'test only')
        with mock.patch.dict(os.environ, {'ASHLR_MD_7ZZ':str(tool)}), mock.patch.object(a, 'digest', return_value='d32657a7a0e4cdc0a8aa57cafe474746944d76e861e753e9c902b9c9356fa886'):
            with mock.patch.object(a, 'bounded_7zz', side_effect=[listing, exe]):
                a.verify_linux_payload(self.root / 'x')
            with mock.patch.object(a, 'bounded_7zz', side_effect=[listing, exe[:-2] + b'\xb7\x00']):
                with self.assertRaisesRegex(ValueError, 'architecture mismatch'): a.verify_linux_payload(self.root / 'x')
            with mock.patch.object(a, 'bounded_7zz', return_value=b'Path = ../escape\nSize = 1\nMode = -rwx\n\n'):
                with self.assertRaisesRegex(ValueError, 'unsafe'): a.verify_linux_payload(self.root / 'x')
    def test_relative_7zz_is_rejected_before_hash_or_execution(self):
        with mock.patch.dict(os.environ, {'ASHLR_MD_7ZZ': '7zz'}), \
             mock.patch.object(a, 'digest') as digest, \
             mock.patch.object(a, 'bounded_7zz') as execute:
            for inspect in (lambda: a.verify_linux_payload(self.root / 'x'),
                            lambda: a.verify_windows_payload(self.root / 'x', '0.4.0')):
                with self.assertRaisesRegex(ValueError, 'absolute path'): inspect()
            digest.assert_not_called()
            execute.assert_not_called()
    def test_fixed_staging_root_rejects_unsafe_names_and_symlink(self):
        root = self.root / 'private-stage'
        with mock.patch.object(a, 'STAGING_ROOT', root):
            for name in ('..', '.', '../escape', '/tmp/escape', 'a/b', '', 'a\\b'):
                with self.assertRaisesRegex(ValueError, 'simple basename'): a.prepare_staging_root(name)
                self.assertFalse(root.exists())
            outside = self.root / 'outside'; outside.mkdir()
            root.symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'not a symlink'): a.prepare_staging_root('release')
            root.unlink(); root.mkdir(mode=0o755); root.chmod(0o755)
            with self.assertRaisesRegex(ValueError, 'private owner-controlled'): a.prepare_staging_root('release')
            root.chmod(0o700)
            fd = a.prepare_staging_root('release-v0.4.0'); os.close(fd)

    def test_atomic_output_does_not_replace_late_directory_or_symlink(self):
        for kind in ('directory', 'symlink'):
            source = self.root / ('stage-' + kind); source.mkdir()
            (source / 'result').write_text('staged')
            destination = self.root / ('out-' + kind)
            self.assertFalse(destination.exists())  # earlier check observed absence
            if kind == 'directory':
                destination.mkdir(); (destination / 'sentinel').write_text('keep')
            else:
                target = self.root / 'target'; target.mkdir()
                (target / 'sentinel').write_text('keep'); destination.symlink_to(target)
            with self.assertRaises(FileExistsError): a.rename_no_replace(source, destination)
            self.assertTrue(source.is_dir())
            self.assertEqual((destination / 'sentinel').read_text(), 'keep')
        source = self.root / 'successful-stage'; source.mkdir()
        (source / 'result').write_text('staged')
        destination = self.root / 'successful-output'
        a.rename_no_replace(source, destination)
        self.assertEqual((destination / 'result').read_text(), 'staged')

    def test_atomic_output_does_not_replace_late_empty_directory(self):
        source = self.root / 'staged-empty-race'; source.mkdir()
        destination = self.root / 'late-empty'
        parent_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            self.assertFalse(destination.exists())  # first check sees no destination
            destination.mkdir()  # another actor creates an empty directory
            inode = destination.stat().st_ino
            with self.assertRaises(FileExistsError):
                a.rename_no_replace(source, destination.name, parent_fd)
            self.assertEqual(destination.stat().st_ino, inode)
            self.assertEqual(list(destination.iterdir()), [])
            self.assertTrue(source.is_dir())
        finally:
            os.close(parent_fd)

    def test_atomic_output_fails_closed_if_renameat2_missing(self):
        with mock.patch.object(a.ctypes, 'CDLL', return_value=object()):
            with self.assertRaisesRegex(OSError, 'renameat2 unavailable'):
                a.rename_no_replace(self.root / 'stage', self.root / 'out')

    def test_windows_fails_closed(self):
        data = bytearray(134); data[:2] = b'MZ'; data[60:64] = struct.pack('<I', 128); data[128:134] = b'PE\0\0\x4c\x01'
        p = self.payload('windows-x86_64', 'Ashlr MD_0.4.0_x64-setup.exe', data)
        with mock.patch.dict(os.environ, {'ASHLR_MD_7ZZ':''}):
            with self.assertRaisesRegex(ValueError, 'verified official'): a.verify_windows_payload(p, '0.4.0')
    def test_mac_version_and_architecture(self):
        target = 'darwin-aarch64'; leg = self.root / a.LEGS[target]; leg.mkdir()
        p = leg / 'Ashlr MD.app.tar.gz'
        with tarfile.open(p, 'w:gz') as tar:
            for name, data in [('Ashlr MD.app/Contents/Info.plist', plistlib.dumps({'CFBundleShortVersionString':'0.4.0', 'CFBundleExecutable':'Ashlr MD'})), ('Ashlr MD.app/Contents/MacOS/Ashlr MD', b'\xcf\xfa\xed\xfe' + struct.pack('<I', 0x0100000c))]:
                info = tarfile.TarInfo(name); info.size = len(data); tar.addfile(info, io.BytesIO(data))
        p.with_name(p.name + '.sig').write_text('test-only')
        a.inventory(self.root, target, '0.4.0'); a.verify_platform(p, target, '0.4.0')
        with self.assertRaises(ValueError): a.verify_platform(p, target, '0.4.1')
        with self.assertRaises(ValueError): a.verify_platform(p, 'darwin-x86_64', '0.4.0')

class AssemblyTests(unittest.TestCase):
    def test_real_verifier_with_public_test_vector(self):
        # Official public minisign-verify README vector; fixtures are test-only.
        key = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"
        sig = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA=="
        b64 = lambda x: base64.b64encode(x.encode()).decode()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / 'src-tauri').mkdir(); (root / 'scripts').mkdir()
            (root / 'src-tauri/tauri.conf.json').write_text(json.dumps({'version':'0.4.0','plugins':{'updater':{'pubkey':b64(key)}}}))
            (root / 'package.json').write_text('{"version":"0.4.0"}')
            (root / 'src-tauri/Cargo.toml').write_text('[package]\nversion="0.4.0"\n')
            shutil.copytree(Path(__file__).parent / 'release-signature-check', root / 'scripts/release-signature-check', ignore=shutil.ignore_patterns('target'))
            inv = root / 'inventory'; inv.mkdir()
            names = {'darwin-aarch64':'Ashlr MD.app.tar.gz', 'darwin-x86_64':'Ashlr MD.app.tar.gz', 'linux-x86_64':'Ashlr MD_0.4.0_amd64.AppImage', 'windows-x86_64':'Ashlr MD_0.4.0_x64-setup.exe'}
            for target, name in names.items():
                leg = inv / a.LEGS[target]; leg.mkdir(); (leg / name).write_bytes(b'test'); (leg / (name + '.sig')).write_text(b64(sig))
            # Only this test bypasses platform inspection: the public vector is
            # plain text, not an executable. Crypto verification remains real.
            with mock.patch.object(a, 'ROOT', root), mock.patch.object(a, 'verify_platform'):
                a.assemble(inv, root / 'out', '2026-01-01T00:00:00Z', '0.4.0', b64(key), {'test_only': True})
                manifest = json.loads((root / 'out/latest.json').read_text())
                self.assertEqual(set(manifest['platforms']), set(a.LEGS))
                self.assertEqual(manifest['platforms']['darwin-aarch64']['signature'], b64(sig))
                (inv / a.LEGS['linux-x86_64'] / names['linux-x86_64']).write_bytes(b'tampered')
                with self.assertRaises(a.subprocess.CalledProcessError): a.assemble(inv, root / 'bad', '2026-01-01T00:00:00Z', '0.4.0', b64(key), {'test_only': True})
                self.assertFalse((root / 'bad').exists())

if __name__ == '__main__': unittest.main()
