#!/usr/bin/env python3
"""Publish one verified assembly to its existing Git tag. Never moves the tag."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REPO = 'ashlrai/ashlr-md'
UPDATERS = {
    'darwin-aarch64': 'aarch64.app.tar.gz',
    'darwin-x86_64': 'x64.app.tar.gz',
    'linux-x86_64': 'amd64.AppImage',
    'windows-x86_64': 'x64-setup.exe',
}
# Bundler basename -> Publish-as basename. Updater payloads are already renamed
# in staging; these are the other installers from the original artifact ZIPs.
INSTALLERS = (
    ('bundle-macos-15', 'Ashlr MD_{version}_aarch64.dmg', 'Ashlr_MD_{version}_aarch64.dmg'),
    ('bundle-macos-15-intel', 'Ashlr MD_{version}_x64.dmg', 'Ashlr_MD_{version}_x64.dmg'),
    ('bundle-ubuntu-22.04', 'Ashlr MD_{version}_amd64.deb', 'Ashlr_MD_{version}_amd64.deb'),
    ('bundle-ubuntu-22.04', 'Ashlr MD-{version}-1.x86_64.rpm', 'Ashlr_MD_{version}_x86_64.rpm'),
    ('bundle-windows-latest', 'Ashlr MD_{version}_x64_en-US.msi', 'Ashlr_MD_{version}_x64_en-US.msi'),
)


def fail(message):
    raise ValueError(message)


def digest(path):
    hasher = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def one(items, label):
    if len(items) != 1:
        fail(f'expected exactly one {label}, found {len(items)}')
    return items[0]


def regular(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        fail(f'not a regular file: {path}')
    return path


def asset_name(version, suffix):
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        fail('only stable X.Y.Z versions can be published')
    return f'Ashlr_MD_{version}_{suffix}'


def changelog_notes(text, version):
    marker = f'## [{version}]'
    start = text.find(marker)
    if start < 0:
        fail(f'changelog has no {marker} section')
    rest = text[start:]
    nxt = rest.find('\n## [', len(marker))
    section = rest if nxt < 0 else rest[:nxt]
    notes = section.strip()
    if marker not in notes:
        fail('changelog section is empty')
    return notes + '\n'


def latest_manifest(version, date, signatures):
    platforms = {}
    for target, suffix in UPDATERS.items():
        name = asset_name(version, suffix)
        signature = signatures[target]
        if not isinstance(signature, str) or not signature.strip():
            fail(f'missing signature text for {target}')
        platforms[target] = {
            'signature': signature,
            'url': f'https://github.com/{REPO}/releases/download/v{version}/{name}',
        }
    return {'version': version, 'pub_date': date, 'platforms': platforms}


def verify_staging(staging, pubkey, verifier):
    staging = Path(staging)
    provenance = json.loads(regular(staging / 'provenance.json').read_text())
    version = provenance.get('version')
    tag = provenance.get('tag')
    sha = provenance.get('sha')
    if tag != f'v{version}' or not re.fullmatch(r'[0-9a-f]{40}', sha or ''):
        fail('staging provenance tag/sha/version disagree')
    date = json.loads(regular(staging / 'latest.json').read_text()).get('pub_date')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', date or ''):
        fail('staged latest.json has no UTC pub_date')
    selected = provenance.get('selected_assets') or {}
    signatures = {}
    files = []
    for target, suffix in UPDATERS.items():
        name = asset_name(version, suffix)
        payload = regular(staging / name)
        sig = regular(staging / (name + '.sig'))
        recorded = selected.get(target) or {}
        if digest(payload) != recorded.get('asset_sha256') or digest(sig) != recorded.get('signature_sha256'):
            fail(f'staged {name} does not match provenance hashes')
        verifier(pubkey, sig, payload)
        signatures[target] = sig.read_text()
        files.extend((payload, sig))
    manifest = latest_manifest(version, date, signatures)
    staged_manifest = json.loads((staging / 'latest.json').read_text())
    if staged_manifest != manifest:
        fail('staged latest.json does not match the verified signatures')
    written = staging / 'latest.json'
    written.write_text(json.dumps(manifest, indent=2) + '\n')
    if json.loads(written.read_text()) != manifest:
        fail('rewritten latest.json does not parse')
    files.append(written)
    return {'version': version, 'tag': tag, 'sha': sha, 'date': date, 'files': files,
            'artifacts': provenance.get('artifacts') or {}}


def rename_installers(unpacked, version, destination):
    destination = Path(destination)
    destination.mkdir(mode=0o700)
    renamed = []
    for leg, source_name, publish_name in INSTALLERS:
        source_name = source_name.format(version=version)
        publish_name = publish_name.format(version=version)
        root = Path(unpacked[leg])
        matches = [path for path in root.rglob(source_name) if path.is_file() and not path.is_symlink()]
        source = one(matches, source_name)
        target = destination / publish_name
        target.write_bytes(source.read_bytes())
        if digest(source) != digest(target):
            fail(f'rename changed bytes: {source_name}')
        renamed.append(target)
    return renamed


def peel_tag(api, tag):
    ref = api('GET', f'/repos/{REPO}/git/ref/tags/{tag}')
    if ref.get('ref') != f'refs/tags/{tag}':
        fail('tag ref mismatch')
    obj = ref.get('object') or {}
    seen = set()
    for _ in range(6):
        kind, sha = obj.get('type'), obj.get('sha')
        if kind == 'commit':
            if not re.fullmatch(r'[0-9a-f]{40}', sha or ''):
                fail('tag does not peel to a commit')
            return sha
        if kind != 'tag' or sha in seen:
            fail('invalid tag object')
        seen.add(sha)
        tagged = api('GET', f'/repos/{REPO}/git/tags/{sha}')
        obj = tagged.get('object') or {}
    fail('tag chain too deep')


def assert_unchanged(api, tag, sha):
    if peel_tag(api, tag) != sha:
        fail('tag moved during publish')


def version_tuple(tag):
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag or ''):
        fail('release tag is not a stable vX.Y.Z tag')
    return tuple(int(part) for part in tag[1:].split('.'))


def bind_exact_tag(tag, sha, binding):
    """inputs.version and the prepare tag/sha must be this release, not another tag."""
    version = tag[1:] if tag.startswith('v') else None
    if (not re.fullmatch(r'v\d+\.\d+\.\d+', tag or '') or not re.fullmatch(r'[0-9a-f]{40}', sha or '')
            or not isinstance(binding, dict)
            or binding.get('inputs_version') != version or binding.get('version') != version
            or binding.get('tag') != tag or binding.get('sha') != sha):
        fail('prepare binding does not match the assembled tag')


def assert_newer_unpublished(api, tag):
    try:
        existing = api('GET', f'/repos/{REPO}/releases/tags/{tag}')
    except FileNotFoundError:
        existing = None
    if existing is not None and existing.get('draft') is not True:
        fail('tag is already published')
    try:
        latest = api('GET', f'/repos/{REPO}/releases/latest')
    except FileNotFoundError:
        return
    if version_tuple(tag) <= version_tuple(latest.get('tag_name')):
        fail('version is not strictly greater than the latest release')


def publish_github(tag, sha, notes, files, api, upload):
    """Create or reuse a draft for this exact tag, upload, then publish.

    A published release is left untouched. The tag is read before and after
    every mutation and is never updated.
    """
    assert_unchanged(api, tag, sha)
    assert_newer_unpublished(api, tag)
    try:
        existing = api('GET', f'/repos/{REPO}/releases/tags/{tag}')
    except FileNotFoundError:
        existing = None
    if existing:
        if existing.get('draft') is not True or existing.get('tag_name') != tag:
            fail('a published release already exists for this tag')
        if existing.get('target_commitish') not in (sha, tag):
            fail('existing draft does not target the tagged commit')
        release = existing
    else:
        release = api('POST', f'/repos/{REPO}/releases', {
            'tag_name': tag,
            'target_commitish': sha,
            'name': f'Ashlr MD {tag[1:]}',
            'body': notes,
            'draft': True,
            'prerelease': False,
            'generate_release_notes': False,
        })
        if release.get('tag_name') != tag or release.get('draft') is not True:
            fail('GitHub did not create a draft for the existing tag')
    assert_unchanged(api, tag, sha)
    present = {asset.get('name') for asset in release.get('assets') or []}
    for path in files:
        path = regular(path)
        if path.name in present:
            continue
        upload(tag, path)
    assert_unchanged(api, tag, sha)
    published = api('PATCH', f'/repos/{REPO}/releases/{release["id"]}', {'draft': False})
    if published.get('draft') is not False or published.get('tag_name') != tag:
        fail('GitHub did not publish the draft')
    assert_unchanged(api, tag, sha)
    return published


def gh_api(method, path, body=None):
    if not path.startswith(f'/repos/{REPO}/') or '\n' in path or '..' in path:
        fail('refusing an API path outside this repository')
    if method != 'GET' and '/git/' in path:
        fail('refusing to mutate a git object')
    command = ['gh', 'api', '--method', method, path]
    payload = None
    if body is not None:
        command.extend(['--input', '-'])
        payload = json.dumps(body).encode()
    completed = subprocess.run(command, input=payload, check=False, capture_output=True)
    if completed.returncode != 0:
        detail = completed.stderr.decode('utf-8', 'replace')
        if '404' in detail or 'Not Found' in detail:
            raise FileNotFoundError(path)
        fail(f'GitHub API {method} {path} failed')
    if not completed.stdout:
        return {}
    return json.loads(completed.stdout)


def upload_release_asset(tag, path):
    # Omitting --clobber keeps an existing asset. This command does not create a tag.
    subprocess.run(
        ['gh', 'release', 'upload', '--repo', REPO, tag, str(path)],
        check=True,
    )


def load_module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def require_assemble_job(run_id, api):
    payload = api('GET', f'/repos/{REPO}/actions/runs/{run_id}/attempts/1/jobs')
    jobs = [job for job in payload.get('jobs', []) if job.get('name') == 'assemble']
    job = one(jobs, 'assemble job')
    if (job.get('status'), job.get('conclusion')) != ('completed', 'success'):
        fail('assembly job did not succeed')
    return job


def fetch_original_zips(artifacts, destination, download, unpack):
    expected = {'bundle-macos-15', 'bundle-macos-15-intel', 'bundle-ubuntu-22.04', 'bundle-windows-latest'}
    if set(artifacts) != expected:
        fail('provenance artifact inventory is not the four platform bundles')
    unpacked = {}
    destination = Path(destination)
    for name, meta in sorted(artifacts.items()):
        digest_text = meta.get('digest')
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest_text or ''):
            fail(f'malformed digest for {name}')
        archive = destination / f'{name}.zip'
        download(meta['id'], archive)
        if 'sha256:' + digest(archive) != digest_text:
            fail(f'downloaded {name} does not match provenance digest')
        leg = destination / name
        unpack(archive, digest_text, leg)
        unpacked[name] = leg
    return unpacked


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assemble-run-id', type=int, required=True)
    parser.add_argument('--assemble-attempt', type=int, required=True)
    parser.add_argument('--staging', type=Path, required=True)
    args = parser.parse_args()
    if os.environ.get('PUBLISH_WORKFLOW') != '1' or os.environ.get('GITHUB_REPOSITORY') != REPO:
        parser.exit(2, 'publication only runs from the release-publish workflow\n')
    if args.assemble_attempt != 1 or args.assemble_run_id < 1:
        parser.exit(2, 'only assembly attempt 1 can be published\n')
    require_assemble_job(args.assemble_run_id, gh_api)
    provenance = load_module('release-provenance')
    archives = load_module('release-archive')
    record = json.loads(regular(args.staging / 'provenance.json').read_text())
    version, tag, sha = record.get('version'), record.get('tag'), record.get('sha')
    if tag != f'v{version}' or peel_tag(lambda method, path, body=None: provenance.fetch(path), tag) != sha:
        fail('staging tag does not peel to the recorded commit')
    binding_file = args.staging / 'release-binding.json'
    if not binding_file.is_file():
        subprocess.run(
            ['gh', 'run', 'download', str(record['release_run']), '--repo', REPO,
             '--name', 'release-binding', '--dir', str(args.staging)],
            check=True,
        )
    bind_exact_tag(tag, sha, json.loads(regular(binding_file).read_text()))
    config = json.loads(provenance.source(provenance.fetch, 'src-tauri/tauri.conf.json', sha))
    pubkey = config['plugins']['updater']['pubkey']
    notes = changelog_notes(provenance.source(provenance.fetch, 'CHANGELOG.md', sha).decode(), version)
    verified = verify_staging(args.staging, pubkey, _cargo_verifier())
    if (verified['tag'], verified['sha']) != (tag, sha):
        fail('verified staging does not match the tag check')

    def download(artifact_id, archive):
        if type(artifact_id) is not int or artifact_id < 1:
            fail('artifact id is not a positive integer')
        archive.parent.mkdir(parents=True, exist_ok=True)
        with archive.open('xb') as out:
            subprocess.run(
                ['gh', 'api', f'/repos/{REPO}/actions/artifacts/{artifact_id}/zip'],
                stdout=out, check=True,
            )

    with tempfile.TemporaryDirectory(prefix='md-publish-') as tmp:
        unpacked = fetch_original_zips(verified['artifacts'], Path(tmp), download, archives.unpack_verified)
        installers = rename_installers(unpacked, version, Path(tmp) / 'renamed')
        publish_github(tag, sha, notes, verified['files'] + installers, gh_api, upload_release_asset)


def _cargo_verifier():
    manifest = ROOT / 'scripts/release-signature-check/Cargo.toml'
    subprocess.run(['cargo', 'build', '--locked', '--manifest-path', str(manifest)], check=True)
    binary = ROOT / 'scripts/release-signature-check/target/debug/release-signature-check'

    def verify(pubkey, signature, payload):
        with tempfile.TemporaryDirectory() as tmp:
            key = Path(tmp) / 'key'
            key.write_text(pubkey)
            subprocess.run([str(binary), str(key), str(signature), str(payload)], check=True)

    return verify


if __name__ == '__main__':
    main()
