#!/usr/bin/env python3
"""Original Windows NSIS qualification on a disposable standard hosted runner."""
import ctypes
import io
import urllib.request
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
    allowed = {'PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','USERNAME','USERDOMAIN','EDGEWEBDRIVER','ARGV_QUERY_READY'}
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



DRIVER_VERSION = '131.0.2903.86'
DRIVER_URL = f'https://msedgedriver.microsoft.com/{DRIVER_VERSION}/edgedriver_win64.zip'
DRIVER_ZIP_HASH = '16ad3ea073e26f0000d1315e0a851eeb44b2754c66d47652e265cce5dea662af'
DRIVER_EXE_HASH = 'c34a6b22814a18599f2a67bef922ba879ae44158f216d4d2df797d293f545665'
DRIVER_STAGE = 'md050-pinned-edge-driver'
MICROSOFT_SUBJECT = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'


def driver_stage():
    return safe_path(stage().parent / DRIVER_STAGE)


def signature_diagnostic(stderr, started):
    # Report only our fixed markers, never raw shell/certificate/environment text.
    if isinstance(stderr,bytes): stderr=stderr.decode('utf-8',errors='replace')
    markers=stderr.splitlines() if isinstance(stderr,str) else []
    phase='signature-returned' if 'qa-signature-returned' in markers else ('signature-started' if 'qa-signature-start' in markers else 'shell-startup')
    print(f'Driver trust phase: {phase}; elapsed {time.monotonic()-started:.1f}s',flush=True)


def powershell_environment(marker, value):
    # Fixed shell and literal environment input, never shell-interpolated paths.
    env = {k:v for k,v in os.environ.items() if k.upper() in {'SYSTEMROOT','WINDIR','PATH','TEMP','TMP'}}
    env[marker] = value
    return safe_path(Path(os.environ['SYSTEMROOT'])/'System32/WindowsPowerShell/v1.0/powershell.exe'), env


def bundled_driver():
    try:
        raw = os.environ.get('EDGEWEBDRIVER','')
        driver = safe_path(Path(raw)/'msedgedriver.exe') if raw else None
        return driver if driver is not None and driver.is_file() else None
    except (OSError,ValueError):
        return None


def prime_signature_verification(warm_file):
    # Concurrent best-effort priming of cold machine CTL/chain caches while the
    # pinned archive downloads; its result is never consulted. The pinned
    # driver's own verification below stays a full Authenticode check.
    shell, env = powershell_environment('QA_WARM_FILE', str(warm_file))
    return subprocess.Popen([str(shell),'-NoLogo','-NoProfile','-NonInteractive','-Command',
        'Get-AuthenticodeSignature -LiteralPath $env:QA_WARM_FILE | Out-Null'],
        env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)


def end_signature_warmup(proc):
    # Best-effort bound; a lingering priming process never holds provisioning.
    if proc is None or proc.poll() is not None: return
    try:
        proc.terminate(); proc.wait(timeout=5)
    except (OSError,subprocess.TimeoutExpired):
        try: proc.kill()
        except OSError: pass
        try: proc.wait(timeout=5)
        except (OSError,subprocess.TimeoutExpired): pass


def verify_driver_signature(driver):
    script = "[Console]::Error.WriteLine('qa-signature-start'); $s=Get-AuthenticodeSignature -LiteralPath $env:QA_DRIVER_FILE; [Console]::Error.WriteLine('qa-signature-returned'); @{status=$s.Status.ToString(); subject=$s.SignerCertificate.Subject; eku=@($s.SignerCertificate.EnhancedKeyUsageList | ForEach-Object {$_.ObjectId})} | ConvertTo-Json -Compress"
    shell, env = powershell_environment('QA_DRIVER_FILE', str(driver))
    started=time.monotonic()
    print('Checking pinned driver Microsoft Authenticode (90s limit)',flush=True)
    try:
        result = subprocess.run([str(shell),'-NoLogo','-NoProfile','-NonInteractive','-Command',script],env=env,capture_output=True,text=True,timeout=90,check=True)
    except (subprocess.TimeoutExpired,subprocess.CalledProcessError) as error:
        signature_diagnostic(getattr(error,'stderr',None),started)
        raise RuntimeError('driver signature verification did not complete successfully') from None
    signature_diagnostic(result.stderr,started)
    require(len(result.stdout)<=8192, 'signature response too large')
    value=json.loads(result.stdout)
    require(isinstance(value,dict), 'invalid signature response shape')
    status=value.get('status')
    known={'Valid','UnknownError','NotSigned','HashMismatch','NotTrusted','NotSupportedFileFormat','Incompatible'}
    status=status if isinstance(status,str) and status in known else 'unknown'
    subject_matches=value.get('subject')==MICROSOFT_SUBJECT
    eku=value.get('eku',[])
    code_signing=isinstance(eku,list) and '1.3.6.1.5.5.7.3.3' in eku
    print(f'Driver trust result: status={status}; subject_matches={subject_matches}; code_signing_EKU={code_signing}',flush=True)
    require(status=='Valid' and subject_matches and code_signing, 'valid Microsoft code-signing signature required')


def extract_driver(data, destination):
    require(len(data)<=16*1024*1024 and hashlib.sha256(data).hexdigest()==DRIVER_ZIP_HASH, 'pinned driver archive digest mismatch')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries=archive.infolist()
        allowed={'Driver_Notes/','Driver_Notes/credits.html','Driver_Notes/EULA','Driver_Notes/LICENSE','msedgedriver.exe'}
        require(len(entries)==5 and {x.filename for x in entries}==allowed, 'unexpected driver archive inventory')
        require(all(x.orig_filename==x.filename and '\x00' not in x.orig_filename and not x.flag_bits&1 and stat.S_IFMT(x.external_attr>>16) in (0,stat.S_IFREG,stat.S_IFDIR) and x.file_size<=20*1024*1024 for x in entries), 'unsafe driver archive entry')
        info=archive.getinfo('msedgedriver.exe')
        require(info.file_size==17870408, 'driver executable size mismatch')
        data=archive.read(info)
    require(hashlib.sha256(data).hexdigest()==DRIVER_EXE_HASH, 'pinned driver executable digest mismatch')
    with destination.open('xb') as f: f.write(data)


def pinned_driver(runtime, provision=False):
    require(runtime.split('.')[:3]==DRIVER_VERSION.split('.')[:3], 'runtime not covered by pinned driver; no dynamic download')
    require(not os.environ.get('GH_TOKEN') and not os.environ.get('GITHUB_TOKEN'), 'driver provisioning must be token-free')
    root=driver_stage(); driver=root/'msedgedriver.exe'
    warm=None
    if provision:
        root.mkdir()  # Exclusive ownership; never reuse or overwrite another stage.
        try:
            with open(os.environ['GITHUB_OUTPUT'],'a',encoding='utf-8') as output: output.write(f'driver_stage={root}\n')
        except Exception:
            root.rmdir()
            raise
        source=bundled_driver()
        if source is not None:
            try: warm=prime_signature_verification(source)
            except (OSError,ValueError,KeyError): pass
    try:
        if provision:
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self,*args,**kwargs): return None
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
            with opener.open(DRIVER_URL,timeout=30) as response:
                require(response.status==200 and response.geturl()==DRIVER_URL, 'unexpected driver download response')
                data=response.read(16*1024*1024+1)
            extract_driver(data,driver)
        require(hash_file(driver,20*1024*1024)==DRIVER_EXE_HASH, 'pinned driver changed')
        verify_driver_signature(driver)  # Before even executing --version.
    finally:
        end_signature_warmup(warm)
    return driver


def driver_path(provision=False):
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
    if found[1].split('.')[:3] != runtime.split('.')[:3]:
        driver=pinned_driver(runtime,provision)
        result=subprocess.run([str(driver),'--version'],capture_output=True,text=True,check=True,timeout=10)
        found=re.search(r'\b([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\b',result.stdout)
        require(found and found[1]==DRIVER_VERSION, 'pinned driver version mismatch')
        print(f'Pinned Edge driver {found[1]}',flush=True)
    require(found[1].split('.')[:3]==runtime.split('.')[:3], 'Edge driver does not match WebView2 runtime')
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


DOM_DIAGNOSTIC_SCRIPT = r"""
return {
  title: String(document.title || '').slice(0,128),
  location: String(location.origin + location.pathname).slice(0,256),
  readyState: document.readyState,
  tauri: typeof window.__TAURI_INTERNALS__ !== 'undefined',
  body: String(document.body?.innerText || document.body?.textContent || '').slice(0,512),
  root: !!document.getElementById('root'),
  articles: Math.min(document.querySelectorAll('article.reading-surface').length,100),
  frames: Math.min(document.querySelectorAll('iframe').length,100)
};
"""


def report_dom_state(session):
    try:
        value=qa.wd('POST',f'/session/{session}/execute/sync',{'script':DOM_DIAGNOSTIC_SCRIPT,'args':[]})
        require(isinstance(value,dict),'invalid diagnostic response')
        result={k:value[k][:limit] for k,limit in [('title',128),('location',256),('readyState',16),('body',512)] if isinstance(value.get(k),str)}
        result.update({k:value[k] for k in ['tauri','root'] if isinstance(value.get(k),bool)})
        result.update({k:min(max(value[k],0),100) for k in ['articles','frames'] if type(value.get(k)) is int})
        print('Bounded synthetic window state:',json.dumps(result))
    except Exception:
        print('Synthetic window-state diagnostic unavailable')


def windows_argv(command):
    require(isinstance(command,str) and 0<len(command)<=32768, 'invalid bounded command line')
    from ctypes import wintypes
    shell=ctypes.WinDLL('shell32',use_last_error=True)
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    shell.CommandLineToArgvW.argtypes=[wintypes.LPCWSTR,ctypes.POINTER(ctypes.c_int)]
    shell.CommandLineToArgvW.restype=ctypes.POINTER(wintypes.LPWSTR)
    kernel.LocalFree.argtypes=[wintypes.HLOCAL]; kernel.LocalFree.restype=wintypes.HLOCAL
    count=ctypes.c_int(); result=shell.CommandLineToArgvW(command,ctypes.byref(count))
    require(bool(result),'command line parsing failed')
    try:
        require(0<count.value<=128,'too many process arguments')
        return [result[i] for i in range(count.value)]
    finally: kernel.LocalFree(ctypes.cast(result,wintypes.HLOCAL))


def process_in_owned_job(pid):
    require(_JOB is not None and type(pid) is int and 0<pid<2**32,'invalid owned process')
    from ctypes import wintypes
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]; kernel.OpenProcess.restype=wintypes.HANDLE
    kernel.IsProcessInJob.argtypes=[wintypes.HANDLE,wintypes.HANDLE,ctypes.POINTER(wintypes.BOOL)]; kernel.IsProcessInJob.restype=wintypes.BOOL
    kernel.CloseHandle.argtypes=[wintypes.HANDLE]
    handle=kernel.OpenProcess(0x1000,False,pid)
    require(bool(handle),'cannot inspect owned process')
    try:
        member=wintypes.BOOL()
        require(kernel.IsProcessInJob(handle,_JOB,ctypes.byref(member)),'job membership query failed')
        return bool(member.value)
    finally: kernel.CloseHandle(handle)


def job_process_ids():
    # Explicit owned job, including child jobs; never enumerate the whole machine.
    from ctypes import wintypes as wt
    require(_JOB is not None, 'missing owned job')
    class Pids(ctypes.Structure):
        _fields_=[('assigned',wt.DWORD),('count',wt.DWORD),('ids',ctypes.c_size_t*256)]
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.QueryInformationJobObject.argtypes=[wt.HANDLE,ctypes.c_int,ctypes.c_void_p,wt.DWORD,ctypes.c_void_p]
    kernel.QueryInformationJobObject.restype=wt.BOOL
    result=Pids()
    require(kernel.QueryInformationJobObject(_JOB,3,ctypes.byref(result),ctypes.sizeof(result),None), 'owned process list unavailable')
    require(result.assigned==result.count and result.count<=256, 'owned process list truncated')
    return list(result.ids[:result.count])


def process_image(pid):
    from ctypes import wintypes as wt
    require(type(pid) is int and 0<pid<=0xffffffff, 'invalid owned process id')
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.argtypes=[wt.DWORD,wt.BOOL,wt.DWORD]; kernel.OpenProcess.restype=wt.HANDLE
    kernel.CloseHandle.argtypes=[wt.HANDLE]; kernel.CloseHandle.restype=wt.BOOL
    kernel.QueryFullProcessImageNameW.argtypes=[wt.HANDLE,wt.DWORD,wt.LPWSTR,ctypes.POINTER(wt.DWORD)]
    kernel.QueryFullProcessImageNameW.restype=wt.BOOL
    handle=kernel.OpenProcess(0x1000,False,pid)
    require(handle, 'owned process open failed')
    try:
        require(process_in_owned_job(pid), 'process left owned job')
        buffer=ctypes.create_unicode_buffer(32768); length=wt.DWORD(len(buffer))
        require(kernel.QueryFullProcessImageNameW(handle,0,buffer,ctypes.byref(length)), 'owned process image unavailable')
        return buffer.value
    finally: kernel.CloseHandle(handle)


def owned_app_processes(app):
    require(hash_file(app,64*1024**2)==EXE_HASH,'diagnostic app identity mismatch')
    return [pid for pid in job_process_ids() if os.path.normcase(process_image(pid))==os.path.normcase(str(app))]


class ProcessQueryUnavailable(ValueError):
    pass


def query_command_line(pid):
    require(type(pid) is int and 0<pid<=0xffffffff,'invalid process query id')
    # Only a previously verified owned PID (or our preflight self), never arbitrary WQL.
    script="Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:QA_PROCESS_ID) | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    shell, env = powershell_environment('QA_PROCESS_ID', str(pid))
    reason=None
    try:
        result=subprocess.run([str(shell),'-NoLogo','-NoProfile','-NonInteractive','-Command',script],env=env,capture_output=True,text=True,timeout=20,check=True)
        require(len(result.stdout)<=40000,'response size')
        row=json.loads(result.stdout)
        require(isinstance(row,dict) and row.get('ProcessId')==pid and isinstance(row.get('CommandLine'),str) and 0<len(row['CommandLine'])<=32768,'response shape')
        return row['CommandLine']
    except subprocess.TimeoutExpired: reason='timeout'
    except subprocess.CalledProcessError: reason='exit'
    except (OSError,subprocess.SubprocessError): reason='launch'
    except (ValueError,TypeError): reason='shape'
    raise ProcessQueryUnavailable('process query unavailable: '+reason) from None


def check_process_query():
    ready=False
    try: query_command_line(os.getpid()); ready=True
    except ProcessQueryUnavailable as error: print(str(error))
    print('Optional argv query available:',ready)
    output=os.environ.get('GITHUB_OUTPUT')
    require(bool(output),'missing workflow output')
    with open(output,'a',encoding='utf-8') as f: f.write('ready='+str(ready).lower()+'\n')


def argv_summary(args,fixture):
    tail=args[1:]; expected=str(fixture)
    return {'argument_count':len(tail),'fixture_exact_arg':expected in tail,
            'fixture_switch_arg':any(a in ('-'+expected,'--'+expected) for a in tail),
            'fixture_quoted_arg':('"'+expected+'"') in tail}


def report_app_argv(app,fixture):
    try:
        if os.environ.get('ARGV_QUERY_READY')!='true':
            print('Owned synthetic app argv diagnostic unavailable: preflight'); return
        rows=owned_app_processes(app)
        require(len(rows)==1,'expected one newly launched owned app')
        command=query_command_line(rows[0])
        require(rows==owned_app_processes(app),'owned app identity changed during query')
        print('Owned synthetic app argv:',json.dumps(argv_summary(windows_argv(command),fixture)))
    except ProcessQueryUnavailable as error:
        print(str(error))
    except Exception:
        print('Owned synthetic app argv diagnostic unavailable')


def clear_readonly_attribute(path,attributes):
    from ctypes import wintypes
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.SetFileAttributesW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD]
    kernel.SetFileAttributesW.restype=wintypes.BOOL
    require(kernel.SetFileAttributesW(str(path),attributes & ~1),'readonly attribute cleanup failed')


def validate_cleanup_root(root):
    # Only workflow-selected exclusive staging roots, never arbitrary supplied paths.
    artifact=stage(); driver=driver_stage()
    require((root==artifact and os.environ.get('STAGE_PATH')==str(root))
            or (root==driver and os.environ.get('DRIVER_STAGE_PATH')==str(root)), 'unowned cleanup root')
    safe_path(root)
    info=root.lstat()
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and not getattr(info,'st_file_attributes',0)&0x400,'unsafe cleanup root')


def remove_owned_tree(root):
    validate_cleanup_root(root)
    def failure(function,path,error):
        # Observe only a failed entry beneath our owned synthetic root. Never
        # follow a junction or change ACLs. Only the exact observed readonly DOS
        # bit on an owned regular file or directory may be cleared before one removal retry.
        try:
            relative=Path(path).relative_to(root)
            require(relative!=Path('.') and '..' not in relative.parts, 'cleanup path escaped owned root')
            root_info=root.lstat()
            require(stat.S_ISDIR(root_info.st_mode) and not stat.S_ISLNK(root_info.st_mode) and not getattr(root_info,'st_file_attributes',0)&0x400,'unsafe cleanup root')
            parent=root
            for part in relative.parts[:-1]:
                parent=parent/part
                ancestor=parent.lstat()
                require(not stat.S_ISLNK(ancestor.st_mode) and not getattr(ancestor,'st_file_attributes',0)&0x400, 'cleanup diagnostic refuses linked ancestor')
            info=Path(path).lstat()
            attributes=getattr(info,'st_file_attributes',0)
            print('Owned cleanup failure:',json.dumps({'relative':str(relative)[:256],
                'readonly':bool(attributes&1),'reparse':bool(attributes&0x400),
                'directory':stat.S_ISDIR(info.st_mode),'symlink':stat.S_ISLNK(info.st_mode),
                'winerror':getattr(error,'winerror',None)}))
            if (os.name=='nt' and function in (os.rmdir,os.unlink,os.remove)
                    and getattr(error,'winerror',None)==5 and attributes&1
                    and not attributes&0x400 and not stat.S_ISLNK(info.st_mode)
                    and (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))):
                clear_readonly_attribute(Path(path),attributes)
                function(path)  # One retry; any failure still fails cleanup.
                return
        except Exception:
            print('Owned cleanup attribute diagnostic unavailable')
        raise error
    shutil.rmtree(root,onexc=failure)


OPEN_SELECTOR='.welcome-actions button.btn-secondary'
ELEMENT_KEY='element-6066-11e4-a52e-4f735466cecf'


def ui_element_id(value):
    return isinstance(value,str) and value not in ('.','..') and re.fullmatch(r'[A-Za-z0-9_.-]{1,256}',value) is not None


def ui_webdriver(session, element=None):
    # Windows-only two exact operations; shared Linux route allowlist is unchanged.
    require(qa.session_id(session),'invalid UI session')
    if element is None:
        path=f'/session/{session}/elements'; payload={'using':'css selector','value':OPEN_SELECTOR}
    else:
        require(ui_element_id(element),'invalid UI element')
        path=f'/session/{session}/element/{element}/click'; payload={}
    request=urllib.request.Request('http://127.0.0.1:4444'+path,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'},method='POST')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs): return None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    with opener.open(request,timeout=10) as response:
        require(response.status==200,'UI WebDriver HTTP failure')
        data=response.read(65537); require(len(data)<=65536,'UI response too large')
        value=json.loads(data)['value']
    require(not isinstance(value,dict) or 'error' not in value,'UI WebDriver failed')
    return value


def uia_command(mode):
    require(mode in ('Preflight','Open'),'invalid UIA mode')
    shell=safe_path(Path(os.environ['SYSTEMROOT'])/'System32/WindowsPowerShell/v1.0/powershell.exe')
    return [str(shell),'-NoLogo','-NoProfile','-NonInteractive','-Mta','-File',str(ROOT/'scripts/native-qa-open-dialog.ps1'),'-Mode',mode]


def uia_environment():
    require(not os.environ.get('GH_TOKEN') and not os.environ.get('GITHUB_TOKEN'),'UIA must be token-free')
    return {k:v for k,v in os.environ.items() if k.upper() in {'SYSTEMROOT','WINDIR','PATH','TEMP','TMP'}}


def check_uia():
    try:
        result=subprocess.run(uia_command('Preflight'),env=uia_environment(),capture_output=True,text=True,timeout=45,check=True)
        require(len(result.stdout)<=8192 and len(result.stderr)<=8192,'UIA preflight output exceeded limit')
        require(result.stdout.strip()=='qa-uia-available','UIA preflight unavailable')
    except (OSError,subprocess.SubprocessError):
        raise ValueError('UIA preflight failed or timed out') from None
    print('UIA built-in assemblies available; native dialog not yet qualified.')


UIA_PHASES=re.compile(r'(?m)^qa-uia-failed:(assemblies|inputs|dialog|filename|confirm)$')
UIA_DETAIL=re.compile(r'(?m)^qa-uia-detail:([a-z][a-z-]{0,31})$')
UIA_DETAIL_KINDS={'pid','fixture','ready','image','window-count','unexpected-owner','ambiguous-dialog','dialog-unavailable','edit-count','ambiguous-filename','readonly','readback','ambiguous-open'}


def uia_failure(stderr):
    # Only the helper's fixed markers; the allowlisted reason never carries provider text.
    phases=UIA_PHASES.findall(stderr)
    details=[d for d in UIA_DETAIL.findall(stderr) if d in UIA_DETAIL_KINDS]
    return (phases[-1] if phases else None, details[-1] if details else None)


def dialog_observation(stderr):
    # Only the fixed diagnostic schema; malformed provider data is never printed.
    lines=[line[len('qa-uia-windows:'):] for line in stderr.splitlines() if line.startswith('qa-uia-windows:')]
    require(len(lines)==1 and len(lines[0])<=4096,'UIA observation unavailable')
    value=json.loads(lines[0])
    require(isinstance(value,dict) and set(value)=={'stage','reason','count','overflow','windows'},'invalid observation fields')
    require(value['reason'] in ('provider-error','count-overflow','ownership','ambiguous','not-found'),'invalid observation reason')
    require(value['stage'] in ('not-started','query','inspect','select','wait'),'invalid observation stage')
    require(type(value['count']) is int and 0<=value['count']<=8 and type(value['overflow']) is bool,'invalid observation count')
    require(isinstance(value['windows'],list) and len(value['windows'])<=value['count'],'invalid observation windows')
    for window in value['windows']:
        require(isinstance(window,dict) and set(window)=={'class','pattern','modal','enabled'},'invalid window fields')
        require(isinstance(window['class'],str) and re.fullmatch(r'[A-Za-z0-9_#.: -]{1,64}',window['class']) is not None,'invalid window class')
        require(type(window['pattern']) is bool and type(window['enabled']) is bool and (window['modal'] is None or type(window['modal']) is bool),'invalid window flags')
    return value


def real_open_file(session, app, fixture, work):
    require(fixture==work/'native-smoke.md' and fixture.is_file(),'unexpected UI fixture')
    safe_path(fixture)
    rows=owned_app_processes(app); require(len(rows)==1,'UI requires one owned app')
    elements=ui_webdriver(session)
    require(isinstance(elements,list) and len(elements)==1 and isinstance(elements[0],dict),'ambiguous Open button')
    element=elements[0].get(ELEMENT_KEY); require(ui_element_id(element),'invalid Open element')
    ready=work/'uia-ready'; require(not ready.exists(),'UIA ready collision')
    env=uia_environment(); env.update(QA_UIA_PID=str(rows[0]),QA_UIA_APP=str(app),QA_UIA_FIXTURE=str(fixture),QA_UIA_READY=str(ready))
    started=time.monotonic()
    proc=subprocess.Popen(uia_command('Open'),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        while not ready.exists():
            require(proc.poll() is None,'UIA helper exited before ready')
            require(time.monotonic()-started<30,'UIA helper readiness timeout'); time.sleep(.1)
        safe_path(ready); require(ready.is_file() and ready.stat().st_size==0,'invalid UIA readiness marker')
        require(rows==owned_app_processes(app),'UI app identity changed')
        ui_webdriver(session,element)  # Normal user-facing WebDriver click, never JS/IPC.
        out,err=proc.communicate(timeout=max(.1,60-(time.monotonic()-started)))
        require(len(out)<=8192 and len(err)<=8192,'UIA helper output exceeded limit')
        if proc.returncode!=0:
            phase,detail=uia_failure(err)
            print('UIA dialog unavailable phase:',(phase or 'unknown')+(f' ({detail})' if detail else ''))
            if phase=='dialog':
                try: print('Owned UIA window observation:',json.dumps(dialog_observation(err)))
                except (ValueError,TypeError): print('Owned UIA window observation unavailable')
        require(proc.returncode==0 and out.strip()=='qa-uia-open-invoked','native Open dialog failed')
    except subprocess.TimeoutExpired:
        raise ValueError('native Open dialog timeout') from None
    finally:
        if proc.poll() is None: proc.kill()
        proc.communicate(timeout=5)


def wait_native_document(session, seconds=60):
    until=time.monotonic()+seconds
    while True:
        value=qa.wd('POST',f'/session/{session}/execute/sync',{'script':qa.DOM_SCRIPT,'args':[]})
        if qa.oracle(value): return True
        if time.monotonic()>=until:
            report_dom_state(session); return False
        time.sleep(.3)


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
        require(not owned_app_processes(app),'installer unexpectedly left an app process running')
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
                report_app_argv(app,fixture)
                cli_pass=wait_native_document(session)
                print('CLI startup fixture result:', 'PASS' if cli_pass else 'FAIL (welcome/document mismatch; argv delivery unproven)')
                print('Native scenario results:',json.dumps({'cli_startup':'pass' if cli_pass else 'fail','real_open_ui':'not_run' if cli_pass else 'pending'}))
                if not cli_pass:
                    real_open_file(session,app,fixture,work)
                    require(wait_native_document(session),'native UI-open DOM fixture mismatch')
                    print('PASS: distinct real Open-file UI scenario matched original native Unicode DOM. CLI startup remains failed.')
                require(fixture.read_text(encoding='utf-8')==f'# {qa.HEADING}\n\nNative WebView Unicode: café 日本語.\n','fixture changed')
                with (work/'scenario-results.json').open('x',encoding='utf-8') as receipt:
                    results={'cli_startup':'pass' if cli_pass else 'fail','real_open_ui':'not_run' if cli_pass else 'pass'}
                    json.dump(results,receipt)
                    print('Native scenario results:',json.dumps(results))
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
    if os.environ.get('DRIVER_STAGE_PATH'):
        root=driver_stage()
        require(os.environ['DRIVER_STAGE_PATH']==str(root), 'unexpected driver cleanup path')
        if root.exists(): remove_owned_tree(root)
    if not os.environ.get('STAGE_PATH'): return
    work=selected()
    if (work/'install-attempted').exists(): run_worker('--uninstall-worker',90)
    remove_owned_tree(work)


def main():
    require(os.name=='nt','Windows runner required')
    require(len(sys.argv)==2,'expected one fixed phase')
    mode=sys.argv[1]
    if mode=='--check-driver': driver_path(provision=True)
    elif mode=='--check-process-query': check_process_query()
    elif mode=='--check-uia': check_uia()
    elif mode=='--prepare': prepare()
    elif mode=='--probe': run_worker('--worker',300)
    elif mode=='--worker': worker()
    elif mode=='--uninstall-worker': enter_owned_job(); uninstall(prepared())
    elif mode=='--cleanup': cleanup()
    else: raise ValueError('unsupported phase')

if __name__=='__main__': main()
