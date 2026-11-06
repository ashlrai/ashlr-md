#!/usr/bin/env python3
"""Download original qualified ZIPs for read-only hosted assembly; never publish."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import shutil
import stat
import subprocess

spec = importlib.util.spec_from_file_location('assembly_provenance', Path(__file__).with_name('release-provenance.py'))
provenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provenance)
MAX_ZIP = 2 * 1024**3


def fail(message):
    raise ValueError(message)


def validate_context(env, tag, sha, run_id, attempt):
    if (env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch' or env.get('GITHUB_REF') != 'refs/heads/main'
            or env.get('GITHUB_REPOSITORY') != 'ashlrai/ashlr-md'
            or env.get('GITHUB_REPOSITORY_ID') != str(provenance.REPO_ID)
            or not re.fullmatch(r'[0-9a-f]{40}', env.get('GITHUB_SHA', ''))):
        fail('assembly requires the canonical main-only manual workflow')
    if (not re.fullmatch(r'v\d+\.\d+\.\d+', tag)
            or not re.fullmatch(r'[0-9a-f]{40}', sha)
            or type(run_id) is not int or run_id < 1 or type(attempt) is not int or attempt != 1):
        fail('invalid immutable source/run/attempt inputs')


def download_original(artifact, destination):
    # Only a numeric ID from fixed-repository API metadata selects the download.
    # gh owns the ephemeral read-only Actions credential and redirect handling.
    # No archive is extracted or executed here; cap both bytes and wall time.
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_ZIP, MAX_ZIP))
    with destination.open('xb') as out:
        os.chmod(destination, 0o600)
        subprocess.run(['gh', 'api', '--hostname', 'github.com',
                        f'repos/ashlrai/ashlr-md/actions/artifacts/{artifact["id"]}/zip'],
                       stdout=out, stderr=subprocess.DEVNULL, check=True, timeout=300,
                       preexec_fn=limits)


def output_directory(env):
    root = Path(env.get('RUNNER_TEMP', ''))
    if not root.is_absolute() or '..' in root.parts or root.resolve(strict=True) != root:
        fail('RUNNER_TEMP must be an absolute real directory')
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        fail('RUNNER_TEMP must be owned and not group/world writable')
    return root / 'md-original-zips'


def prepare(tag, sha, run_id, attempt, *, env, api=provenance.fetch, download=download_original):
    validate_context(env, tag, sha, run_id, attempt)
    directory = output_directory(env)
    run = api(f'{provenance.REPO}/actions/runs/{run_id}')
    if (run.get('id') != run_id or run.get('run_attempt') != 1 or run.get('head_sha') != sha
            or run.get('head_branch') != tag or run.get('event') != 'push'
            or run.get('path') != '.github/workflows/release.yml'
            or run.get('repository', {}).get('id') != provenance.REPO_ID
            or run.get('head_repository', {}).get('id') != provenance.REPO_ID
            or (run.get('status'), run.get('conclusion')) != ('completed', 'success')):
        fail('original release run is not eligible')
    artifacts = provenance.pages(api, f'{provenance.REPO}/actions/runs/{run_id}/artifacts', 'artifacts')
    if len(artifacts) != len(provenance.LEGS) or {a.get('name') for a in artifacts} != set(provenance.LEGS):
        fail('original artifact inventory differs')
    ids = set()
    for artifact in artifacts:
        binding = artifact.get('workflow_run', {})
        identity, size = artifact.get('id'), artifact.get('size_in_bytes')
        if (type(identity) is not int or identity < 1 or identity in ids
                or type(size) is not int or not 0 < size <= MAX_ZIP
                or artifact.get('expired') is not False
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', artifact.get('digest', ''))
                or binding.get('id') != run_id or binding.get('head_sha') != sha
                or binding.get('repository_id') != provenance.REPO_ID
                or binding.get('head_repository_id') != provenance.REPO_ID):
            fail('original artifact identity/digest/size differs')
        ids.add(identity)
    # mkdir is exclusive: cleanup below owns only this new private directory.
    directory.mkdir(mode=0o700)
    try:
        for artifact in sorted(artifacts, key=lambda row: row['name']):
            name = artifact['name']
            if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*', name):
                fail('invalid artifact filename')
            destination = directory / (name + '.zip')
            download(artifact, destination)
            if not stat.S_ISREG(destination.lstat().st_mode):
                fail('download must be a regular file')
        if sorted(p.name for p in directory.iterdir()) != sorted(name + '.zip' for name in provenance.LEGS):
            fail('downloaded ZIP inventory differs')
        zips = {name: directory / (name + '.zip') for name in provenance.LEGS}
        # Reuse every original live check: tag, workflow IDs, exact attempt,
        # all native jobs/steps, manual full CI, source blobs and ZIP digests.
        evidence = provenance.verify_provenance(api, tag, sha, run_id, zips)
        expected = {a['name']: {'id': a['id'], 'digest': a['digest']} for a in artifacts}
        if evidence['artifacts'] != expected:
            fail('original artifact inventory changed during download')
        return evidence
    except BaseException:
        shutil.rmtree(directory)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--run-id', type=int, required=True)
    parser.add_argument('--run-attempt', type=int, required=True)
    args = parser.parse_args()
    try:
        evidence = prepare(args.tag, args.source_sha, args.run_id, args.run_attempt, env=os.environ)
    except (ValueError, OSError, KeyError, subprocess.SubprocessError):
        parser.exit(1, 'assembly preparation failed; original release proof or download unavailable\n')
    print(json.dumps({'source': evidence['sha'], 'releaseRun': evidence['release_run'],
                      'releaseAttempt': evidence['release_attempt'], 'artifactIds': sorted(a['id'] for a in evidence['artifacts'].values())}))


if __name__ == '__main__':
    main()
