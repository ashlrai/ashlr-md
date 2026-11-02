#!/usr/bin/env python3
"""Original Windows NSIS qualification on a disposable standard hosted runner."""
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('linux_qa', ROOT / 'scripts/native-qa.py')
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)
require = qa.require
INSTALLER = 'Ashlr_MD_0.5.0_x64-setup.exe'
MEMBER = 'release/bundle/nsis/Ashlr MD_0.5.0_x64-setup.exe'
INSTALLER_HASH = 'a9009b3dcde484bab7f5d334411a1b014ce20450d1cdf82c6853decb98af8ca6'
EXE_HASH = '9e1e16c40fd6109e0a1e88694c3113dc0ca61f42ee3e3dced2ccd550df902ff1'
STAGE = 'md050-original-windows-qa'
UNINSTALL_KEY = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\Ashlr MD'
RUNTIME_KEY = r'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
_JOB = None


def safe_path(path):
    require(path.is_absolute() and path.resolve() == path, 'absolute non-link path required')
    for p in (path, *path.parents):
        if p.exists():
            info = p.lstat()
            require(not stat.S_ISLNK(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400, 'reparse point rejected')
    require(not any(c in str(path) for c in '\r\n"'), 'invalid path character')
    return path


def stage():
    raw = os.environ.get('RUNNER_TEMP', '')
    require(bool(raw), 'missing RUNNER_TEMP')
    root = safe_path(Path(raw))
    require(root.is_dir(), 'runner temporary directory missing')
    return safe_path(root / STAGE)


def selected():
    work = stage()
    require(os.environ.get('STAGE_PATH') == str(work) and work.is_dir(), 'unexpected qualification stage')
    return work


def hash_file(path, maximum):
    safe_path(path)
    require(path.is_file() and path.stat().st_size <= maximum, 'invalid bounded file')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def select_installer(archive, work):
    with zipfile.ZipFile(archive) as z:
        for name, output, bound in ((MEMBER, INSTALLER, 32*1024**2), (MEMBER+'.sig', INSTALLER+'.sig', 4096)):
            matches = [i for i in z.infolist() if i.filename == name and not i.is_dir()]
            require(len(matches) == 1, 'missing or duplicate Windows updater member')
            member = matches[0]
            require((member.external_attr >> 16) & 0o170000 in (0, 0o100000), 'nonregular Windows updater member')
            require(0 < member.file_size <= bound, 'oversized Windows updater member')
            with (work/output).open('xb') as f:
                f.write(z.read(member))
    require(hash_file(work/INSTALLER, 32*1024**2) == INSTALLER_HASH, 'original installer digest mismatch')


def prepare():
    token = os.environ.pop('GH_TOKEN', '')
    require(bool(token), 'artifact-read token required')
    work = stage(); work.mkdir()  # Exclusive, inherits the disposable runner user's ACL.
    try:
        output = os.environ.get('GITHUB_OUTPUT', '')
        require(bool(output), 'missing workflow output')
        with open(output, 'a', encoding='utf-8') as f: f.write(f'stage={work}\n')
    except BaseException:
        work.rmdir(); raise
    prov = qa.module(); api = qa.metadata_fetcher(token)
    artifacts = prov.pages(api, f'{prov.REPO}/actions/runs/{qa.RUN}/artifacts', 'artifacts')
    zips = {}
    for leg in prov.LEGS:
        artifact = prov.exactly([a for a in artifacts if a.get('name') == leg], leg)
        if leg == 'bundle-windows-latest': require(artifact.get('id') == 13105824003, 'original Windows artifact ID changed')
        require(artifact.get('expired') is False and artifact.get('workflow_run', {}).get('head_sha') == qa.SHA, 'artifact identity mismatch')
        target = work/(leg+'.zip'); qa.download_zip(artifact, target, token); zips[leg] = target
    receipt = prov.verify_provenance(api, qa.TAG, qa.SHA, qa.RUN, zips)
    latest = api(prov.REPO+'/releases/latest')
    api = None; token = None
    require(latest.get('tag_name') == 'v0.4.0' and latest.get('prerelease') is False, 'stable release changed')
    with qa.plain_opener().open('https://github.com/ashlrai/ashlr-md/releases/latest/download/latest.json', timeout=30) as r:
        require(json.loads(r.read(1024*1024+1)).get('version') == '0.4.0', 'stable updater feed changed')
    select_installer(zips['bundle-windows-latest'], work)
    key = work/'public-key.txt'; key.write_text(receipt['public_key'])
    verifier = ROOT/'scripts/release-signature-check/target/release/release-signature-check.exe'
    subprocess.run([str(verifier), str(key), str(work/(INSTALLER+'.sig')), str(work/INSTALLER)], check=True, timeout=30)
    with (work/'qualified.json').open('x') as f:
        json.dump({'sha':qa.SHA, 'run':qa.RUN, 'installer_sha256':INSTALLER_HASH}, f)
    print('PASS: original Windows installer signature and four-leg provenance verified; no installer launched.')


def prepared():
    require(not os.environ.get('GH_TOKEN') and not os.environ.get('GITHUB_TOKEN'), 'token must not enter native phase')
    work = selected(); marker = work/'qualified.json'
    safe_path(marker)
    require(marker.is_file() and marker.stat().st_size < 1024, 'missing preparation marker')
    require(json.loads(marker.read_text()) == {'sha':qa.SHA, 'run':qa.RUN, 'installer_sha256':INSTALLER_HASH}, 'wrong preparation marker')
    require(hash_file(work/INSTALLER, 32*1024**2) == INSTALLER_HASH, 'installer changed')
    return work


def native_env(work):
    allowed = {'PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','USERNAME','USERDOMAIN','EDGEWEBDRIVER'}
    env = {k:v for k,v in os.environ.items() if k.upper() in allowed}
    for key, part in {'HOME':'home','USERPROFILE':'home','APPDATA':'roaming','LOCALAPPDATA':'local','TEMP':'tmp','TMP':'tmp'}.items():
        path = work/part
        if not path.exists(): path.mkdir()
        safe_path(path); env[key] = str(path)
    env['RUNNER_TEMP'] = os.environ['RUNNER_TEMP']; env['STAGE_PATH'] = str(work)
    return env


def enter_owned_job():
    # The worker joins BEFORE it can spawn any child. Its parent has a hard timeout.
    # Non-inherited handle is closed by worker exit/termination, killing descendants.
    require(os.name == 'nt', 'Windows only')
    from ctypes import wintypes as w
    class Basic(ctypes.Structure):
        _fields_ = [('per_process',ctypes.c_longlong),('per_job',ctypes.c_longlong),('flags',w.DWORD),('minimum',ctypes.c_size_t),('maximum',ctypes.c_size_t),('active',w.DWORD),('affinity',ctypes.c_size_t),('priority',w.DWORD),('scheduling',w.DWORD)]
    class IO(ctypes.Structure):
        _fields_ = [(name,ctypes.c_ulonglong) for name in ('read_ops','write_ops','other_ops','read_bytes','write_bytes','other_bytes')]
    class Extended(ctypes.Structure):
        _fields_ = [('basic',Basic),('io',IO),('process_memory',ctypes.c_size_t),('job_memory',ctypes.c_size_t),('peak_process',ctypes.c_size_t),('peak_job',ctypes.c_size_t)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.argtypes=[ctypes.c_void_p,w.LPCWSTR]; kernel.CreateJobObjectW.restype=w.HANDLE
    kernel.GetCurrentProcess.restype=w.HANDLE
    kernel.SetInformationJobObject.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD]
    kernel.AssignProcessToJobObject.argtypes=[w.HANDLE,w.HANDLE]
    global _JOB
    _JOB = kernel.CreateJobObjectW(None,None)
    require(bool(_JOB), 'cannot create owned process job')
    info=Extended(); info.basic.flags=0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    require(bool(kernel.SetInformationJobObject(_JOB,9,ctypes.byref(info),ctypes.sizeof(info))), 'cannot bound process job')
    require(bool(kernel.AssignProcessToJobObject(_JOB,kernel.GetCurrentProcess())), 'cannot join owned process job')


def reg_value(root, key, name):
    import winreg
    try:
        with winreg.OpenKey(root,key,0,winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as handle:
            return winreg.QueryValueEx(handle,name)[0]
    except FileNotFoundError: return None


def no_existing_install():
    import winreg
    for hive in (winreg.HKEY_CURRENT_USER,winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive,UNINSTALL_KEY,0,winreg.KEY_READ | winreg.KEY_WOW64_64KEY):
                raise ValueError('pre-existing Ashlr MD installation; refusing to replace')
        except FileNotFoundError: pass


def driver_path():
    import winreg
    runtime = reg_value(winreg.HKEY_LOCAL_MACHINE,RUNTIME_KEY,'pv')
    require(isinstance(runtime,str) and re.fullmatch(r'[1-9][0-9]*\.[0-9]+\.[0-9]+\.[0-9]+',runtime), 'machine WebView2 runtime missing; no automatic installation')
    raw=os.environ.get('EDGEWEBDRIVER','')
    require(bool(raw), 'runner Edge driver path missing')
    driver=safe_path(Path(raw)/'msedgedriver.exe')
    require(driver.is_file(), 'runner Edge driver missing')
    result=subprocess.run([str(driver),'--version'],capture_output=True,text=True,check=True,timeout=10)
    found=re.search(r'\b([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\b', result.stdout)
    require(found is not None, 'Edge driver version missing or malformed')
    print(f'WebView2 {runtime}; Edge driver {found[1]}', flush=True)
    require(found[1].split('.')[:3] == runtime.split('.')[:3], 'Edge driver does not match WebView2 runtime; no unpinned download')
    return driver


def nsis_command(executable, install, uninstall=False):
    # NSIS requires the final /D= or _?= operand UNQUOTED, even with spaces.
    safe_path(executable); safe_path(install)
    return subprocess.list2cmdline([str(executable), '/S'] + ([] if uninstall else ['/NS'])) + (' _?=' if uninstall else ' /D=') + str(install)


def uninstall(work):
    install=work/'installed'; uninstaller=install/'uninstall.exe'
    if not (work/'install-attempted').exists(): return
    if (work/'uninstall-complete').exists():
        require(not (install/'md-opener.exe').exists(), 'application reappeared after uninstall')
        no_existing_install()
        return
    if not uninstaller.exists():
        no_existing_install()
        require(not (install/'md-opener.exe').exists(), 'partial installation needs investigation')
        return
    safe_path(uninstaller)
    subprocess.run(nsis_command(uninstaller,install,True),check=True,timeout=60)
    require(not (install/'md-opener.exe').exists(), 'uninstall left application executable')
    no_existing_install()
    (work/'uninstall-complete').touch(exist_ok=False)
    print('PASS: original installer uninstalled application and registration.')


def worker():
    enter_owned_job()
    work=prepared(); driver=driver_path(); no_existing_install()
    install=work/'installed'
    require(not install.exists(), 'installation directory collision')
    (work/'install-attempted').touch(exist_ok=False)
    try:
        subprocess.run(nsis_command(work/INSTALLER,install),check=True,timeout=90)
        app=install/'md-opener.exe'
        require(hash_file(app,64*1024**2)==EXE_HASH, 'installed executable differs from original signed payload')
        fixture=work/'native-smoke.md'
        with fixture.open('x',encoding='utf-8') as f: f.write(f'# {qa.HEADING}\n\nNative WebView Unicode: café 日本語.\n')
        session=None
        with (work/'driver.log').open('xb') as log:
            proc=subprocess.Popen(['tauri-driver','--port','4444','--native-driver',str(driver)],stdout=log,stderr=log)
            try:
                until=time.monotonic()+20
                while True:
                    require(proc.poll() is None,'native driver exited')
                    try: qa.wd('GET','/status'); break
                    except (OSError,ValueError):
                        require(time.monotonic()<until,'native driver readiness timeout'); time.sleep(.2)
                value=qa.wd('POST','/session',{'capabilities':{'alwaysMatch':{'tauri:options':{'application':str(app),'args':[str(fixture)]}}}})
                session=value['sessionId']; require(qa.session_id(session),'invalid session id')
                until=time.monotonic()+60
                while True:
                    value=qa.wd('POST',f'/session/{session}/execute/sync',{'script':qa.DOM_SCRIPT,'args':[]})
                    if qa.oracle(value): break
                    if time.monotonic()>=until:
                        print('Bounded synthetic DOM:',json.dumps({k:str(value.get(k,''))[:256] for k in ('heading','text')} if isinstance(value,dict) else {}))
                        raise ValueError('native DOM fixture mismatch')
                    time.sleep(.3)
                require(fixture.read_text(encoding='utf-8')==f'# {qa.HEADING}\n\nNative WebView Unicode: café 日本語.\n','fixture changed')
                print('PASS: original Windows installed app opened synthetic file and matched native Unicode DOM.')
            except BaseException:
                log.flush()
                with (work/'driver.log').open('rb') as diagnostic:
                    diagnostic.seek(0,os.SEEK_END); diagnostic.seek(max(0,diagnostic.tell()-8192))
                    print('Bounded synthetic driver log:',diagnostic.read(8192).decode('utf-8',errors='replace'))
                raise
            finally:
                try:
                    if session: qa.wd('DELETE',f'/session/{session}')
                finally:
                    if proc.poll() is None: proc.terminate()
                    try: proc.wait(timeout=10)
                    except subprocess.TimeoutExpired: proc.kill(); proc.wait(timeout=5)
    finally:
        uninstall(work)


def run_worker(mode, timeout):
    work=prepared()
    # A dead/timed-out worker closes its non-inherited job handle, killing its subtree.
    subprocess.run([sys.executable,str(Path(__file__).resolve()),mode],env=native_env(work),check=True,timeout=timeout)


def cleanup():
    if not os.environ.get('STAGE_PATH'): return
    work=selected()
    if (work/'install-attempted').exists(): run_worker('--uninstall-worker',90)
    shutil.rmtree(work)


def main():
    require(os.name=='nt','Windows runner required')
    require(len(sys.argv)==2,'expected one fixed phase')
    mode=sys.argv[1]
    if mode=='--check-driver': driver_path()
    elif mode=='--prepare': prepare()
    elif mode=='--probe': run_worker('--worker',300)
    elif mode=='--worker': worker()
    elif mode=='--uninstall-worker': enter_owned_job(); uninstall(prepared())
    elif mode=='--cleanup': cleanup()
    else: raise ValueError('unsupported phase')

if __name__=='__main__': main()
