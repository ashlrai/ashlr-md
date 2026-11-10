#!/usr/bin/env python3
"""Publish one verified assembly to its existing Git tag. Never moves the tag.

The script that runs is the one in the default-branch workflow checkout.
Downloaded artifacts are data: this process does not execute them.
"""
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
REPO_NAME = 'ashlrai/ashlr-md'
UPDATERS = {
    'darwin-aarch64': 'aarch64.app.tar.gz',
    'darwin-x86_64': 'x64.app.tar.gz',
    'linux-x86_64': 'amd64.AppImage',
    'windows-x86_64': 'x64-setup.exe',
}
# Bundler basename -> publish basename. Updater payloads are already renamed
# in staging; these are the other installers from the original artifact ZIPs.
INSTALLERS = (
    ('bundle-macos-15', 'Ashlr MD_{version}_aarch64.dmg', 'aarch64.dmg'),
    ('bundle-macos-15-intel', 'Ashlr MD_{version}_x64.dmg', 'x64.dmg'),
    ('bundle-ubuntu-22.04', 'Ashlr MD_{version}_amd64.deb', 'amd64.deb'),
    ('bundle-ubuntu-22.04', 'Ashlr MD-{version}-1.x86_64.rpm', 'x86_64.rpm'),
    ('bundle-windows-latest', 'Ashlr MD_{version}_x64_en-US.msi', 'x64_en-US.msi'),
)
ZIP_NAMES = (
    'bundle-macos-15',
    'bundle-macos-15-intel',
    'bundle-ubuntu-22.04',
    'bundle-windows-latest',
    'release-binding',
)


def load_module(filename):
    spec = importlib.util.spec_from_file_location(
        filename.replace('-', '_'),
        ROOT / 'scripts' / f'{filename}.py',
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


provenance = load_module('release-provenance')
archives = load_module('release-archive')


def fail(message):
    raise ValueError(message)


def require_tag(value):
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', value or ''):
        fail('tag is not a stable vX.Y.Z tag')
    return value


def require_version(value):
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value or ''):
        fail('only stable X.Y.Z versions can be published')
    return value


def require_sha(value):
    if not re.fullmatch(r'[0-9a-f]{40}', value or ''):
        fail('sha is not a full commit')
    return value


def require_id(value):
    if type(value) is not int or value < 1 or value > 10**15:
        fail('id is not a positive integer')
    return value


def digest(path):
    hasher = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def within(path, root):
    try:
        Path(path).resolve().relative_to(Path(root).resolve())
    except ValueError:
        return False
    return True


def data_root():
    root = Path.cwd().resolve() / 'publish-data'
    if root.is_symlink() or not root.is_dir() or not within(root, Path.cwd()):
        fail('publish-data is not a directory in the checkout')
    return root


def child_file(directory, name):
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,180}', name or ''):
        fail('unsafe file name')
    directory = Path(directory)
    path = directory / name
    if path.is_symlink() or not path.is_file() or path.resolve().parent != directory.resolve():
        fail(f'not a regular file: {name}')
    if not within(path, directory):
        fail(f'not a regular file: {name}')
    return path


def asset_name(version, suffix):
    version = require_version(version)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', suffix or ''):
        fail('unsafe asset suffix')
    return f'Ashlr_MD_{version}_{suffix}'


def allowed_asset(tag, name):
    if name == 'latest.json':
        return True
    prefix = f'Ashlr_MD_{require_tag(tag)[1:]}_'
    if not name.startswith(prefix):
        return False
    return re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name[len(prefix):]) is not None


def changelog_notes(text, version):
    marker = f'## [{require_version(version)}]'
    start = text.find(marker)
    if start < 0:
        fail('changelog has no section for this version')
    rest = text[start:]
    nxt = rest.find('\n## [', len(marker))
    notes = (rest if nxt < 0 else rest[:nxt]).strip()
    if marker not in notes:
        fail('changelog section is empty')
    return notes + '\n'


def latest_manifest(version, date, signatures):
    version = require_version(version)
    tag = f'v{version}'
    platforms = {}
    for target, suffix in UPDATERS.items():
        name = asset_name(version, suffix)
        signature = signatures[target]
        if not isinstance(signature, str) or not signature.strip():
            fail(f'missing signature text for {target}')
        platforms[target] = {
            'signature': signature,
            'url': f'https://github.com/{REPO_NAME}/releases/download/{tag}/{name}',
        }
    return {'version': version, 'pub_date': date, 'platforms': platforms}


def verify_staging(staging, pubkey, version, tag, sha, verifier):
    version, tag, sha = require_version(version), require_tag(tag), require_sha(sha)
    if tag != f'v{version}':
        fail('staging provenance tag/sha/version disagree')
    record = json.loads(child_file(staging, 'provenance.json').read_text(encoding='utf-8'))
    if (not isinstance(record, dict) or record.get('version') != version
            or record.get('tag') != tag or record.get('sha') != sha):
        fail('staging provenance tag/sha/version disagree')
    staged = json.loads(child_file(staging, 'latest.json').read_text(encoding='utf-8'))
    date = staged.get('pub_date') if isinstance(staged, dict) else None
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', date or ''):
        fail('staged latest.json has no UTC pub_date')
    selected = record.get('selected_assets') or {}
    signatures = {}
    files = []
    for target, suffix in UPDATERS.items():
        name = asset_name(version, suffix)
        payload = child_file(staging, name)
        sig = child_file(staging, name + '.sig')
        recorded = selected.get(target) or {}
        if digest(payload) != recorded.get('asset_sha256') or digest(sig) != recorded.get('signature_sha256'):
            fail(f'staged {name} does not match provenance hashes')
        verifier(pubkey, sig, payload)
        text = sig.read_text(encoding='utf-8')
        if not text.strip():
            fail(f'missing signature text for {target}')
        signatures[target] = text
        files.extend((payload, sig))
    manifest = latest_manifest(version, date, signatures)
    if staged != manifest:
        fail('staged latest.json does not match the verified signatures')
    written = child_file(staging, 'latest.json')
    written.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    if json.loads(written.read_text(encoding='utf-8')) != manifest:
        fail('rewritten latest.json does not parse')
    files.append(written)
    return {'version': version, 'tag': tag, 'sha': sha, 'files': files}


def rename_installers(unpacked, version, destination):
    version = require_version(version)
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        fail('rename destination already exists')
    destination.mkdir(mode=0o700)
    renamed = []
    for leg, source_template, suffix in INSTALLERS:
        source_name = source_template.format(version=version)
        if '/' in source_name or '\\' in source_name or '..' in source_name:
            fail('unsafe installer name')
        publish_name = asset_name(version, suffix)
        root = Path(unpacked[leg]).resolve()
        matches = []
        for path in root.rglob(source_name):
            if path.is_symlink() or not path.is_file() or path.name != source_name or not within(path, root):
                continue
            matches.append(path)
        if len(matches) != 1:
            fail(f'expected exactly one {source_name}, found {len(matches)}')
        source = matches[0]
        target = destination / publish_name
        if target.exists():
            fail('installer name collision')
        target.write_bytes(source.read_bytes())
        if digest(source) != digest(target):
            fail(f'rename changed bytes: {source_name}')
        renamed.append(target)
    return renamed


def assert_release_absent(api, tag):
    """Refuse when any GitHub Release, draft or published, already exists."""
    tag = require_tag(tag)
    try:
        existing = api(f'{provenance.REPO}/releases/tags/{tag}')
    except FileNotFoundError:
        return
    if existing is not None:
        fail('a GitHub Release already exists for this tag')


def prove(api, tag, sha, run_id, zips, binding_zip):
    """Reuse the annotated peel, release-binding, and replay gate."""
    tag, sha = require_tag(tag), require_sha(sha)
    report = provenance.verify_provenance(api, tag, sha, require_id(run_id), zips, binding_zip)
    if report.get('tag') != tag or report.get('sha') != sha or report.get('version') != tag[1:]:
        fail('peeled tag does not match the release binding')
    assert_release_absent(api, tag)
    if provenance.peel_annotated_tag(api, tag)[0] != sha:
        fail('tag moved during publish')
    return report


def publish_release(api, write, tag, sha, notes, files, upload):
    """Create a draft for this existing tag, upload, then publish.

    A release that already exists is left untouched. The tag is peeled before
    and after every mutation and is never updated. An incomplete draft this
    call created is deleted so a later attempt is not wedged.
    """
    tag, sha = require_tag(tag), require_sha(sha)
    assert_release_absent(api, tag)
    if provenance.peel_annotated_tag(api, tag)[0] != sha:
        fail('tag moved during publish')
    created = None
    try:
        # The tag already exists and was peeled to sha above. target_commitish
        # asks the Releases API to create or update that git ref. The Actions
        # token is then refused with HTTP 403 even though it has contents: write.
        release = write('POST', '/repos/ashlrai/ashlr-md/releases', {
            'tag_name': tag,
            'name': f'Ashlr MD {tag[1:]}',
            'body': notes,
            'draft': True,
            'prerelease': False,
            'generate_release_notes': False,
            # A draft cannot be latest. The API defaults this to true and
            # rejects the create. The value is the string enum, not a boolean.
            'make_latest': 'false',
        })
        if release.get('tag_name') != tag or release.get('draft') is not True:
            fail('GitHub did not create a draft for the existing tag')
        if provenance.peel_annotated_tag(api, tag)[0] != sha:
            fail('tag moved during publish')
        created = require_id(release.get('id'))
        for path in files:
            upload(tag, path)
        if provenance.peel_annotated_tag(api, tag)[0] != sha:
            fail('tag moved during publish')
        published = write('PATCH', f'/repos/ashlrai/ashlr-md/releases/{created}', {
            'draft': False,
            'make_latest': 'true',
        })
        if published.get('draft') is not False or published.get('tag_name') != tag:
            fail('GitHub did not publish the draft')
        created = None
        if provenance.peel_annotated_tag(api, tag)[0] != sha:
            fail('tag moved during publish')
        return published
    except Exception:
        if created is not None:
            try:
                write('DELETE', f'/repos/ashlrai/ashlr-md/releases/{created}', None)
            except Exception:
                # The original failure still propagates. A leftover draft is refused later.
                pass
        raise


def gh_get(path):
    if (not isinstance(path, str) or not path.startswith(f'{provenance.REPO}/')
            or '\n' in path or '..' in path):
        fail('refusing an API path outside this repository')
    completed = subprocess.run(
        ['gh', 'api', '--method', 'GET', path],
        check=False, capture_output=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode('utf-8', 'replace')
        if '404' in detail or 'Not Found' in detail:
            raise FileNotFoundError(path)
        fail('GitHub API read failed')
    if len(completed.stdout) > 16 * 1024 * 1024:
        fail('API response too large')
    if not completed.stdout:
        return {}
    return json.loads(completed.stdout)


TOKEN_SHAPE = re.compile(
    r'(?:ghp_|ghr_|github_pat_|gho_|ghu_|ghs_)[A-Za-z0-9_]+|Bearer\s+\S+',
)


def scrub_secret(text):
    redacted = text
    for key in ('GH_TOKEN', 'GITHUB_TOKEN'):
        value = os.environ.get(key) or ''
        if len(value) >= 8:
            redacted = redacted.replace(value, '[redacted]')
    return TOKEN_SHAPE.sub('[redacted]', redacted)


def github_write_error(method, path, completed):
    chunks = []
    for raw in (completed.stdout, completed.stderr):
        if raw:
            chunks.append(raw.decode('utf-8', 'replace'))
    text = scrub_secret('\n'.join(chunks))
    status = 'unknown'
    found = re.search(r'\bHTTP\s+(\d{3})\b', text) or re.search(r'"status"\s*:\s*"?(\d{3})"?', text)
    if found:
        status = found.group(1)
    message = ''
    for raw in (completed.stdout, completed.stderr):
        try:
            payload = json.loads(raw.decode('utf-8') if raw else '')
        except (json.JSONDecodeError, UnicodeError, AttributeError):
            continue
        if not isinstance(payload, dict) or not payload.get('message'):
            continue
        message = str(payload['message']).split('\n', 1)[0]
        details = []
        for item in payload.get('errors') or []:
            if isinstance(item, dict) and item.get('message'):
                details.append(str(item['message']))
        if details:
            message = message + ': ' + '; '.join(details[:3])
        break
    message = scrub_secret(message)[:300]
    detail = f'GitHub API {method} {path} failed: HTTP {status}'
    if message:
        detail = f'{detail}: {message}'
    fail(detail)


def gh_write(method, path, body=None):
    if method not in ('POST', 'PATCH', 'DELETE'):
        fail('unsupported API method')
    if not re.fullmatch(r'/repos/ashlrai/ashlr-md/releases(?:/[1-9][0-9]{0,18})?', path):
        fail('refusing an API write outside releases')
    if '/git/' in path:
        fail('refusing to mutate a git object')
    command = ['gh', 'api', '--method', method, path]
    payload = None
    if body is not None:
        command.extend(['--input', '-'])
        payload = json.dumps(body).encode()
    completed = subprocess.run(command, input=payload, check=False, capture_output=True)
    if completed.returncode != 0:
        github_write_error(method, path, completed)
    if not completed.stdout:
        return {}
    return json.loads(completed.stdout)


def upload_asset(tag, path):
    tag = require_tag(tag)
    path = Path(path)
    root = data_root()
    if path.is_symlink() or not path.is_file() or not within(path, root) or not allowed_asset(tag, path.name):
        fail('refusing to upload an unexpected file')
    completed = subprocess.run(
        ['gh', 'release', 'upload', '--repo', REPO_NAME, tag, str(path.resolve())],
        check=False, capture_output=True,
    )
    if completed.returncode != 0:
        fail('asset upload failed')


def download_zip(artifact_id, dest):
    artifact_id = require_id(artifact_id)
    dest = Path(dest)
    if dest.exists() or dest.is_symlink():
        fail('download destination already exists')
    endpoint = f'/repos/ashlrai/ashlr-md/actions/artifacts/{artifact_id}/zip'
    with dest.open('xb') as out:
        completed = subprocess.run(
            ['gh', 'api', '--method', 'GET', endpoint],
            stdout=out, stderr=subprocess.PIPE, check=False,
        )
    if completed.returncode != 0:
        dest.unlink(missing_ok=True)
        fail('artifact download failed')


def cache_artifacts(api, run_id, root):
    artifacts = provenance.pages(
        api, f'{provenance.REPO}/actions/runs/{require_id(run_id)}/artifacts', 'artifacts')
    chosen = {}
    for name in ZIP_NAMES:
        rows = [item for item in artifacts if item.get('name') == name]
        if len(rows) != 1:
            fail(f'missing {name}')
        chosen[name] = rows[0]
    zips_dir = root / 'zips'
    if zips_dir.exists() or zips_dir.is_symlink():
        fail('zip directory already exists')
    zips_dir.mkdir(mode=0o700)
    paths = {}
    for name in ZIP_NAMES:
        dest = zips_dir / f'{name}.zip'
        download_zip(require_id(chosen[name].get('id')), dest)
        paths[name] = dest
    return {leg: paths[leg] for leg in provenance.LEGS}, paths['release-binding']


def read_staging(root):
    payload = json.loads(child_file(root / 'staging', 'provenance.json').read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        fail('staging provenance is not a record')
    tag = require_tag(payload.get('tag'))
    sha = require_sha(payload.get('sha'))
    run_id = payload.get('release_run')
    if payload.get('version') != tag[1:] or type(run_id) is not int or run_id < 1:
        fail('staging provenance tag/sha/version disagree')
    return tag, sha, run_id


def require_assemble_success(api, run_id):
    run_id = require_id(run_id)
    run = api(f'{provenance.REPO}/actions/runs/{run_id}')
    repository = (run.get('repository') or {}).get('full_name')
    head_repository = (run.get('head_repository') or {}).get('full_name')
    if (run.get('path') != '.github/workflows/release-assemble.yml'
            or run.get('event') != 'workflow_dispatch'
            or run.get('head_branch') != 'main'
            or run.get('run_attempt') != 1
            or (run.get('status'), run.get('conclusion')) != ('completed', 'success')
            or repository != REPO_NAME
            or head_repository != REPO_NAME):
        fail('assembly run is not a successful main dispatch')
    jobs = provenance.pages(api, f'{provenance.REPO}/actions/runs/{run_id}/attempts/1/jobs', 'jobs')
    rows = [job for job in jobs if job.get('name') == 'assemble']
    if len(rows) != 1 or (rows[0].get('status'), rows[0].get('conclusion')) != ('completed', 'success'):
        fail('assembly job did not succeed')


def environ_run():
    raw = os.environ.get('ASSEMBLE_RUN_ID', '')
    if not re.fullmatch(r'[1-9][0-9]{0,15}', raw) or os.environ.get('ASSEMBLE_ATTEMPT') != '1':
        fail('only assembly attempt 1 can be published')
    return int(raw)


def lock_tag(tag):
    if require_tag(tag) != require_tag(os.environ.get('EXPECTED_TAG', '')):
        fail('resolved tag does not match the publish lock')
    return tag


def write_tag_output(tag):
    tag = require_tag(tag)
    output = os.environ.get('GITHUB_OUTPUT', '')
    if not output or '\n' in output or '\x00' in output:
        fail('GITHUB_OUTPUT is missing')
    path = Path(output)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail('GITHUB_OUTPUT is not a regular file')
    with path.open('a', encoding='utf-8') as handle:
        handle.write(f'tag={tag}\n')


def unpack_legs(zips, artifacts, dest):
    if dest.exists() or dest.is_symlink():
        fail('unpack destination already exists')
    dest.mkdir(mode=0o700)
    unpacked = {}
    for name, archive in zips.items():
        leg = dest / name
        archives.unpack_verified(archive, artifacts[name]['digest'], leg)
        unpacked[name] = leg
    return unpacked


def cargo_verifier():
    manifest = ROOT / 'scripts/release-signature-check/Cargo.toml'
    subprocess.run(
        ['cargo', 'build', '--locked', '--manifest-path', str(manifest)],
        check=True,
    )
    binary = ROOT / 'scripts/release-signature-check/target/debug/release-signature-check'
    if binary.is_symlink() or not binary.is_file():
        fail('signature verifier is missing')

    def verify(pubkey, signature, payload):
        with tempfile.TemporaryDirectory() as tmp:
            key = Path(tmp) / 'key'
            key.write_text(pubkey, encoding='utf-8')
            subprocess.run([str(binary), str(key), str(signature), str(payload)], check=True)

    return verify


def resolve_tag(root, api):
    require_assemble_success(api, environ_run())
    tag, sha, release_run = read_staging(root)
    zips, binding = cache_artifacts(api, release_run, root)
    report = prove(api, tag, sha, release_run, zips, binding)
    write_tag_output(report['tag'])


def publish(root, api, write, upload, verifier):
    require_assemble_success(api, environ_run())
    tag, sha, release_run = read_staging(root)
    zips, binding = cache_artifacts(api, release_run, root)
    report = prove(api, tag, sha, release_run, zips, binding)
    lock_tag(report['tag'])
    verified = verify_staging(
        root / 'staging', report['public_key'], report['version'], report['tag'], report['sha'], verifier)
    if (verified['tag'], verified['sha']) != (tag, sha):
        fail('verified staging does not match the tag check')
    notes = changelog_notes(
        provenance.source(api, 'CHANGELOG.md', sha).decode(), report['version'])
    installers = rename_installers(
        unpack_legs(zips, report['artifacts'], root / 'unpacked'),
        report['version'],
        root / 'renamed',
    )
    return publish_release(api, write, tag, sha, notes, verified['files'] + installers, upload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('resolve', 'publish'), required=True)
    args = parser.parse_args()
    if os.environ.get('GITHUB_REPOSITORY') != REPO_NAME:
        parser.exit(2, 'publication only runs for ashlrai/ashlr-md\n')
    root = data_root()
    if args.mode == 'resolve':
        resolve_tag(root, gh_get)
        return
    if args.mode == 'publish':
        if os.environ.get('PUBLISH_WORKFLOW') != '1':
            parser.exit(2, 'publication only runs from the release-publish workflow\n')
        publish(root, gh_get, gh_write, upload_asset, cargo_verifier())
        return
    parser.exit(2, 'unknown mode\n')


if __name__ == '__main__':
    main()
