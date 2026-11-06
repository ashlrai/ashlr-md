import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sources', Path(__file__).with_name('apt-https-sources.py'))
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)


class SourcesTests(unittest.TestCase):
    def test_list_and_deb822_preserve_everything_but_scheme(self):
        text = ('deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu.gpg] http://azure.archive.ubuntu.com/ubuntu jammy main universe\n'
                '# deb http://archive.ubuntu.com/ubuntu jammy main\n'
                'Types: deb deb-src\nURIs: http://archive.ubuntu.com/ubuntu http://security.ubuntu.com/ubuntu\nSuites: jammy-updates\nComponents: main universe\nSigned-By: /keyring\n')
        expected = text.replace('] http://', '] https://').replace('URIs: http://', 'URIs: https://').replace('ubuntu http://security', 'ubuntu https://security')
        self.assertEqual(sources.convert(text), expected)
        self.assertEqual(sources.convert(expected), expected)

    def test_untrusted_and_malformed_are_unchanged(self):
        for uri in ('http://evil.example/ubuntu', 'http://archive.ubuntu.com.evil/ubuntu',
                    'http://user@archive.ubuntu.com/ubuntu', 'http://archive.ubuntu.com:80/ubuntu',
                    'http://archive.ubuntu.com/ubuntu?x=1', 'http:///ubuntu',
                    'ftp://archive.ubuntu.com/ubuntu'):
            text = f'deb {uri} jammy main\nURIs: {uri}\n'
            self.assertEqual(sources.convert(text), text)

    def test_custody_refuses_symlinks_and_arbitrary_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'outside').write_text('deb http://archive.ubuntu.com/ubuntu jammy main\n')
            (root / 'sources.list').symlink_to(root / 'outside')
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaises(OSError): sources.update_file(fd, 'sources.list')
                with self.assertRaises(ValueError): sources.update_file(fd, '../outside')
                self.assertIn('http://', (root / 'outside').read_text())
            finally:
                os.close(fd)

    def test_regular_file_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'sources.list'
            path.write_text('deb http://archive.ubuntu.com/ubuntu jammy main\n')
            fd = os.open(tmp, os.O_RDONLY | os.O_DIRECTORY)
            try: sources.update_file(fd, 'sources.list')
            finally: os.close(fd)
            self.assertEqual(path.read_text(), 'deb https://archive.ubuntu.com/ubuntu jammy main\n')

    def test_group_or_world_writable_file_or_directory_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / 'sources.list'
            original = 'deb http://archive.ubuntu.com/ubuntu jammy main\n'
            path.write_text(original)
            for mode in (0o664, 0o646):
                path.chmod(mode)
                fd = sources.owned_directory(tmp)
                try:
                    with self.assertRaises(ValueError): sources.update_file(fd, 'sources.list')
                finally: os.close(fd)
                self.assertEqual(path.read_text(), original)
            path.chmod(0o644)
            for mode in (0o770, 0o702):
                root.chmod(mode)
                with self.assertRaises(ValueError): sources.owned_directory(tmp)
                fd = os.open(tmp, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    with self.assertRaises(ValueError): sources.update_file(fd, 'sources.list')
                finally: os.close(fd)
                self.assertEqual(path.read_text(), original)
            root.chmod(0o700)

    def test_symlink_parent_and_hardlinked_source_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            real = root / 'real'; real.mkdir()
            (root / 'linked-parent').symlink_to(real, target_is_directory=True)
            parent = sources.owned_directory(tmp)
            try:
                with self.assertRaises(OSError): sources.owned_directory('linked-parent', parent)
            finally: os.close(parent)
            path = real / 'sources.list'; path.write_text('deb http://archive.ubuntu.com/ubuntu jammy main\n')
            os.link(path, real / 'alias')
            fd = sources.owned_directory(real)
            try:
                with self.assertRaises(ValueError): sources.update_file(fd, 'sources.list')
            finally: os.close(fd)
            self.assertIn('http://', path.read_text())

    def test_bounded_read_and_changed_identity_stop_before_inplace_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'sources.list'
            original = 'deb http://archive.ubuntu.com/ubuntu jammy main\n'
            path.write_text(original)
            fd = sources.owned_directory(tmp)
            try:
                with patch.object(sources.os, 'read', return_value=b'x' * (sources.MAX_BYTES + 1)) as read:
                    with self.assertRaises(ValueError): sources.update_file(fd, 'sources.list')
                    read.assert_called_once_with(unittest.mock.ANY, sources.MAX_BYTES + 1)
                self.assertEqual(path.read_text(), original)
                convert = sources.convert
                def changed(text):
                    path.write_text(original + '# changed concurrently\n')
                    return convert(text)
                with patch.object(sources, 'convert', side_effect=changed):
                    with self.assertRaises(ValueError): sources.update_file(fd, 'sources.list')
                self.assertEqual(path.read_text(), original + '# changed concurrently\n')
            finally: os.close(fd)


if __name__ == '__main__':
    unittest.main()
