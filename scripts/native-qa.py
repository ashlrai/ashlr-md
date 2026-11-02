#!/usr/bin/env python3
"""Fixed original-0.5 artifact probe. No install, update, publication or credentials in app."""
import hashlib
import importlib.util
import json
import os
import re
import stat
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SHA = '721b976149ad402cac56205f28bf253603f76535'
RUN = 41362219024
TAG = 'v0.5.0'
APP = 'Ashlr_MD_0.5.0_amd64.AppImage'
ZIP_APP = 'release/bundle/appimage/Ashlr MD_0.5.0_amd64.AppImage'
APP_HASH = 'f4ebaa941f596877937df68713be3646783c8f00d05ac7af692a170484f17c9f'
HEADING = 'Ashlr native qualification 721b976'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def module():
    spec = importlib.util.spec_from_file_location('provenance', ROOT / 'scripts/release-provenance.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def plain_opener():
    # Never inherit an ambient HTTP proxy for local automation or credentials.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def download_zip(artifact, dest, token):
    require(isinstance(artifact['id'], int) and artifact['id'] > 0, 'bad artifact id')
    size = artifact['size_in_bytes']
    require(isinstance(size, int) and 0 < size <= 2 * 1024**3, 'bad artifact size')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    req = urllib.request.Request(
        f'https://api.github.com/repos/ashlrai/ashlr-md/actions/artifacts/{artifact["id"]}/zip',
        headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
                 'User-Agent': 'ashlr-native-qa', 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect).open(req, timeout=30)
    except urllib.error.HTTPError as response:
        require(response.code == 302, 'artifact API did not return download redirect')
        location = response.headers['Location']
    else:
        raise ValueError('unexpected artifact response')
    url = urllib.parse.urlsplit(location)
    require(url.scheme == 'https' and url.hostname and not url.username and not url.password, 'unsafe artifact redirect')
    # A new unauthenticated request: never forward the GitHub token to signed storage.
    h = hashlib.sha256()
    count = 0
    storage = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    with storage.open(location, timeout=30) as response, dest.open('xb') as output:
        while block := response.read(1024 * 1024):
            count += len(block)
            require(count <= size, 'ZIP exceeded API size')
            output.write(block)
            h.update(block)
    require(count == size and 'sha256:' + h.hexdigest() == artifact['digest'], 'ZIP size/digest mismatch')


def select_linux(zipped, work):
    # Only two named regular members are materialized, never archive paths.
    with zipfile.ZipFile(zipped) as z:
        selected = []
        for name in (APP, APP + '.sig'):
            original = ZIP_APP + ('.sig' if name.endswith('.sig') else '')
            members = [i for i in z.infolist() if i.filename == original and not i.is_dir()]
            require(len(members) == 1, 'missing or duplicate updater member')
            member = members[0]
            require((member.external_attr >> 16) & 0o170000 in (0, 0o100000), 'nonregular updater member')
            limit = 128 * 1024**2 if name == APP else 4096
            require(0 < member.file_size <= limit, 'oversized updater member')
            data = z.read(member)
            require(len(data) == member.file_size, 'member size mismatch')
            target = work / name
            target.write_bytes(data)
            selected.append(target)
    require(hashlib.sha256(selected[0].read_bytes()).hexdigest() == APP_HASH, 'qualified Linux artifact mismatch')
    return selected


def app_env(work):
    env = {k: os.environ[k] for k in ('PATH', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'LANG') if k in os.environ}
    for key, suffix in [('HOME','home'), ('XDG_CONFIG_HOME','config'), ('XDG_CACHE_HOME','cache'), ('XDG_DATA_HOME','data'), ('XDG_RUNTIME_DIR','runtime'), ('TMPDIR','tmp')]:
        path = work / suffix
        path.mkdir(mode=0o700)
        env[key] = str(path)
    return env


def session_id(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9-]{1,128}', value) is not None


def wd_route(method, path):
    if (method, path) in (('GET', '/status'), ('POST', '/session')):
        return True
    match = re.fullmatch(r'/session/([A-Za-z0-9-]{1,128})(/execute/sync)?', path) if isinstance(path, str) else None
    return bool(match and ((method == 'DELETE' and match[2] is None) or (method == 'POST' and match[2] == '/execute/sync')))


def wd(method, path, payload=None):
    require(wd_route(method, path), 'unsupported WebDriver method/route')
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request('http://127.0.0.1:4444' + path, data=body,
                                     headers={'Content-Type':'application/json'}, method=method)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    with opener.open(request, timeout=60 if (method, path) == ('POST', '/session') else 10) as response:
        value = json.load(response)['value']
    require(not isinstance(value, dict) or 'error' not in value, 'WebDriver command failed')
    return value


def oracle(value):
    return isinstance(value, dict) and value.get('heading') == HEADING and value.get('text') == 'Native WebView Unicode: café 日本語.'


def stop_group(proc):
    # All driver/app descendants share this owned new process group.
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait(timeout=5)


def validate_probe_paths(work, app):
    # Trusted same-UID checkout/ancestors remain a precondition, not a TOCTOU sandbox.
    require(work.is_absolute() and work.resolve() == work, 'work must be absolute without symlink components')
    info = work.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700, 'work must be an owned private directory')
    require(app == work / APP, 'unexpected app location/name')
    info = app.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid(), 'app must be an owned regular file')
    require(info.st_size <= 128 * 1024**2 and hashlib.sha256(app.read_bytes()).hexdigest() == APP_HASH, 'child app digest mismatch')
    require(not any(os.path.lexists(work / name) for name in ('native-smoke.md', 'driver.log')), 'probe output collision')


def probe(work, app):
    validate_probe_paths(work, app)
    def deadline(*_):
        raise TimeoutError('120-second native probe deadline')
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(120)
    env = app_env(work)
    fixture = work / 'native-smoke.md'
    with fixture.open('x', encoding='utf-8') as output:
        output.write(f'# {HEADING}\n\nNative WebView Unicode: café 日本語.\n')
    app.chmod(0o700)
    session = None
    with (work / 'driver.log').open('xb') as log:
        proc = subprocess.Popen(['tauri-driver', '--port', '4444'], env=env, stdout=log, stderr=log, start_new_session=True)
        try:
            until = time.monotonic() + 20
            while True:
                require(proc.poll() is None, 'driver exited before readiness')
                try:
                    wd('GET', '/status')
                    break
                except (OSError, ValueError):
                    require(time.monotonic() < until, 'driver readiness timeout')
                    time.sleep(0.2)
            value = wd('POST', '/session', {'capabilities': {'alwaysMatch': {'tauri:options': {'application': str(app), 'args': [str(fixture)]}}}})
            session = value['sessionId']
            require(session_id(session), 'invalid session id')
            until = time.monotonic() + 60
            while True:
                value = wd('POST', f'/session/{session}/execute/sync', {'script': 'return {heading: document.querySelector("h1")?.textContent, text: [...document.querySelectorAll("p")].map(x => x.textContent).find(x => x === "Native WebView Unicode: café 日本語.")};', 'args': []})
                if oracle(value):
                    break
                require(time.monotonic() < until, 'native DOM fixture mismatch/timeout')
                time.sleep(0.3)
            require(fixture.read_text() == f'# {HEADING}\n\nNative WebView Unicode: café 日本語.\n', 'fixture unexpectedly changed')
            print('PASS: original signed Linux AppImage launched and native DOM fixture matched; no install/update exercised', flush=True)
        except BaseException:
            log.flush()
            with (work / 'driver.log').open('rb') as diagnostic:
                diagnostic.seek(0, os.SEEK_END)
                diagnostic.seek(max(0, diagnostic.tell() - 8192))
                raw = diagnostic.read(8192)
            print('Bounded driver log (synthetic inputs only):', raw.decode('utf-8', errors='replace'), file=sys.stderr)
            raise
        finally:
            try:
                if session:
                    try:
                        wd('DELETE', f'/session/{session}')
                    except (OSError, ValueError):
                        pass
            finally:
                signal.alarm(0)
                stop_group(proc)



def staging_path():
    raw = os.environ.get('RUNNER_TEMP', '')
    require(raw and '\n' not in raw and '\r' not in raw, 'invalid RUNNER_TEMP')
    root = Path(raw)
    require(root.is_absolute() and root.resolve() == root, 'RUNNER_TEMP must be absolute without symlinks')
    info = root.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid(), 'RUNNER_TEMP must be an owned directory')
    return root / 'md050-original-native-qa'


def selected_stage():
    work = staging_path()
    require(os.environ.get('STAGE_PATH') == str(work), 'missing or unexpected prepared stage')
    info = work.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700, 'invalid prepared stage')
    return work


def prepare():
    token = os.environ.pop('GH_TOKEN', '')
    require(bool(token), 'artifact-read token required')
    work = staging_path()
    work.mkdir(mode=0o700)  # Exclusive: never reuse/clean another existing directory.
    try:
        output = os.environ.get('GITHUB_OUTPUT', '')
        require(bool(output), 'missing workflow output file')
        with open(output, 'a', encoding='utf-8') as f:
            f.write(f'stage={work}\n')
    except BaseException:
        work.rmdir()
        raise
    # Output precedes verification so the always-cleanup step owns failed preparation.
    prov = module()
    artifacts = prov.pages(prov.fetch, f'{prov.REPO}/actions/runs/{RUN}/artifacts', 'artifacts')
    zips = {}
    for leg in prov.LEGS:
        a = prov.exactly([x for x in artifacts if x.get('name') == leg], leg)
        require(a.get('expired') is False and a.get('workflow_run', {}).get('head_sha') == SHA, 'artifact not current/exact source')
        target = work / (leg + '.zip')
        download_zip(a, target, token)
        zips[leg] = target
    token = None
    receipt = prov.verify_provenance(prov.fetch, TAG, SHA, RUN, zips)
    app, sig = select_linux(zips['bundle-ubuntu-22.04'], work)
    key = work / 'public-key.txt'
    key.write_text(receipt['public_key'])
    subprocess.run([str(ROOT / 'scripts/release-signature-check/target/release/release-signature-check'), str(key), str(sig), str(app)], check=True, timeout=30)
    # Read-only metadata: abort on any drift; never accept a UI Install dialog.
    latest = prov.fetch(prov.REPO + '/releases/latest')
    require(latest.get('tag_name') == 'v0.4.0' and latest.get('prerelease') is False, 'stable release changed; review before probe')
    with plain_opener().open('https://github.com/ashlrai/ashlr-md/releases/latest/download/latest.json', timeout=30) as response:
        metadata = json.loads(response.read(1024 * 1024 + 1))
    require(metadata.get('version') == '0.4.0', 'stable updater metadata changed')
    with (work / 'qualified.json').open('x', encoding='utf-8') as f:
        json.dump({'sha': SHA, 'run': RUN, 'app_sha256': APP_HASH}, f)
    print('Preparation complete; original Linux payload verified. No native process started.')


def run_prepared():
    require(not os.environ.get('GH_TOKEN') and not os.environ.get('GITHUB_TOKEN'), 'token must not enter probe step')
    work = selected_stage()
    marker = work / 'qualified.json'
    require(marker.is_file() and not marker.is_symlink() and marker.stat().st_size < 1024, 'missing preparation receipt')
    require(json.loads(marker.read_text()) == {'sha': SHA, 'run': RUN, 'app_sha256': APP_HASH}, 'invalid preparation receipt')
    probe(work, work / APP)


def cleanup():
    if not os.environ.get('STAGE_PATH'):
        return  # Prepare did not create a directory; never remove a collision.
    shutil.rmtree(selected_stage())


def main():
    require(len(sys.argv) == 2 and sys.argv[1] in ('--prepare', '--probe', '--cleanup'), 'expected fixed prepare/probe/cleanup phase')
    {'--prepare': prepare, '--probe': run_prepared, '--cleanup': cleanup}[sys.argv[1]]()


if __name__ == '__main__':
    main()
