#!/usr/bin/env python3
"""Read-only, live GitHub binding for a manually assembled release."""
import base64
import hashlib
import json
from pathlib import Path
import re
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = '/repos/ashlrai/ashlr-md'
REPO_ID = 1257779576
LEGS = ('bundle-macos-15', 'bundle-macos-15-intel', 'bundle-ubuntu-22.04', 'bundle-windows-latest')
SOURCE = ('.github/workflows/release.yml', '.github/workflows/ci.yml', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'package.json')
CI_STEPS = {
    'Linux full suite': ('Unit tests', 'Frontend build', 'Test release assembly validator',
                         'Install Linux system dependencies', 'Rust check (workspace)',
                         'Rust clippy (workspace, Linux)', 'Rust tests (workspace)'),
    # This role checks/clippies macOS code. It does not run macOS runtime tests.
    'macOS full suite': ('Rust check (workspace)', 'Rust clippy (workspace)'),
    'Check (Linux)': ('Require every needed job',),
    'Typecheck, lint, crypto policy': (),
    'Secret scan (diff)': (),
    'Secret-shape scan': (),
}


def fail(message): raise ValueError(message)


def fetch(path):
    # Fixed host and repository only; no token, caller-controlled URL or redirects
    # to other hosts. API responses are bounded. API denial is an error.
    if not path.startswith(REPO + '/') or '\\n' in path: fail('invalid API path')
    req = urllib.request.Request('https://api.github.com' + path, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'ashlr-md-release-audit', 'X-GitHub-Api-Version': '2022-11-28'})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs): return None
    with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as response:
        raw = response.read(16 * 1024 * 1024 + 1)
        if len(raw) > 16 * 1024 * 1024: fail('API response too large')
        return json.loads(raw)


def pages(api, path, field):
    out = []
    for page in range(1, 101):
        separator = '&' if '?' in path else '?'
        result = api(f'{path}{separator}per_page=100&page={page}')
        items = result[field]
        if not isinstance(items, list): fail('invalid API pagination')
        out.extend(items)
        if len(items) < 100:
            if result.get('total_count') != len(out): fail('incomplete or inconsistent paginated API results')
            return out
    fail('API pagination limit exceeded')


def exactly(items, label):
    if len(items) != 1: fail(f'expected exactly one {label}, found {len(items)}')
    return items[0]


def job_ok(jobs, name, run_id, sha, steps=(), attempt=None):
    j = exactly([x for x in jobs if x.get('name') == name], f'job {name}')
    if j.get('run_id') != run_id or j.get('head_sha') != sha: fail(f'job {name} run/SHA mismatch')
    if attempt is not None and (type(j.get('run_attempt')) is not int or j.get('run_attempt') != attempt): fail(f'job {name} attempt mismatch')
    if (j.get('status'), j.get('conclusion')) != ('completed', 'success'): fail(f'job {name} did not succeed')
    for step in steps:
        s = exactly([x for x in j.get('steps', []) if x.get('name') == step], f'step {name}/{step}')
        if (s.get('status'), s.get('conclusion')) != ('completed', 'success'): fail(f'step {name}/{step} did not succeed')

def workflow_revision_builds_resolved_tag(text):
    if not isinstance(text, (bytes, str)): fail('invalid workflow revision')
    body = text.decode() if isinstance(text, bytes) else text
    peel = 'sha="$(gh api "repos/${REPO}/commits/refs/tags/${tag}" --jq ' + "'.sha'" + ')"'
    required = (
        'tag="v${INPUT_VERSION}"',
        'INPUT_VERSION: ${{ inputs.version }}',
        'ref: ${{ needs.prepare.outputs.sha }}',
        peel,
        'Require version carriers to equal the tag',
        'name: release-binding',
    )
    for snippet in required:
        if snippet not in body: fail('workflow revision does not build the resolved tag')
    # The build must not check out the dispatch ref; that would compile main.
    if 'ref: ${{ github.sha }}' in body: fail('workflow revision checks out the dispatch ref')



def release_run_matches(run, tag, expected_sha, run_id, workflow_id):
    if (run.get('id') != run_id or run.get('workflow_id') != workflow_id or
            run.get('path') != '.github/workflows/release.yml' or
            run.get('run_attempt') != 1 or
            (run.get('status'), run.get('conclusion')) != ('completed', 'success') or
            run.get('repository', {}).get('id') != REPO_ID or
            run.get('head_repository', {}).get('id') != REPO_ID):
        fail('release run identity/status mismatch')
    event = run.get('event')
    head_sha, head_branch = run.get('head_sha'), run.get('head_branch')
    if event == 'push':
        if head_sha != expected_sha or head_branch != tag:
            fail('release run identity/status mismatch')
        return head_sha
    if event == 'workflow_dispatch':
        if head_branch != 'main' or not re.fullmatch(r'[0-9a-f]{40}', head_sha or ''):
            fail('release run identity/status mismatch')
        return head_sha
    fail('release run identity/status mismatch')


def release_record(api, path):
    try:
        return api(path)
    except FileNotFoundError:
        return None
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def version_tuple(tag):
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag or ''):
        fail('release tag is not a stable vX.Y.Z tag')
    return tuple(int(part) for part in tag.removeprefix('v').split('.'))


def assert_not_replay_or_downgrade(api, tag):
    """Refuse a tag that already has a published release, or a version that is
    not strictly newer than the latest published stable release."""
    existing = release_record(api, f'{REPO}/releases/tags/{tag}')
    if existing is not None and existing.get('draft') is not True:
        fail('tag is already published')
    latest = release_record(api, f'{REPO}/releases/latest')
    if latest is None:
        return
    if version_tuple(tag) <= version_tuple(latest.get('tag_name')):
        fail('version is not strictly greater than the latest release')


def read_dispatch_binding(binding_zip, expected_digest):
    path = Path(binding_zip)
    if path.is_symlink() or not path.is_file():
        fail('release binding is not a regular file')
    hasher = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            hasher.update(block)
    if 'sha256:' + hasher.hexdigest() != expected_digest:
        fail('release binding digest mismatch')
    with zipfile.ZipFile(path) as archive:
        infos = [info for info in archive.infolist() if info.filename not in ('', './')]
        if len(infos) != 1 or infos[0].is_dir() or Path(infos[0].filename).name != 'release-binding.json':
            fail('release binding archive is not the prepare output')
        if '..' in Path(infos[0].filename).parts or infos[0].filename.startswith('/') or infos[0].file_size > 4096:
            fail('release binding archive is not the prepare output')
        try:
            payload = json.loads(archive.read(infos[0]))
        except json.JSONDecodeError:
            fail('release binding is not JSON')
    if not isinstance(payload, dict):
        fail('release binding is not JSON')
    return payload


def bind_dispatch_release(api, run_id, job_head_sha, tag, expected_sha, binding_zip):
    """The prepare artifact must name this exact tag and its peeled commit.

    inputs.version, the prepare tag output and the prepare sha output are the
    only accepted description of what the dispatch built. A binding for tag A
    cannot stage tag B.
    """
    artifacts = pages(api, f'{REPO}/actions/runs/{run_id}/artifacts', 'artifacts')
    rows = [item for item in artifacts if item.get('name') == 'release-binding']
    if len(rows) != 1:
        fail('dispatch release is missing its prepare binding')
    artifact = rows[0]
    workflow = artifact.get('workflow_run') or {}
    digest = artifact.get('digest')
    if (artifact.get('expired') is not False or not isinstance(artifact.get('id'), int) or artifact['id'] < 1
            or not re.fullmatch(r'sha256:[0-9a-f]{64}', digest or '')
            or workflow.get('id') != run_id or workflow.get('head_sha') != job_head_sha
            or workflow.get('repository_id') != REPO_ID or workflow.get('head_repository_id') != REPO_ID
            or binding_zip is None):
        fail('dispatch release is missing its prepare binding')
    payload = read_dispatch_binding(binding_zip, digest)
    version = tag.removeprefix('v')
    if (payload.get('event') != 'workflow_dispatch' or payload.get('inputs_version') != version
            or payload.get('tag') != tag or payload.get('sha') != expected_sha
            or payload.get('version') != version):
        fail('prepare binding does not match the assembled tag')


def ci_run_ok(run, sha, workflow_id):
    event = run.get('event')
    return (type(run.get('id')) is int and run['id'] > 0 and
            type(run.get('run_attempt')) is int and run['run_attempt'] > 0 and
            run.get('workflow_id') == workflow_id and run.get('path') == '.github/workflows/ci.yml' and
            run.get('head_sha') == sha and
            (event == 'workflow_dispatch' or (event == 'push' and run.get('head_branch') == 'main')) and
            run.get('repository', {}).get('id') == REPO_ID and
            run.get('head_repository', {}).get('id') == REPO_ID and
            run.get('repository', {}).get('full_name') == 'ashlrai/ashlr-md' and
            run.get('head_repository', {}).get('full_name') == 'ashlrai/ashlr-md' and
            (run.get('status'), run.get('conclusion')) == ('completed', 'success'))


def same_ci_attempt(api, recorded, sha, workflow_id):
    current = api(f'{REPO}/actions/runs/{recorded["id"]}')
    keys = ('id', 'run_attempt', 'workflow_id', 'path', 'head_sha', 'head_branch', 'event')
    if not ci_run_ok(current, sha, workflow_id) or any(current.get(key) != recorded.get(key) for key in keys):
        fail('CI run identity/current attempt changed during verification')


def source(api, path, sha):
    obj = api(f'{REPO}/contents/{path}?ref={sha}')
    if obj.get('encoding') != 'base64' or obj.get('path') != path or not isinstance(obj.get('content'), str): fail(f'invalid source response {path}')
    raw = base64.b64decode(''.join(obj['content'].split()), validate=True)
    if len(raw) > 2 * 1024 * 1024: fail(f'source too large: {path}')
    # Git's legacy SHA-1 blob ID is a protocol identity check, not a
    # collision-resistant signature or an independent source of authenticity.
    blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
    if obj.get('sha') != blob or obj.get('size') != len(raw): fail(f'source blob mismatch: {path}')
    return raw


def peel_annotated_tag(api, tag):
    """Walk git/ref/tags/<tag> through annotated tag objects to the commit."""
    ref = api(f'{REPO}/git/ref/tags/{tag}')
    if ref.get('ref') != f'refs/tags/{tag}': fail('tag ref mismatch')
    obj = ref['object']
    seen = set()
    for _ in range(6):
        typ, sha = obj.get('type'), obj.get('sha')
        if typ == 'commit': break
        if typ != 'tag' or sha in seen or not re.fullmatch(r'[0-9a-f]{40}', sha or ''): fail('invalid annotated tag chain')
        seen.add(sha); tagged = api(f'{REPO}/git/tags/{sha}')
        if tagged.get('sha') != sha: fail('tag object mismatch')
        obj = tagged['object']
    else: fail('tag chain too deep')
    return sha, ref


def verify_provenance(api, tag, expected_sha, run_id, zips, binding_zip=None):
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag): fail('only stable vX.Y.Z tags supported')
    if not re.fullmatch(r'[0-9a-f]{40}', expected_sha): fail('reviewed SHA must be a full lowercase commit SHA')
    if not isinstance(run_id, int) or run_id < 1: fail('invalid run ID')
    if set(zips) != set(LEGS): fail('four original named artifact ZIPs are required')
    sha, ref = peel_annotated_tag(api, tag)
    if sha != expected_sha: fail('peeled tag does not match reviewed SHA')
    assert_not_replay_or_downgrade(api, tag)
    release_workflow = api(f'{REPO}/actions/workflows/release.yml')
    ci_workflow = api(f'{REPO}/actions/workflows/ci.yml')
    if (release_workflow.get('path') != '.github/workflows/release.yml' or ci_workflow.get('path') != '.github/workflows/ci.yml' or not isinstance(release_workflow.get('id'), int) or release_workflow['id'] < 1 or not isinstance(ci_workflow.get('id'), int) or ci_workflow['id'] < 1 or ci_workflow['id'] == release_workflow['id']): fail('workflow identity mismatch')
    run = api(f'{REPO}/actions/runs/{run_id}')
    if run.get('run_attempt') != 1: fail('unsupported release run attempt: only attempt 1 has sufficient artifact binding; later attempts require job-bound artifact evidence')
    job_head_sha = release_run_matches(run, tag, expected_sha, run_id, release_workflow.get('id'))
    jobs = pages(api, f'{REPO}/actions/runs/{run_id}/attempts/1/jobs', 'jobs')
    if run.get('event') == 'workflow_dispatch':
        workflow_revision_builds_resolved_tag(source(api, '.github/workflows/release.yml', job_head_sha))
        bind_dispatch_release(api, run_id, job_head_sha, tag, expected_sha, binding_zip)
        job_ok(jobs, 'Resolve release tag', run_id, job_head_sha,
               ('Resolve tag to commit', 'Require version carriers to equal the tag'))
    job_ok(jobs, 'Full suite green on release sha', run_id, job_head_sha, ('Require a successful workflow_dispatch CI run on this sha',))
    for leg in LEGS:
        job_ok(jobs, f'Build & release ({leg.removeprefix("bundle-")})', run_id, job_head_sha, ('Build Tauri app', 'Upload bundle artifacts'))
    # The producer already admits manual CI or a canonical push-to-main full
    # run. Both execute these exact full roles; PR/queue/scheduled/tag pushes
    # and fast-only runs cannot stand in for them.
    cis = []
    for event in ('workflow_dispatch', 'push'):
        rows = pages(api, f'{REPO}/actions/workflows/ci.yml/runs?event={event}&head_sha={expected_sha}', 'workflow_runs')
        cis.extend(c for c in rows if c.get('event') == event)
    matching = [c for c in cis if ci_run_ok(c, expected_sha, ci_workflow['id'])]
    ci_evidence = None
    for c in matching:
        same_ci_attempt(api, c, expected_sha, ci_workflow['id'])
        cjobs = pages(api, f'{REPO}/actions/runs/{c["id"]}/attempts/{c["run_attempt"]}/jobs', 'jobs')
        try:
            for name, steps in CI_STEPS.items():
                job_ok(cjobs, name, c['id'], expected_sha, steps, c['run_attempt'])
        except ValueError:
            continue
        same_ci_attempt(api, c, expected_sha, ci_workflow['id'])
        ci_evidence = {'id': c['id'], 'attempt': c['run_attempt'], 'event': c['event'], 'ref': c.get('head_branch')}
        selected_ci = c
        break
    if ci_evidence is None: fail('no successful exact-SHA manual full CI or canonical main-push full CI with both full-suite roles and gate')
    files = {name: source(api, name, expected_sha) for name in SOURCE}
    config = json.loads(files['src-tauri/tauri.conf.json'])
    version = config['version']
    if tag != 'v' + version or json.loads(files['package.json'])['version'] != version or tomllib.loads(files['src-tauri/Cargo.toml'].decode())['package']['version'] != version: fail('exact-SHA source version mismatch')
    pubkey = config['plugins']['updater']['pubkey']
    if not isinstance(pubkey, str) or not pubkey: fail('missing source updater public key')
    artifacts = pages(api, f'{REPO}/actions/runs/{run_id}/artifacts', 'artifacts')
    report = {}
    for name in LEGS:
        a = exactly([x for x in artifacts if x.get('name') == name], f'artifact {name}')
        w = a.get('workflow_run', {})
        d = a.get('digest', '')
        if (a.get('expired') is not False or not isinstance(a.get('id'), int) or a['id'] < 1 or not re.fullmatch(r'sha256:[0-9a-f]{64}', d or '') or w.get('id') != run_id or w.get('repository_id') != REPO_ID or w.get('head_repository_id') != REPO_ID or w.get('head_sha') != job_head_sha): fail(f'artifact {name} identity/digest/expiry mismatch')
        path = Path(zips[name])
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 2 * 1024**3: fail(f'invalid ZIP {name}')
        if not isinstance(a.get('size_in_bytes'), int) or a['size_in_bytes'] != path.stat().st_size: fail(f'artifact ZIP size mismatch: {name}')
        h = hashlib.sha256()
        with path.open('rb') as f:
            for block in iter(lambda: f.read(1024 * 1024), b''): h.update(block)
        if 'sha256:' + h.hexdigest() != d: fail(f'artifact ZIP digest mismatch: {name}')
        report[name] = {'id': a['id'], 'digest': d}
    if len({x['id'] for x in report.values()}) != len(LEGS): fail('duplicate artifact IDs')
    if api(f'{REPO}/git/ref/tags/{tag}').get('object') != ref['object']: fail('tag changed during verification')
    same_ci_attempt(api, selected_ci, expected_sha, ci_workflow['id'])
    return {'repo': 'ashlrai/ashlr-md', 'repository_id': REPO_ID, 'source_sha256': {k: hashlib.sha256(v).hexdigest() for k, v in files.items()}, 'tag': tag, 'tag_object': ref['object'], 'sha': expected_sha, 'release_run': run_id, 'release_workflow_id': release_workflow['id'], 'release_attempt': 1,
            'full_ci': ci_evidence, 'manual_ci': ci_evidence if ci_evidence['event'] == 'workflow_dispatch' else None,
            'version': version, 'public_key': pubkey, 'artifacts': report, 'linux_version_evidence': 'source-bound CI provenance, not embedded runtime version'}
