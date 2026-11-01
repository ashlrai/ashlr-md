#!/usr/bin/env python3
"""Stage four Tauri updater assets locally; never publishes a release."""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import resource
import shutil
import struct
import subprocess
import tarfile
import tempfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LEGS = {"darwin-aarch64": "bundle-macos-15", "darwin-x86_64": "bundle-macos-15-intel", "linux-x86_64": "bundle-ubuntu-22.04", "windows-x86_64": "bundle-windows-latest"}


def fail(message):
    raise ValueError(message)


def one(items, label):
    if len(items) != 1:
        fail(f"expected exactly one {label}, found {len(items)}")
    return items[0]


def regular(path):
    if path.is_symlink() or not path.is_file():
        fail(f"not a regular, non-symlink file: {path}")
    return path


def machine(data, target):
    if target == "linux-x86_64":
        return len(data) >= 20 and data[:6] == b'\x7fELF\x02\x01' and data[18:20] == b'\x3e\x00'
    if target.startswith("darwin-"):
        expected = 0x0100000c if target.endswith("aarch64") else 0x01000007
        return len(data) >= 8 and data[:4] == b'\xcf\xfa\xed\xfe' and struct.unpack('<I', data[4:8])[0] == expected
    return False


def verify_platform(path, target, version):
    if target.startswith('darwin-'):
        with tarfile.open(path, 'r:gz') as archive:
            members = []
            for member in archive:
                members.append(member)
                if len(members) > 100000: fail("too many archive members")
            info = one([m for m in members if m.isfile() and m.name.endswith('.app/Contents/Info.plist')], 'macOS Info.plist')
            if info.size > 1024 * 1024: fail('Info.plist too large')
            plist = plistlib.load(archive.extractfile(info))
            if plist.get('CFBundleShortVersionString') != version: fail('macOS bundle version mismatch')
            executable = plist.get('CFBundleExecutable')
            if not isinstance(executable, str) or '/' in executable or executable in ('', '.', '..'): fail('invalid CFBundleExecutable')
            binary_name = info.name[:-len('Info.plist')] + 'MacOS/' + executable
            binary = one([m for m in members if m.isfile() and m.name == binary_name], 'macOS executable')
            if not machine(archive.extractfile(binary).read(20), target): fail('macOS architecture mismatch or unsupported universal binary')
    elif target == 'linux-x86_64':
        with path.open('rb') as f:
            if not machine(f.read(20), target): fail('Linux AppImage runtime architecture mismatch')
        verify_linux_payload(path)
    else:
        verify_windows_payload(path, version)


def bounded_7zz(tool, args, limit):
    # The signed input remains untrusted archive data: bound output and runtime.
    # Stream to an unnamed file, never extract archive-provided paths to disk.
    with tempfile.TemporaryFile() as out:
        def limits():
            resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))
        subprocess.run([str(tool), *args], stdout=out, stderr=subprocess.DEVNULL,
                       check=True, timeout=60, preexec_fn=limits)
        if out.tell() > limit: fail('7-Zip output exceeds limit')
        out.seek(0)
        return out.read()


def verify_linux_payload(path):
    tool = Path(os.environ.get('ASHLR_MD_7ZZ', ''))
    if not tool.is_file() or digest(tool) != 'd32657a7a0e4cdc0a8aa57cafe474746944d76e861e753e9c902b9c9356fa886':
        fail('set ASHLR_MD_7ZZ to the verified official Linux x64 7zz 26.05 binary')
    listing = bounded_7zz(tool, ['l', '-slt', '-ba', '-sccUTF-8', str(path)], 16 * 1024 * 1024).decode('utf-8')
    entries = []
    for block in listing.strip().split('\n\n'):
        fields = dict(line.split(' = ', 1) for line in block.splitlines() if ' = ' in line)
        if 'Path' not in fields: continue
        name = fields['Path'].replace('\\', '/')
        if name.startswith('/') or re.match(r'^[A-Za-z]:', name) or any(x in ('', '.', '..') for x in name.split('/')):
            fail('unsafe AppImage archive path')
        entries.append(fields)
    selected = one([x for x in entries if x['Path'] == 'usr/bin/md-opener'], 'Linux app payload')
    if not selected.get('Mode', '').startswith('-'): fail('Linux app payload is not a regular file')
    try: size = int(selected['Size'])
    except (KeyError, ValueError): fail('missing Linux payload size')
    if not 0 < size <= 128 * 1024 * 1024: fail('Linux payload size exceeds limit')
    payload = bounded_7zz(tool, ['e', '-so', '-bd', str(path), '--', 'usr/bin/md-opener'], size)
    if len(payload) != size: fail('Linux payload size mismatch')
    if not machine(payload[:20], 'linux-x86_64'): fail('Linux app payload architecture mismatch')
    # Version is not inferred from ELF/desktop metadata: source-bound CI
    # provenance is verified separately before any artifact is inspected.


def verify_windows_payload(path, version):
    tool = Path(os.environ.get('ASHLR_MD_7ZZ', ''))
    if not tool.is_file() or digest(tool) != 'd32657a7a0e4cdc0a8aa57cafe474746944d76e861e753e9c902b9c9356fa886':
        fail('set ASHLR_MD_7ZZ to the verified official Linux x64 7zz 26.05 binary')
    listing = bounded_7zz(tool, ['l', '-slt', '-ba', '-sccUTF-8', str(path)], 16 * 1024 * 1024).decode('utf-8')
    entries = []
    for block in listing.strip().split('\n\n'):
        fields = dict(line.split(' = ', 1) for line in block.splitlines() if ' = ' in line)
        if 'Path' not in fields: continue
        name = fields['Path'].replace('\\', '/')
        if name.startswith('/') or re.match(r'^[A-Za-z]:', name) or any(x in ('', '.', '..') for x in name.split('/')):
            fail('unsafe NSIS archive path')
        entries.append(fields)
    selected = one([x for x in entries if x['Path'] == 'md-opener.exe'], 'Windows app payload')
    if 'Symbolic Link' in selected or 'Hard Link' in selected: fail('Windows payload may not be a link')
    try: size = int(selected['Size'])
    except (KeyError, ValueError): fail('missing Windows payload size')
    if not 0 < size <= 128 * 1024 * 1024: fail('Windows payload size exceeds limit')
    payload = bounded_7zz(tool, ['e', '-so', '-bd', str(path), '--', 'md-opener.exe'], size)
    if len(payload) != size: fail('Windows payload size mismatch')
    try: import pefile
    except ImportError: fail('install pinned pefile dependency; see release runbook')
    try:
        if pefile.__version__ != '2024.8.26': fail('pefile version must be 2024.8.26')
        pe = pefile.PE(data=payload, fast_load=False)
        if pe.FILE_HEADER.Machine != 0x8664 or pe.OPTIONAL_HEADER.Magic != 0x20b: fail('Windows app payload architecture mismatch')
        fixed = one(pe.VS_FIXEDFILEINFO, 'Windows fixed version resource')
        if fixed.Signature != 0xFEEF04BD: fail('invalid Windows fixed version resource')
        parts = [fixed.FileVersionMS >> 16, fixed.FileVersionMS & 65535, fixed.FileVersionLS >> 16, fixed.FileVersionLS & 65535]
        product = [fixed.ProductVersionMS >> 16, fixed.ProductVersionMS & 65535, fixed.ProductVersionLS >> 16, fixed.ProductVersionLS & 65535]
        if len(version.split('.')) != 3 or parts != [*map(int, version.split('.')), 0] or product != parts: fail('Windows payload version mismatch or unsupported prerelease')
    except pefile.PEFormatError as error: fail(f'invalid Windows app payload: {error}')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()


def inventory(root, target, version):
    leg = root / LEGS[target]
    if not leg.is_dir() or leg.is_symlink(): fail(f'missing leg: {leg}')
    files = [p for p in leg.rglob('*') if p.name.endswith(('.app.tar.gz', '.AppImage', '-setup.exe'))]
    item = regular(one(files, target + ' updater asset'))
    if target == 'linux-x86_64' and item.name != f'Ashlr MD_{version}_amd64.AppImage': fail(f'wrong Linux version or name: {item.name}')
    if target == 'windows-x86_64' and item.name != f'Ashlr MD_{version}_x64-setup.exe': fail(f'wrong Windows version or name: {item.name}')
    sig = regular(item.with_name(item.name + '.sig'))
    if item.stat().st_size > 1024**3 or sig.stat().st_size > 65536: fail('artifact or signature exceeds size limit')
    # No duplicate detached signature under the leg, even if its payload is missing.
    candidates = [p for p in leg.rglob('*') if p.name.endswith(('.app.tar.gz.sig', '.AppImage.sig', '-setup.exe.sig'))]
    one(candidates, target + ' signature')
    # Payload inspection runs only after the staged copy's updater signature.
    return item, sig


def assemble(root, output, date, version, pubkey, evidence):
    # Internal assembly operates on verified, privately extracted artifacts.
    # The command-line entry point obtains evidence only from live GitHub.
    if not re.fullmatch(r'\d+\.\d+\.\d+', version): fail('only stable source versions supported')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', date): fail('pub_date must be UTC YYYY-MM-DDTHH:MM:SSZ')
    try: dt.datetime.strptime(date, '%Y-%m-%dT%H:%M:%SZ')
    except ValueError: fail('pub_date must be UTC YYYY-MM-DDTHH:MM:SSZ')
    if output.exists(): fail('output already exists')
    pairs = {target: inventory(root, target, version) for target in LEGS}
    with tempfile.TemporaryDirectory(prefix='md-assembly-', dir=output.parent) as tmp:
        stage = Path(tmp)
        keyfile = stage / '.public-key'
        keyfile.write_text(pubkey)
        subprocess.run(['cargo', 'build', '--locked', '--manifest-path', str(ROOT / 'scripts/release-signature-check/Cargo.toml')], check=True)
        # Cargo's target dir may be supplied by the operator; use cargo metadata
        # rather than guessing its location.
        metadata = json.loads(subprocess.check_output(['cargo', 'metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', str(ROOT / 'scripts/release-signature-check/Cargo.toml')]))
        verifier = Path(metadata['target_directory']) / 'debug' / ('release-signature-check.exe' if os.name == 'nt' else 'release-signature-check')
        platforms = {}
        selected = {}
        for target, (item, sig) in pairs.items():
            suffix = {'darwin-aarch64':'aarch64.app.tar.gz', 'darwin-x86_64':'x64.app.tar.gz', 'linux-x86_64':'amd64.AppImage', 'windows-x86_64':'x64-setup.exe'}[target]
            name = f'Ashlr_MD_{version}_{suffix}'
            for source, dest in ((item, stage / name), (sig, stage / (name + '.sig'))):
                shutil.copyfile(source, dest)
                if digest(source) != digest(dest): fail(f'copy changed bytes: {source}')
            staged_item = stage / name
            staged_sig = stage / (name + '.sig')
            subprocess.run([str(verifier), str(keyfile), str(staged_sig), str(staged_item)], check=True)
            verify_platform(staged_item, target, version)
            selected[target] = {'source_entry': str(item.relative_to(root / LEGS[target])), 'asset_sha256': digest(staged_item), 'signature_entry': str(sig.relative_to(root / LEGS[target])), 'signature_sha256': digest(staged_sig)}
            platforms[target] = {'signature': staged_sig.read_text(), 'url': f'https://github.com/ashlrai/ashlr-md/releases/download/v{version}/{name}'}
        keyfile.unlink()
        (stage / 'latest.json').write_text(json.dumps({'version': version, 'pub_date': date, 'platforms': platforms}, indent=2) + '\n')
        report = {k: v for k, v in evidence.items() if k != 'public_key'}
        report['selected_assets'] = selected
        (stage / 'provenance.json').write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
        os.rename(stage, output)


def load_local(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('zip_directory', type=Path, help='directory with the four original bundle-<runner>.zip files')
    p.add_argument('output', type=Path, help='new output directory; parent must exist')
    p.add_argument('--tag', required=True, help='reviewed stable release tag vX.Y.Z')
    p.add_argument('--source-sha', required=True, help='reviewed full commit SHA, must match peeled tag and live run')
    p.add_argument('--run-id', type=int, required=True, help='successful release workflow run ID, attempt 1 only')
    p.add_argument('--pub-date', required=True, help='explicit UTC timestamp, YYYY-MM-DDTHH:MM:SSZ')
    args = p.parse_args()
    try:
        if args.output.exists() or args.output.is_symlink(): fail('output already exists')
        provenance = load_local('release-provenance')
        archives = load_local('release-archive')
        zips = {name: args.zip_directory / (name + '.zip') for name in provenance.LEGS}
        # The API adapter is fixed in code; callers cannot supply a receipt.
        evidence = provenance.verify_provenance(provenance.fetch, args.tag, args.source_sha, args.run_id, zips)
        with tempfile.TemporaryDirectory(prefix='md-verified-inventory-', dir=args.output.parent) as tmp:
            root = Path(tmp)
            for name in provenance.LEGS:
                archives.unpack_verified(zips[name], evidence['artifacts'][name]['digest'], root / name)
            staging = root / 'staged-release'
            assemble(root, staging, args.pub_date, evidence['version'], evidence['public_key'], evidence)
            # Recheck mutable tag immediately before exposing any output.
            current = provenance.fetch(f'{provenance.REPO}/git/ref/tags/{args.tag}')
            if current.get('object') != evidence['tag_object']: fail('tag changed before staging completed')
            run = provenance.fetch(f'{provenance.REPO}/actions/runs/{args.run_id}')
            if (run.get('id') != args.run_id or run.get('run_attempt') != 1 or run.get('workflow_id') != evidence['release_workflow_id'] or run.get('head_sha') != args.source_sha or (run.get('status'), run.get('conclusion')) != ('completed', 'success')): fail('release run changed before staging completed')
            if args.output.exists() or args.output.is_symlink(): fail('output already exists')
            os.rename(staging, args.output)
    except (ValueError, OSError, KeyError, struct.error, tarfile.TarError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        p.exit(1, f'assembly failed: {error}\n')
    print(f'Local updater assets staged in {args.output}; not published.')

if __name__ == '__main__': main()
