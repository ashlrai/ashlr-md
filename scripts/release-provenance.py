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

REPO = '/repos/ashlrai/ashlr-md'
REPO_ID = 1257779576
LEGS = ('bundle-macos-15', 'bundle-macos-15-intel', 'bundle-ubuntu-22.04', 'bundle-windows-latest')
SOURCE = ('.github/workflows/release.yml', '.github/workflows/ci.yml', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'package.json')


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


def job_ok(jobs, name, run_id, sha, steps=()):
    j = exactly([x for x in jobs if x.get('name') == name], f'job {name}')
    if j.get('run_id') != run_id or j.get('head_sha') != sha: fail(f'job {name} run/SHA mismatch')
    if (j.get('status'), j.get('conclusion')) != ('completed', 'success'): fail(f'job {name} did not succeed')
    for step in steps:
        s = exactly([x for x in j.get('steps', []) if x.get('name') == step], f'step {name}/{step}')
        if (s.get('status'), s.get('conclusion')) != ('completed', 'success'): fail(f'step {name}/{step} did not succeed')


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


def verify_provenance(api, tag, expected_sha, run_id, zips):
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag): fail('only stable vX.Y.Z tags supported')
    if not re.fullmatch(r'[0-9a-f]{40}', expected_sha): fail('reviewed SHA must be a full lowercase commit SHA')
    if not isinstance(run_id, int) or run_id < 1: fail('invalid run ID')
    if set(zips) != set(LEGS): fail('four original named artifact ZIPs are required')
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
    if sha != expected_sha: fail('peeled tag does not match reviewed SHA')
    release_workflow = api(f'{REPO}/actions/workflows/release.yml')
    ci_workflow = api(f'{REPO}/actions/workflows/ci.yml')
    if (release_workflow.get('path') != '.github/workflows/release.yml' or ci_workflow.get('path') != '.github/workflows/ci.yml' or not isinstance(release_workflow.get('id'), int) or release_workflow['id'] < 1 or not isinstance(ci_workflow.get('id'), int) or ci_workflow['id'] < 1 or ci_workflow['id'] == release_workflow['id']): fail('workflow identity mismatch')
    run = api(f'{REPO}/actions/runs/{run_id}')
    if run.get('run_attempt') != 1: fail('unsupported release run attempt: only attempt 1 has sufficient artifact binding; later attempts require job-bound artifact evidence')
    if (run.get('id') != run_id or run.get('workflow_id') != release_workflow.get('id') or
        run.get('path') != '.github/workflows/release.yml' or run.get('event') != 'push' or
        run.get('head_sha') != expected_sha or run.get('head_branch') != tag or
        (run.get('status'), run.get('conclusion')) != ('completed', 'success') or
        run.get('repository', {}).get('id') != REPO_ID or run.get('head_repository', {}).get('id') != REPO_ID):
        fail('release run identity/status mismatch')
    jobs = pages(api, f'{REPO}/actions/runs/{run_id}/attempts/1/jobs', 'jobs')
    job_ok(jobs, 'Full suite green on release sha', run_id, expected_sha, ('Require a successful workflow_dispatch CI run on this sha',))
    for leg in LEGS:
        job_ok(jobs, f'Build & release ({leg.removeprefix("bundle-")})', run_id, expected_sha, ('Build Tauri app', 'Upload bundle artifacts'))
    cis = pages(api, f'{REPO}/actions/workflows/ci.yml/runs?event=workflow_dispatch&head_sha={expected_sha}', 'workflow_runs')
    matching = [c for c in cis if c.get('workflow_id') == ci_workflow.get('id') and c.get('path') == '.github/workflows/ci.yml' and c.get('event') == 'workflow_dispatch' and c.get('head_sha') == expected_sha and c.get('repository', {}).get('id') == REPO_ID and c.get('head_repository', {}).get('id') == REPO_ID and (c.get('status'), c.get('conclusion')) == ('completed', 'success') and isinstance(c.get('run_attempt'), int) and c['run_attempt'] >= 1]
    ci_evidence = None
    for c in matching:
        cjobs = pages(api, f'{REPO}/actions/runs/{c["id"]}/attempts/{c["run_attempt"]}/jobs', 'jobs')
        try:
            job_ok(cjobs, 'Linux full suite', c['id'], expected_sha); job_ok(cjobs, 'macOS full suite', c['id'], expected_sha)
            ci_evidence = {'id': c['id'], 'attempt': c['run_attempt']}; break
        except ValueError: pass
    if ci_evidence is None: fail('no successful exact-SHA manual full CI with Linux and macOS full-suite jobs')
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
        if (a.get('expired') is not False or not isinstance(a.get('id'), int) or a['id'] < 1 or not re.fullmatch(r'sha256:[0-9a-f]{64}', d or '') or w.get('id') != run_id or w.get('repository_id') != REPO_ID or w.get('head_repository_id') != REPO_ID or w.get('head_sha') != expected_sha): fail(f'artifact {name} identity/digest/expiry mismatch')
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
    return {'repo': 'ashlrai/ashlr-md', 'repository_id': REPO_ID, 'source_sha256': {k: hashlib.sha256(v).hexdigest() for k, v in files.items()}, 'tag': tag, 'tag_object': ref['object'], 'sha': expected_sha, 'release_run': run_id, 'release_workflow_id': release_workflow['id'], 'release_attempt': 1, 'manual_ci': ci_evidence, 'version': version, 'public_key': pubkey, 'artifacts': report, 'linux_version_evidence': 'source-bound CI provenance, not embedded runtime version'}
