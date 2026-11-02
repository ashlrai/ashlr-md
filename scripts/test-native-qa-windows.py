#!/usr/bin/env python3
from contextlib import contextmanager
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch
import zipfile

SCRIPT=Path(__file__).with_name('native-qa-windows.py').resolve()
spec=importlib.util.spec_from_file_location('windows_qa',SCRIPT)
w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)

@contextmanager
def canonical_tempdir(**kwargs):
    # Only our newly created test-owned directory is canonicalized. The production
    # validator continues to reject noncanonical paths and all reparse points.
    with tempfile.TemporaryDirectory(**kwargs) as raw:
        yield str(Path(raw).resolve())


class Tests(unittest.TestCase):
    def test_runtime_guard_still_rejects_relative_parent_and_reparse_paths(self):
        from types import SimpleNamespace
        with canonical_tempdir() as t:
            root=Path(t); parent=root/'junction'; parent.mkdir(); target=parent/'missing'
            with self.assertRaises(ValueError): w.safe_path(Path('relative'))
            with self.assertRaises(ValueError): w.safe_path(root/'..'/'outside')
            lstat=type(parent).lstat
            def reparse(path,*args,**kwargs):
                info=lstat(path,*args,**kwargs)
                return SimpleNamespace(st_mode=info.st_mode,st_file_attributes=0x400) if path==parent else info
            with patch.object(type(parent),'lstat',reparse):
                with self.assertRaisesRegex(ValueError,'reparse'): w.safe_path(target)

    @unittest.skipIf(os.name=='nt','does not request Windows symlink privileges')
    def test_runtime_guard_rejects_actual_symlink_and_dangling_link(self):
        with canonical_tempdir() as t:
            root=Path(t); real=root/'real'; real.mkdir(); link=root/'link'; link.symlink_to(real,target_is_directory=True)
            dangling=root/'dangling'; dangling.symlink_to(root/'absent')
            for path in (link/'missing',dangling):
                with self.assertRaises(ValueError): w.safe_path(path)

    @unittest.skipUnless(os.name=='nt','requires actual Windows temporary paths')
    def test_windows_path_spelling_diagnostic_and_strict_production_root(self):
        # These are synthetic fixture/hosted-runner temporary paths, not user files.
        with tempfile.TemporaryDirectory(prefix='native qa path ') as raw:
            original=Path(raw); canonical=original.resolve()
            print('Synthetic Windows path spelling:',json.dumps({'original':str(original),'canonical':str(canonical),'same_file':original.samefile(canonical)}))
            self.assertEqual(w.safe_path(canonical),canonical)
            if original != canonical:
                with self.assertRaises(ValueError): w.safe_path(original)
        runner=os.environ.get('RUNNER_TEMP')
        if runner:
            original=Path(runner); canonical=original.resolve()
            print('Hosted RUNNER_TEMP spelling:',json.dumps({'original':str(original),'canonical':str(canonical),'canonical_equal':original==canonical}))
            self.assertEqual(w.safe_path(original),original)

    def test_environment_filters_credentials_and_overrides(self):
        with canonical_tempdir() as t:
            with patch.dict(os.environ,{'GH_TOKEN':'secret','GITHUB_TOKEN':'secret','ANTHROPIC_API_KEY':'secret','HTTP_PROXY':'bad','OLLAMA_HOST':'bad','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':'bad','PATH':'trusted','SYSTEMROOT':'C:\\Windows','RUNNER_TEMP':t},clear=True):
                env=w.native_env(Path(t))
                self.assertEqual(set(env),{'PATH','SYSTEMROOT','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','RUNNER_TEMP','STAGE_PATH'})
                self.assertNotIn('secret',env.values())
                self.assertTrue(Path(env['APPDATA']).is_dir())

    def test_stage_fixed_and_collision_rejected(self):
        with canonical_tempdir() as t:
            root=Path(t)
            with patch.dict(os.environ,{'RUNNER_TEMP':t},clear=True):
                self.assertEqual(w.stage(),root/w.STAGE)
                with self.assertRaises(ValueError): w.selected()
                work=root/w.STAGE; work.mkdir(); (work/'sentinel').write_text('keep')
                with patch.dict(os.environ,{'GH_TOKEN':'synthetic'}):
                    with self.assertRaises(FileExistsError): w.prepare()
                self.assertEqual((work/'sentinel').read_text(),'keep')
                w.cleanup(); self.assertTrue(work.exists())
            with patch.dict(os.environ,{'RUNNER_TEMP':'relative'},clear=True):
                with self.assertRaises(ValueError): w.stage()

    def test_nsis_final_operand_not_quoted_or_crc_bypassed(self):
        with canonical_tempdir(prefix='spaces here ') as t:
            root=Path(t); exe=root/'setup.exe'; exe.touch(); dest=root/'installed app'
            command=w.nsis_command(exe,dest)
            self.assertTrue(command.endswith(' /D='+str(dest)))
            self.assertIn(' /S /NS ',command)
            self.assertNotIn('/NCRC',command)
            command=w.nsis_command(exe,dest,True)
            self.assertTrue(command.endswith(' _?='+str(dest)))
            self.assertNotIn('/NS',command)

    def test_original_zip_members_fail_closed(self):
        for mode in ('duplicate','symlink','wrong-hash','missing'):
            with canonical_tempdir() as t:
                root=Path(t); archive=root/'original.zip'
                with zipfile.ZipFile(archive,'w') as z:
                    if mode!='missing':
                        info=zipfile.ZipInfo(w.MEMBER)
                        if mode=='symlink': info.external_attr=0o120777<<16
                        z.writestr(info,b'synthetic')
                        z.writestr(w.MEMBER+'.sig',b'signature')
                        if mode=='duplicate': z.writestr(w.MEMBER,b'duplicate')
                with self.assertRaises(ValueError): w.select_installer(archive,root)

    def test_prepared_rejects_token_and_wrong_marker(self):
        with canonical_tempdir() as t:
            with patch.dict(os.environ,{'GH_TOKEN':'synthetic'},clear=True):
                with self.assertRaises(ValueError): w.prepared()
            root=Path(t)
            (root/'qualified.json').write_text('{}')
            with patch.dict(os.environ,{},clear=True), patch.object(w,'selected',return_value=root):
                with self.assertRaises(ValueError): w.prepared()

    def test_prepare_scoped_api_signature_and_no_native_execution(self):
        prov=MagicMock(REPO='/repos/ashlrai/ashlr-md',LEGS=('bundle-windows-latest',))
        prov.pages.return_value=[{'id':13105824003,'name':'bundle-windows-latest','expired':False,'workflow_run':{'head_sha':w.qa.SHA}}]
        prov.exactly.side_effect=lambda values,label:values[0]
        prov.verify_provenance.return_value={'public_key':'synthetic-key'}
        api=MagicMock(return_value={'tag_name':'v0.4.0','prerelease':False})
        opener=MagicMock(); opener.open.return_value=io.BytesIO(b'{"version":"0.4.0"}')
        with canonical_tempdir() as t:
            root=Path(t); output=root/'out'; output.touch()
            def signature(*args,**kwargs):
                self.assertNotIn('GH_TOKEN',os.environ)
                self.assertTrue(args[0][0].endswith('release-signature-check.exe'))
            with patch.dict(os.environ,{'RUNNER_TEMP':t,'GITHUB_OUTPUT':str(output),'GH_TOKEN':'synthetic'},clear=True), patch.object(w.qa,'module',return_value=prov), patch.object(w.qa,'metadata_fetcher',return_value=api), patch.object(w.qa,'download_zip'), patch.object(w,'select_installer'), patch.object(w.qa,'plain_opener',return_value=opener), patch.object(w.subprocess,'run',side_effect=signature) as run:
                w.prepare()
                self.assertEqual(run.call_count,1)
                self.assertIs(prov.verify_provenance.call_args.args[0],api)
                self.assertNotIn('synthetic',(root/w.STAGE/'qualified.json').read_text())

    def test_owned_worker_boundary_precedes_install(self):
        with patch.object(w,'enter_owned_job',side_effect=ValueError('job unavailable')), patch.object(w.subprocess,'run') as run:
            with self.assertRaises(ValueError): w.worker()
            run.assert_not_called()

    def test_worker_has_hard_timeout_and_scrubbed_env(self):
        with canonical_tempdir() as t, patch.object(w,'prepared',return_value=Path(t)), patch.object(w,'native_env',return_value={'PATH':'trusted'}), patch.object(w.subprocess,'run',side_effect=subprocess.TimeoutExpired('worker',300)) as run:
            with self.assertRaises(subprocess.TimeoutExpired): w.run_worker('--worker',300)
            self.assertEqual(run.call_args.kwargs,{'env':{'PATH':'trusted'},'check':True,'timeout':300})
            self.assertEqual(run.call_args.args[0][-1],'--worker')

    def test_cleanup_does_not_erase_failed_uninstall_evidence(self):
        with canonical_tempdir() as t:
            root=Path(t); (root/'install-attempted').touch()
            with patch.dict(os.environ,{'STAGE_PATH':t}), patch.object(w,'selected',return_value=root), patch.object(w,'run_worker',side_effect=ValueError('uninstall failed')), patch.object(w.shutil,'rmtree') as remove:
                with self.assertRaises(ValueError): w.cleanup()
                remove.assert_not_called()

    def test_uninstall_missing_binary_checks_partial_install(self):
        with canonical_tempdir() as t:
            root=Path(t); (root/'install-attempted').touch(); (root/'installed').mkdir(); (root/'installed'/'md-opener.exe').touch()
            with patch.object(w,'no_existing_install'):
                with self.assertRaisesRegex(ValueError,'partial installation'): w.uninstall(root)

    def test_successful_uninstall_is_not_executed_twice(self):
        with canonical_tempdir() as t:
            root=Path(t); (root/'install-attempted').touch(); (root/'installed').mkdir(); (root/'installed'/'uninstall.exe').touch()
            with patch.object(w,'no_existing_install'), patch.object(w.subprocess,'run') as run:
                w.uninstall(root); w.uninstall(root)
                self.assertEqual(run.call_count,1)
                self.assertTrue((root/'uninstall-complete').is_file())

    def test_driver_requires_machine_runtime_and_exact_build_match(self):
        import types
        fake=types.SimpleNamespace(HKEY_LOCAL_MACHINE=1)
        with canonical_tempdir() as t:
            root=Path(t); (root/'msedgedriver.exe').touch()
            with patch.dict(sys.modules,{'winreg':fake}), patch.dict(os.environ,{'EDGEWEBDRIVER':t}), patch.object(w,'reg_value',return_value='156.0.1234.5'), patch.object(w.subprocess,'run',return_value=MagicMock(stdout='Microsoft Edge WebDriver 156.0.1234.9')):
                self.assertEqual(w.driver_path(),root/'msedgedriver.exe')
            for runtime,driver in [(None,'156.0.1234.5'),('0.0.0.0','156.0.1234.5'),('156.0.1234.5','156.0.9999.5')]:
                with patch.dict(sys.modules,{'winreg':fake}), patch.dict(os.environ,{'EDGEWEBDRIVER':t}), patch.object(w,'reg_value',return_value=runtime), patch.object(w.subprocess,'run',return_value=MagicMock(stdout='Microsoft Edge WebDriver '+driver)):
                    with self.assertRaises(ValueError): w.driver_path()

    def test_preexisting_install_refused_before_installer(self):
        import types
        fake=types.SimpleNamespace(HKEY_CURRENT_USER=1,HKEY_LOCAL_MACHINE=2,KEY_READ=1,KEY_WOW64_64KEY=2,OpenKey=MagicMock())
        with patch.dict(sys.modules,{'winreg':fake}):
            with self.assertRaisesRegex(ValueError,'pre-existing'): w.no_existing_install()
        with patch.object(w,'enter_owned_job'), patch.object(w,'prepared',return_value=Path('/synthetic')), patch.object(w,'driver_path'), patch.object(w,'no_existing_install',side_effect=ValueError('pre-existing')), patch.object(w.subprocess,'run') as run:
            with self.assertRaises(ValueError): w.worker()
            run.assert_not_called()

    def test_signature_failure_cannot_write_qualification_marker(self):
        prov=MagicMock(REPO='/repos/ashlrai/ashlr-md',LEGS=('bundle-windows-latest',))
        prov.pages.return_value=[{'id':13105824003,'name':'bundle-windows-latest','expired':False,'workflow_run':{'head_sha':w.qa.SHA}}]
        prov.exactly.side_effect=lambda values,label:values[0]
        prov.verify_provenance.return_value={'public_key':'synthetic-key'}
        api=MagicMock(return_value={'tag_name':'v0.4.0','prerelease':False})
        opener=MagicMock(); opener.open.return_value=io.BytesIO(b'{"version":"0.4.0"}')
        with canonical_tempdir() as t:
            root=Path(t); output=root/'out'; output.touch()
            with patch.dict(os.environ,{'RUNNER_TEMP':t,'GITHUB_OUTPUT':str(output),'GH_TOKEN':'synthetic'},clear=True), patch.object(w.qa,'module',return_value=prov), patch.object(w.qa,'metadata_fetcher',return_value=api), patch.object(w.qa,'download_zip'), patch.object(w,'select_installer'), patch.object(w.qa,'plain_opener',return_value=opener), patch.object(w.subprocess,'run',side_effect=subprocess.CalledProcessError(1,'verifier')):
                with self.assertRaises(subprocess.CalledProcessError): w.prepare()
                self.assertFalse((root/w.STAGE/'qualified.json').exists())
                self.assertEqual(output.read_text(),f'stage={root/w.STAGE}\n')

    @unittest.skipUnless(os.name=='nt','requires actual Windows Job Objects')
    def test_windows_job_kills_child_and_grandchild_on_worker_timeout(self):
        import ctypes
        from ctypes import wintypes
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]; kernel.OpenProcess.restype=wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD]
        kernel.CloseHandle.argtypes=[wintypes.HANDLE]
        with canonical_tempdir() as t:
            receipt=Path(t)/'pids.json'
            child='import subprocess,sys,time,json,os; p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"]); open('+repr(str(receipt)+'.tmp')+',"w").write(json.dumps([os.getpid(),p.pid])); os.replace('+repr(str(receipt)+'.tmp')+','+repr(str(receipt))+'); time.sleep(60)'
            worker='import importlib.util,subprocess,sys,time; s=importlib.util.spec_from_file_location("qa",'+repr(str(SCRIPT))+'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.enter_owned_job(); subprocess.Popen([sys.executable,"-c",'+repr(child)+']); time.sleep(60)'
            proc=subprocess.Popen([sys.executable,'-c',worker])
            handles=[]
            try:
                until=time.monotonic()+10
                while not receipt.exists():
                    self.assertIsNone(proc.poll()); self.assertLess(time.monotonic(),until); time.sleep(.05)
                for pid in json.loads(receipt.read_text()):
                    handle=kernel.OpenProcess(0x00100000,False,pid); self.assertTrue(handle); handles.append(handle)
                proc.kill(); proc.wait(timeout=5)
                for handle in handles: self.assertEqual(kernel.WaitForSingleObject(handle,5000),0)
            finally:
                if proc.poll() is None: proc.kill(); proc.wait(timeout=5)
                for handle in handles: kernel.CloseHandle(handle)

if __name__=='__main__': unittest.main()
