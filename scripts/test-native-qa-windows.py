#!/usr/bin/env python3
from contextlib import contextmanager
import importlib.util
import io
import json
import os
from pathlib import Path
import re
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
    def remove_callback_tree(self, root):
        with patch.object(w,'validate_cleanup_root'):
            return w.remove_owned_tree(root)

    def test_cleanup_accepts_only_selected_fixed_nonreparse_roots(self):
        with canonical_tempdir() as t:
            parent=Path(t); artifact=parent/w.STAGE; driver=parent/w.DRIVER_STAGE
            artifact.mkdir(); driver.mkdir(); other=parent/'other'; other.mkdir()
            with patch.dict(os.environ,{'RUNNER_TEMP':str(parent),'STAGE_PATH':str(artifact),'DRIVER_STAGE_PATH':str(driver)}):
                w.validate_cleanup_root(artifact); w.validate_cleanup_root(driver)
                with self.assertRaises(ValueError): w.validate_cleanup_root(other)
                with patch.dict(os.environ,{'STAGE_PATH':'wrong'}):
                    with self.assertRaises(ValueError): w.validate_cleanup_root(artifact)
                with patch.object(w,'safe_path',side_effect=ValueError('link')):
                    with self.assertRaises(ValueError): w.validate_cleanup_root(artifact)
            with patch.object(w,'validate_cleanup_root',side_effect=ValueError('unowned')), patch.object(w.shutil,'rmtree') as remove:
                with self.assertRaises(ValueError): w.remove_owned_tree(other)
                remove.assert_not_called()

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

    def test_ui_routes_are_exact_bounded_and_do_not_follow_redirects(self):
        response=MagicMock(); response.__enter__.return_value=response; response.status=200; response.read.return_value=b'{"value":null}'
        opener=MagicMock(); opener.open.return_value=response
        with patch.object(w.urllib.request,'build_opener',return_value=opener) as build:
            w.ui_webdriver('safe-session')
            request=opener.open.call_args.args[0]
            self.assertEqual(request.full_url,'http://127.0.0.1:4444/session/safe-session/elements')
            self.assertEqual(json.loads(request.data),{'using':'css selector','value':w.OPEN_SELECTOR})
            self.assertEqual(request.method,'POST'); self.assertEqual(opener.open.call_args.kwargs,{'timeout':10})
            handlers=build.call_args.args; self.assertEqual(handlers[0].proxies,{})
            self.assertIsNone(handlers[1].redirect_request(None,None,None,None,None,None))
            w.ui_webdriver('safe-session','f.123-d_0')
            self.assertTrue(opener.open.call_args.args[0].full_url.endswith('/element/f.123-d_0/click'))
            for session,element in [('bad/route','good'),('safe','../other'),('safe','.'),('safe','..'),('safe','a?b'),('safe','é'),('safe','a'*257)]:
                opener.open.reset_mock()
                with self.assertRaises(ValueError): w.ui_webdriver(session,element)
                opener.open.assert_not_called()
            response.read.return_value=b'x'*65537
            with self.assertRaises(ValueError): w.ui_webdriver('safe')

    def test_uia_preflight_is_token_free_and_sanitizes_errors(self):
        with canonical_tempdir() as t:
            with patch.dict(os.environ,{'SYSTEMROOT':t},clear=True), patch.object(w.subprocess,'run',return_value=MagicMock(stdout='qa-uia-available\n',stderr='')) as run:
                w.check_uia(); self.assertEqual(run.call_args.kwargs['timeout'],45)
                self.assertNotIn('GH_TOKEN',run.call_args.kwargs['env'])
                self.assertEqual(run.call_args.args[0][-2:],['-Mode','Preflight'])
            with patch.dict(os.environ,{'SYSTEMROOT':t,'GH_TOKEN':'secret'},clear=True), patch.object(w.subprocess,'run') as run:
                with self.assertRaises(ValueError): w.check_uia()
                run.assert_not_called()
            error=subprocess.CalledProcessError(1,'secret',output='secret',stderr='secret')
            with patch.dict(os.environ,{'SYSTEMROOT':t},clear=True), patch.object(w.subprocess,'run',side_effect=error):
                with self.assertRaisesRegex(ValueError,'UIA preflight failed'): w.check_uia()
        workflow=(SCRIPT.parents[1]/'.github/workflows/native-qa-windows.yml').read_text()
        self.assertLess(workflow.index('--check-uia'),workflow.index('Prepare and verify original artifacts'))

    def test_real_open_requires_unique_owned_app_and_button_before_spawn(self):
        with canonical_tempdir() as t:
            work=Path(t); fixture=work/'native-smoke.md'; fixture.touch()
            for rows,elements in [([],[]),([1,2],[]),([1],[]),([1],[{w.ELEMENT_KEY:'one'},{w.ELEMENT_KEY:'two'}]),([1],[{w.ELEMENT_KEY:'../bad'}])]:
                with patch.object(w,'owned_app_processes',return_value=rows), patch.object(w,'ui_webdriver',return_value=elements), patch.object(w.subprocess,'Popen') as spawn:
                    with self.assertRaises(ValueError): w.real_open_file('session',work/'app',fixture,work)
                    spawn.assert_not_called()

    def test_real_open_helper_readiness_identity_click_and_cleanup(self):
        with canonical_tempdir() as t:
            work=Path(t); fixture=work/'native-smoke.md'; fixture.touch(); app=work/'app'
            for changed in [False,True]:
                proc=MagicMock(); proc.poll.return_value=None; proc.returncode=0; proc.communicate.return_value=('qa-uia-open-invoked\n','')
                def spawn(*args,**kwargs):
                    self.assertNotIn('GH_TOKEN',kwargs['env']); self.assertEqual(kwargs['env']['QA_UIA_FIXTURE'],str(fixture))
                    (work/'uia-ready').touch(); return proc
                with patch.object(w,'owned_app_processes',side_effect=[[123],[] if changed else [123]]), patch.object(w,'ui_webdriver',return_value=[{w.ELEMENT_KEY:'one'}]) as wd, patch.object(w,'uia_environment',return_value={}), patch.object(w,'uia_command',return_value=['fixed']), patch.object(w.subprocess,'Popen',side_effect=spawn):
                    if changed:
                        with self.assertRaises(ValueError): w.real_open_file('session',app,fixture,work)
                        self.assertEqual(wd.call_count,1)
                    else:
                        w.real_open_file('session',app,fixture,work); self.assertEqual(wd.call_args.args,('session','one'))
                    proc.kill.assert_called_once(); self.assertGreaterEqual(proc.communicate.call_count,1)
                (work/'uia-ready').unlink()

    def test_real_open_timeout_kills_helper_without_disclosing_output(self):
        with canonical_tempdir() as t:
            work=Path(t); fixture=work/'native-smoke.md'; fixture.touch()
            proc=MagicMock(); proc.poll.return_value=None
            proc.communicate.side_effect=[subprocess.TimeoutExpired('secret-command',60,output='secret-output'),('','')]
            def spawn(*args,**kwargs): (work/'uia-ready').touch(); return proc
            with patch.object(w,'owned_app_processes',return_value=[123]), patch.object(w,'ui_webdriver',return_value=[{w.ELEMENT_KEY:'one'}]), patch.object(w,'uia_environment',return_value={}), patch.object(w,'uia_command',return_value=['fixed']), patch.object(w.subprocess,'Popen',side_effect=spawn):
                with self.assertRaisesRegex(ValueError,'native Open dialog timeout'): w.real_open_file('session',work/'app',fixture,work)
                proc.kill.assert_called_once(); self.assertEqual(proc.communicate.call_count,2)

    def test_dialog_observation_schema_bounds_and_private_fields_rejected(self):
        valid={'stage':'wait','reason':'not-found','count':1,'overflow':False,'windows':[{'class':'#32770','pattern':True,'modal':False,'enabled':True}]}
        encode=lambda value: 'qa-uia-windows:'+json.dumps(value)
        self.assertEqual(w.dialog_observation(encode(valid)),valid)
        import copy
        variants=[]
        for key,value in [('title','private'),('stage','private'),('reason','private'),('count',9),('count',True),('overflow',1),('windows',[{}]*9)]:
            item=copy.deepcopy(valid); item[key]=value; variants.append(item)
        for key,value in [('title','private'),('class','a'*65),('class','secret\ntext'),('pattern',1),('modal','private'),('enabled',None)]:
            item=copy.deepcopy(valid); item['windows'][0][key]=value; variants.append(item)
        for item in variants:
            with self.assertRaises(ValueError): w.dialog_observation(encode(item))
        for text in ['',encode(valid)+'\n'+encode(valid),'qa-uia-windows:'+'x'*4097]:
            with self.assertRaises(ValueError): w.dialog_observation(text)
        script=(SCRIPT.parent/'native-qa-open-dialog.ps1').read_text()
        self.assertIn("$window.Current.ProcessId -ne $targetPid",script)
        self.assertIn("$dialogReason='not-found'",script)
        self.assertIn("$dialogReason = 'provider-error'",script)
        self.assertNotIn('$window.Current.Name',script)
        self.assertNotIn('$window.Current.AutomationId',script)

    def test_ui_script_is_scoped_and_uses_only_real_control_patterns(self):
        script=(SCRIPT.parent/'native-qa-open-dialog.ps1').read_text()
        self.assertIn('RootElement.FindAll([Windows.Automation.TreeScope]::Children, $condition)',script)
        self.assertNotIn('RootElement.FindAll([Windows.Automation.TreeScope]::Descendants',script)
        for guard in ['$candidates.Count -ne 1','$buttons.Count -ne 1','$value.Current.IsReadOnly','$value.Current.Value -cne $fixture',"ClassName -ceq '#32770'",'$dialog.Current.ProcessId -ne $targetPid']:
            self.assertIn(guard,script)
        self.assertNotIn('$window.GetCurrentPattern',script)
        self.assertNotIn('$pattern.Current.IsModal',script)
        self.assertIn("ClassName -ceq '#32770' -and $window.Current.IsEnabled",script)
        self.assertIn('$value.SetValue($fixture)',script); self.assertIn('$invoke.Invoke()',script)
        for forbidden in ['SendKeys','SendInput','ExecutionPolicy','__TAURI','Get-CimInstance']:
            self.assertNotIn(forbidden,script)
        self.assertIn('qa-uia-detail:',script)
        self.assertIn('$fixedViolations -contains $_.Exception.Message',script)
        emitted=set(re.findall(r"'([a-z-]+)'",re.search(r'\$detailReasons = @\(([^)]*)\)',script).group(1)))
        self.assertEqual(emitted,w.UIA_DETAIL_KINDS)
        self.assertIn("'CLI startup fixture result:'",SCRIPT.read_text())
        self.assertIn('CLI startup remains failed.',SCRIPT.read_text())

    def test_uia_failure_label_uses_only_fixed_markers(self):
        for stderr,expected in [('qa-uia-failed:filename\nqa-uia-detail:readonly\n',('filename','readonly')),
                                ('qa-uia-detail:dialog-unavailable\nqa-uia-failed:dialog\n',('dialog','dialog-unavailable')),
                                ('qa-uia-failed:dialog\n',('dialog',None)),
                                ('qa-uia-detail:pid\n',(None,'pid')),
                                ('',(None,None)),
                                ('qa-uia-detail:secret-provider-text\nqa-uia-failed:confirm\n',('confirm',None)),
                                ('qa-uia-detail:PID\nqa-uia-failed:inputs\n',('inputs',None)),
                                ('qa-uia-detail:'+'x'*40+'\nqa-uia-failed:inputs\n',('inputs',None))]:
            self.assertEqual(w.uia_failure(stderr),expected)

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

    def test_driver_mismatch_reports_only_validated_versions(self):
        import types
        fake=types.SimpleNamespace(HKEY_LOCAL_MACHINE=1)
        with canonical_tempdir() as t:
            (Path(t)/'msedgedriver.exe').touch()
            for raw,expected in [
                ('Microsoft Edge WebDriver 156.0.9999.5', 'WebView2 156.0.1234.5; Edge driver 156.0.9999.5\n'),
                ('malformed synthetic-private-output', ''),
            ]:
                output=io.StringIO()
                with patch.dict(sys.modules,{'winreg':fake}), patch.dict(os.environ,{'EDGEWEBDRIVER':t}), patch.object(w,'reg_value',return_value='156.0.1234.5'), patch.object(w.subprocess,'run',return_value=MagicMock(stdout=raw)), patch('sys.stdout',output):
                    with self.assertRaises(ValueError): w.driver_path()
                self.assertEqual(output.getvalue(),expected)
                self.assertNotIn('synthetic-private-output',output.getvalue())

    def test_check_driver_phase_cannot_prepare_or_install(self):
        for failure in [None,ValueError('mismatch')]:
            with patch.object(w.os,'name','nt'), patch.object(w.sys,'argv',['native-qa-windows.py','--check-driver']), patch.object(w,'driver_path',side_effect=failure) as driver, patch.object(w,'prepare') as prepare, patch.object(w,'prepared') as prepared, patch.object(w,'worker') as worker, patch.object(w,'run_worker') as run_worker, patch.object(w.subprocess,'run') as run:
                if failure:
                    with self.assertRaisesRegex(ValueError,'mismatch'): w.main()
                else: w.main()
                driver.assert_called_once_with(provision=True)
                for untouched in [prepare,prepared,worker,run_worker,run]: untouched.assert_not_called()
        workflow=(SCRIPT.parents[1]/'.github/workflows/native-qa-windows.yml').read_text()
        check=workflow.index('      - name: Check installed WebView2')
        build=workflow.index('      - name: Check optional process argv')
        self.assertLess(build,workflow.index('      - name: Prepare and verify original artifacts'))
        self.assertIn('ARGV_QUERY_READY: ${{ steps.process_query.outputs.ready }}',workflow)
        prepare=workflow.index('      - name: Prepare and verify original artifacts')
        self.assertLess(check,build); self.assertLess(build,prepare)
        self.assertEqual(workflow[check:build], '      - name: Check installed WebView2 and Edge driver compatibility\n        id: driver\n        timeout-minutes: 2\n        run: python scripts/native-qa-windows.py --check-driver\n')

    def test_pinned_driver_rejects_unknown_runtime_and_tokens_before_io(self):
        with patch.object(w,'driver_stage') as stage, patch.object(w.urllib.request,'build_opener') as network:
            for runtime,env in [('132.0.2903.86',{}),('131.0.2903.86',{'GH_TOKEN':'synthetic'})]:
                with patch.dict(os.environ,env,clear=True), self.assertRaises(ValueError): w.pinned_driver(runtime,True)
            stage.assert_not_called(); network.assert_not_called()

    def test_pinned_driver_reuse_checks_hash_then_signature_without_download(self):
        with canonical_tempdir() as t:
            root=Path(t); exe=root/'msedgedriver.exe'; exe.touch()
            with patch.object(w,'driver_stage',return_value=root), patch.object(w,'hash_file',return_value=w.DRIVER_EXE_HASH), patch.object(w,'verify_driver_signature') as signature, patch.object(w.urllib.request,'build_opener') as network, patch.dict(os.environ,{},clear=True):
                self.assertEqual(w.pinned_driver('131.0.2903.86'),exe)
                signature.assert_called_once_with(exe); network.assert_not_called()
            with patch.object(w,'driver_stage',return_value=root), patch.object(w,'hash_file',return_value='bad'), patch.object(w,'verify_driver_signature') as signature, patch.dict(os.environ,{},clear=True):
                with self.assertRaises(ValueError): w.pinned_driver('131.0.2903.86')
                signature.assert_not_called()

    def test_pinned_driver_archive_rejects_bad_hash_and_traversal(self):
        import hashlib
        with canonical_tempdir() as t:
            dest=Path(t)/'msedgedriver.exe'
            with self.assertRaises(ValueError): w.extract_driver(b'bad',dest)
            data=io.BytesIO()
            with zipfile.ZipFile(data,'w') as z:
                for name in ['../msedgedriver.exe','Driver_Notes/','Driver_Notes/EULA','Driver_Notes/LICENSE','Driver_Notes/credits.html']: z.writestr(name,b'')
            raw=data.getvalue()
            with patch.object(w,'DRIVER_ZIP_HASH',hashlib.sha256(raw).hexdigest()), self.assertRaises(ValueError): w.extract_driver(raw,dest)
            self.assertFalse(dest.exists())

    def test_provision_transport_is_fixed_bounded_and_owned(self):
        with canonical_tempdir() as t:
            output=Path(t)/'output'; output.touch()
            response=MagicMock(status=200); response.geturl.return_value=w.DRIVER_URL; response.read.return_value=b'archive'
            opener=MagicMock(); opener.open.return_value.__enter__.return_value=response
            with patch.dict(os.environ,{'RUNNER_TEMP':t,'GITHUB_OUTPUT':str(output)},clear=True), patch.object(w.urllib.request,'build_opener',return_value=opener) as build, patch.object(w,'extract_driver') as extract, patch.object(w,'hash_file',return_value=w.DRIVER_EXE_HASH), patch.object(w,'verify_driver_signature'):
                root=Path(t)/w.DRIVER_STAGE
                self.assertEqual(w.pinned_driver('131.0.2903.86',True),root/'msedgedriver.exe')
                opener.open.assert_called_once_with(w.DRIVER_URL,timeout=30)
                response.read.assert_called_once_with(16*1024*1024+1)
                extract.assert_called_once_with(b'archive',root/'msedgedriver.exe')
                proxy,redirect=build.call_args.args
                self.assertEqual(proxy.proxies,{})
                self.assertIsNone(redirect.redirect_request(None,None,302,'redirect',{},'https://other.invalid'))
                self.assertEqual(output.read_text(),f'driver_stage={root}\n')
                with self.assertRaises(FileExistsError): w.pinned_driver('131.0.2903.86',True)
                self.assertEqual(opener.open.call_count,1)

    def test_provision_output_failure_removes_only_new_empty_directory(self):
        with canonical_tempdir() as t:
            with patch.dict(os.environ,{'RUNNER_TEMP':t},clear=True), patch.object(w.urllib.request,'build_opener') as network:
                with self.assertRaises(KeyError): w.pinned_driver('131.0.2903.86',True)
                self.assertFalse((Path(t)/w.DRIVER_STAGE).exists())
                network.assert_not_called()

    def test_download_wrong_final_url_never_extracts(self):
        with canonical_tempdir() as t:
            output=Path(t)/'output'; output.touch()
            response=MagicMock(status=200); response.geturl.return_value='https://other.invalid/'
            opener=MagicMock(); opener.open.return_value.__enter__.return_value=response
            with patch.dict(os.environ,{'RUNNER_TEMP':t,'GITHUB_OUTPUT':str(output)},clear=True), patch.object(w.urllib.request,'build_opener',return_value=opener), patch.object(w,'extract_driver') as extract:
                with self.assertRaises(ValueError): w.pinned_driver('131.0.2903.86',True)
                response.read.assert_not_called(); extract.assert_not_called()

    def test_provision_primes_signature_caches_during_download(self):
        with canonical_tempdir() as t:
            bundled=Path(t)/'bundled'; bundled.mkdir(); (bundled/'msedgedriver.exe').touch()
            output=Path(t)/'output'; output.touch()
            response=MagicMock(status=200); response.geturl.return_value=w.DRIVER_URL; response.read.return_value=b'archive'
            opener=MagicMock(); opener.open.return_value.__enter__.return_value=response
            proc=MagicMock(); proc.poll.return_value=None
            with patch.dict(os.environ,{'RUNNER_TEMP':t,'GITHUB_OUTPUT':str(output),'EDGEWEBDRIVER':str(bundled),'GH_TOKEN':'synthetic','SYSTEMROOT':t},clear=True), patch.object(w.urllib.request,'build_opener',return_value=opener), patch.object(w,'extract_driver'), patch.object(w,'hash_file',return_value=w.DRIVER_EXE_HASH), patch.object(w,'verify_driver_signature') as signature, patch.object(w.subprocess,'Popen',return_value=proc) as spawn:
                with self.assertRaises(ValueError): w.pinned_driver('131.0.2903.86',True)
                spawn.assert_not_called()
            with patch.dict(os.environ,{'RUNNER_TEMP':t,'GITHUB_OUTPUT':str(output),'EDGEWEBDRIVER':str(bundled),'SYSTEMROOT':t},clear=True), patch.object(w.urllib.request,'build_opener',return_value=opener), patch.object(w,'extract_driver'), patch.object(w,'hash_file',return_value=w.DRIVER_EXE_HASH), patch.object(w,'verify_driver_signature') as signature, patch.object(w.subprocess,'Popen',return_value=proc) as spawn:
                self.assertEqual(w.pinned_driver('131.0.2903.86',True),Path(t)/w.DRIVER_STAGE/'msedgedriver.exe')
                spawn.assert_called_once()
                call=spawn.call_args
                command=call.args[0]
                self.assertIn('-NonInteractive',command)
                self.assertEqual(command[-1],'Get-AuthenticodeSignature -LiteralPath $env:QA_WARM_FILE | Out-Null')
                self.assertEqual(call.kwargs['stdout'],subprocess.DEVNULL)
                self.assertEqual(call.kwargs['stderr'],subprocess.DEVNULL)
                env=call.kwargs['env']
                self.assertEqual(env['QA_WARM_FILE'],str(bundled/'msedgedriver.exe'))
                self.assertNotIn('QA_DRIVER_FILE',env)
                self.assertNotIn('GH_TOKEN',env)
                proc.terminate.assert_called_once_with()
                proc.wait.assert_called_once_with(timeout=5)
                signature.assert_called_once()

    def test_warmup_absent_without_bundled_driver_and_reuse(self):
        with canonical_tempdir() as t:
            output=Path(t)/'output'; output.touch()
            response=MagicMock(status=200); response.geturl.return_value=w.DRIVER_URL; response.read.return_value=b'archive'
            opener=MagicMock(); opener.open.return_value.__enter__.return_value=response
            with patch.dict(os.environ,{'RUNNER_TEMP':t,'GITHUB_OUTPUT':str(output),'EDGEWEBDRIVER':str(Path(t)/'absent')},clear=True), patch.object(w.urllib.request,'build_opener',return_value=opener), patch.object(w,'extract_driver'), patch.object(w,'hash_file',return_value=w.DRIVER_EXE_HASH), patch.object(w,'verify_driver_signature'), patch.object(w.subprocess,'Popen') as spawn:
                w.pinned_driver('131.0.2903.86',True)
                spawn.assert_not_called()
            with patch.dict(os.environ,{'EDGEWEBDRIVER':t},clear=True), patch.object(w,'driver_stage',return_value=Path(t)), patch.object(w,'hash_file',return_value=w.DRIVER_EXE_HASH), patch.object(w,'verify_driver_signature'), patch.object(w.subprocess,'Popen') as spawn:
                w.pinned_driver('131.0.2903.86')
                spawn.assert_not_called()

    def test_warmup_spawn_failure_never_blocks_provisioning(self):
        with canonical_tempdir() as t:
            bundled=Path(t)/'bundled'; bundled.mkdir(); (bundled/'msedgedriver.exe').touch()
            output=Path(t)/'output'; output.touch()
            response=MagicMock(status=200); response.geturl.return_value=w.DRIVER_URL; response.read.return_value=b'archive'
            opener=MagicMock(); opener.open.return_value.__enter__.return_value=response
            for error in (OSError('no shell'),ValueError('bad env')):
                with patch.dict(os.environ,{'RUNNER_TEMP':t,'GITHUB_OUTPUT':str(output),'EDGEWEBDRIVER':str(bundled),'SYSTEMROOT':t},clear=True), patch.object(w.urllib.request,'build_opener',return_value=opener), patch.object(w,'extract_driver'), patch.object(w,'hash_file',return_value=w.DRIVER_EXE_HASH), patch.object(w,'verify_driver_signature') as signature, patch.object(w.subprocess,'Popen',side_effect=error):
                    self.assertEqual(w.pinned_driver('131.0.2903.86',True),Path(t)/w.DRIVER_STAGE/'msedgedriver.exe')
                    signature.assert_called_once()
                (Path(t)/w.DRIVER_STAGE).rmdir()

    def test_warmup_termination_is_bounded_and_idempotent(self):
        proc=MagicMock(); proc.poll.return_value=0
        w.end_signature_warmup(proc)
        proc.terminate.assert_not_called(); proc.kill.assert_not_called()
        w.end_signature_warmup(None)
        proc=MagicMock(); proc.poll.return_value=None; proc.wait.side_effect=[subprocess.TimeoutExpired('warm',5),None]
        w.end_signature_warmup(proc)
        proc.terminate.assert_called_once_with(); proc.kill.assert_called_once_with()
        self.assertEqual(proc.wait.call_count,2)
        proc=MagicMock(); proc.poll.return_value=None; proc.terminate.side_effect=OSError('denied'); proc.wait.side_effect=[None]
        w.end_signature_warmup(proc)
        proc.kill.assert_called_once_with()

    def test_warmup_terminated_when_download_fails(self):
        with canonical_tempdir() as t:
            bundled=Path(t)/'bundled'; bundled.mkdir(); (bundled/'msedgedriver.exe').touch()
            output=Path(t)/'output'; output.touch()
            opener=MagicMock(); opener.open.side_effect=OSError('network down')
            proc=MagicMock(); proc.poll.return_value=None
            with patch.dict(os.environ,{'RUNNER_TEMP':t,'GITHUB_OUTPUT':str(output),'EDGEWEBDRIVER':str(bundled),'SYSTEMROOT':t},clear=True), patch.object(w.urllib.request,'build_opener',return_value=opener), patch.object(w,'verify_driver_signature') as signature, patch.object(w.subprocess,'Popen',return_value=proc):
                with self.assertRaises(OSError): w.pinned_driver('131.0.2903.86',True)
                proc.terminate.assert_called_once_with()
                signature.assert_not_called()

    def test_bad_pinned_signature_prevents_executable_version_call(self):
        import types
        with canonical_tempdir() as t:
            root=Path(t); (root/'msedgedriver.exe').touch()
            with patch.dict(sys.modules,{'winreg':types.SimpleNamespace(HKEY_LOCAL_MACHINE=1)}), patch.dict(os.environ,{'EDGEWEBDRIVER':t},clear=True), patch.object(w,'reg_value',return_value='131.0.2903.86'), patch.object(w,'driver_stage',return_value=root), patch.object(w,'hash_file',return_value=w.DRIVER_EXE_HASH), patch.object(w,'verify_driver_signature',side_effect=ValueError('bad signature')), patch.object(w.subprocess,'run',return_value=MagicMock(stdout='Microsoft Edge WebDriver 156.0.4314.42')) as run:
                with self.assertRaisesRegex(ValueError,'bad signature'): w.driver_path()
                run.assert_called_once_with([str(root/'msedgedriver.exe'),'--version'],capture_output=True,text=True,check=True,timeout=10)

    def test_driver_signature_requires_valid_microsoft_codesigning(self):
        with canonical_tempdir() as t:
            with patch.dict(os.environ,{'SYSTEMROOT':t,'GH_TOKEN':'never-inherited'}), patch.object(w.subprocess,'run') as run:
                valid={'status':'Valid','subject':w.MICROSOFT_SUBJECT,'eku':['1.3.6.1.5.5.7.3.3']}
                for value in [dict(valid,status='NotSigned'),dict(valid,subject='Other'),dict(valid,eku=[])]:
                    run.return_value=MagicMock(stdout=json.dumps(value))
                    with self.assertRaises(ValueError): w.verify_driver_signature(Path(t)/'msedgedriver.exe')
                run.return_value=MagicMock(stdout=json.dumps(valid)); w.verify_driver_signature(Path(t)/'msedgedriver.exe')
                self.assertNotIn('GH_TOKEN',run.call_args.kwargs['env'])
                self.assertEqual(run.call_args.kwargs['timeout'],90)
                self.assertNotIn('-ExecutionPolicy',run.call_args.args[0])

    def test_signature_rejection_logs_only_status_and_match_booleans(self):
        with canonical_tempdir() as t:
            output=io.StringIO()
            result=MagicMock(stdout=json.dumps({'status':'private-status','subject':'private-subject','eku':['private-oid']}),stderr='qa-signature-returned')
            with patch.dict(os.environ,{'SYSTEMROOT':t},clear=True), patch.object(w.subprocess,'run',return_value=result), patch('sys.stdout',output):
                with self.assertRaises(ValueError): w.verify_driver_signature(Path(t)/'driver.exe')
            self.assertIn('status=unknown; subject_matches=False; code_signing_EKU=False',output.getvalue())
            self.assertNotIn('private',output.getvalue())

    def test_signature_timeout_is_bounded_sanitized_and_cleanup_remains_possible(self):
        with canonical_tempdir() as t:
            root=Path(t)/w.DRIVER_STAGE; root.mkdir(); exe=root/'msedgedriver.exe'; exe.touch()
            output=io.StringIO()
            error=subprocess.TimeoutExpired('synthetic-private-command',90,stderr=b'qa-signature-start\nsynthetic-private-output')
            with patch.dict(os.environ,{'SYSTEMROOT':t,'RUNNER_TEMP':t,'DRIVER_STAGE_PATH':str(root)},clear=True), patch.object(w.subprocess,'run',side_effect=error) as run, patch('sys.stdout',output):
                with self.assertRaisesRegex(RuntimeError,'did not complete successfully') as caught: w.verify_driver_signature(exe)
                self.assertEqual(run.call_args.kwargs['timeout'],90)
                self.assertNotIn('synthetic-private',str(caught.exception))
                w.cleanup()
            self.assertFalse(root.exists())
            self.assertIn('signature-started',output.getvalue())
            self.assertNotIn('synthetic-private',output.getvalue())
            for stderr,expected in [(None,'shell-startup'),('qa-signature-returned\nprivate','signature-returned')]:
                output=io.StringIO()
                with patch('sys.stdout',output): w.signature_diagnostic(stderr,time.monotonic())
                self.assertIn(expected,output.getvalue()); self.assertNotIn('private',output.getvalue())

    def test_dom_diagnostics_are_bounded_readonly_and_do_not_change_oracle(self):
        output=io.StringIO()
        response={'title':'t'*300,'location':'l'*400,'body':'b'*900,'readyState':'complete','tauri':True,'root':False,'articles':1000,'frames':0,'extra':'not-printed'}
        with patch.object(w.qa,'wd',return_value=response) as wd, patch('sys.stdout',output): w.report_dom_state('synthetic')
        wd.assert_called_once_with('POST','/session/synthetic/execute/sync',{'script':w.DOM_DIAGNOSTIC_SCRIPT,'args':[]})
        parsed=json.loads(output.getvalue().split(': ',1)[1])
        self.assertEqual(len(parsed['body']),512); self.assertEqual(len(parsed['title']),128)
        self.assertEqual(len(parsed['location']),256); self.assertEqual(parsed['articles'],100)
        self.assertNotIn('extra',parsed); self.assertFalse(w.qa.oracle(response))
        with patch.object(w.qa,'wd',side_effect=ValueError('private-diagnostic')), patch('sys.stdout',output): w.report_dom_state('synthetic')
        self.assertNotIn('private-diagnostic',output.getvalue())

    def test_failed_owned_cleanup_reports_attributes_without_mutation(self):
        with canonical_tempdir() as t:
            root=Path(t); child=root/'Programs'; child.mkdir()
            info=MagicMock(st_file_attributes=1,st_mode=0o040700)
            # Sharing violation is ineligible for DOS-bit changes on every platform.
            error=PermissionError('synthetic'); error.winerror=32
            def fail(path,onexc): onexc(os.rmdir,str(child),error)
            output=io.StringIO()
            with patch.object(w.shutil,'rmtree',side_effect=fail), patch.object(w.Path,'lstat',return_value=info), patch.object(w.os,'chmod') as chmod, patch.object(w,'clear_readonly_attribute') as clear, patch('sys.stdout',output):
                with self.assertRaises(PermissionError): self.remove_callback_tree(root)
                chmod.assert_not_called(); clear.assert_not_called()
            self.assertTrue(child.is_dir())
            parsed=json.loads(output.getvalue().split(': ',1)[1])
            self.assertEqual(parsed,{'relative':'Programs','readonly':True,'reparse':False,'directory':True,'symlink':False,'winerror':32})

    def test_cleanup_diagnostic_refuses_outside_and_linked_ancestors(self):
        with canonical_tempdir() as t:
            root=Path(t); error=PermissionError('synthetic')
            for target,info in [(root/'..'/'outside',None),(root/'link'/'Programs',MagicMock(st_mode=0o040700,st_file_attributes=0x400))]:
                def fail(path,onexc): onexc(os.rmdir,str(target),error)
                output=io.StringIO()
                with patch.object(w.shutil,'rmtree',side_effect=fail), patch.object(w.Path,'lstat',return_value=info) as lstat, patch('sys.stdout',output):
                    with self.assertRaises(PermissionError): self.remove_callback_tree(root)
                self.assertEqual(lstat.call_count,0 if info is None else 1)
                self.assertIn('diagnostic unavailable',output.getvalue())

    def test_argv_report_only_emits_fixture_booleans(self):
        fixture=Path('/synthetic/native-smoke.md')
        for argument,key in [(str(fixture),'fixture_exact_arg'),('--'+str(fixture),'fixture_switch_arg'),('"'+str(fixture)+'"','fixture_quoted_arg')]:
            result=w.argv_summary(['app',argument,'private-token'],fixture)
            self.assertTrue(result[key]); self.assertEqual(result['argument_count'],2)
            self.assertNotIn('private-token',json.dumps(result))
        output=io.StringIO()
        with patch.dict(os.environ,{'ARGV_QUERY_READY':'true'}), patch.object(w,'owned_app_processes',return_value=[123]), patch.object(w,'query_command_line',return_value='private-command'), patch.object(w,'windows_argv',return_value=['app',str(fixture),'private-token']), patch('sys.stdout',output): w.report_app_argv(Path('/app'),fixture)
        self.assertNotIn('private',output.getvalue())
        with patch.object(w,'owned_app_processes',side_effect=ValueError('private-command')), patch('sys.stdout',output): w.report_app_argv(Path('/app'),fixture)
        self.assertNotIn('private',output.getvalue())

    def test_app_query_uses_only_job_images_and_original_hash(self):
        app=Path('/synthetic/md-opener.exe')
        with patch.object(w,'hash_file',return_value=w.EXE_HASH), patch.object(w,'job_process_ids',return_value=[1,2]), patch.object(w,'process_image',side_effect=[str(app),'other']) as image, patch.object(w.subprocess,'run') as run:
            self.assertEqual(w.owned_app_processes(app),[1]); self.assertEqual(image.call_count,2); run.assert_not_called()
        with patch.object(w,'hash_file',return_value='wrong'), patch.object(w,'job_process_ids') as ids:
            with self.assertRaises(ValueError): w.owned_app_processes(app)
            ids.assert_not_called()

    def test_query_sanitizes_timeout_exit_and_shape_without_token(self):
        import traceback
        with canonical_tempdir() as t:
            for error,kind in [(subprocess.TimeoutExpired('private-command',20,output='private-argv'),'timeout'),(subprocess.CalledProcessError(1,'private-command',output='private-argv',stderr='private-stderr'),'exit'),(OSError('private-argv'),'launch')]:
                with patch.dict(os.environ,{'SYSTEMROOT':t,'GH_TOKEN':'private-token'}), patch.object(w.subprocess,'run',side_effect=error) as run:
                    try: w.query_command_line(123)
                    except w.ProcessQueryUnavailable as caught:
                        rendered=''.join(traceback.format_exception(caught)); self.assertIn('unavailable: '+kind,rendered)
                        for secret in ['private-command','private-argv','private-stderr','private-token']: self.assertNotIn(secret,rendered)
                    else: self.fail('query failure accepted')
                    self.assertNotIn('GH_TOKEN',run.call_args.kwargs['env']); self.assertEqual(run.call_args.kwargs['timeout'],20)
            for result in ['private-invalid-json',json.dumps({'ProcessId':124,'CommandLine':'private-command'})]:
                with patch.dict(os.environ,{'SYSTEMROOT':t}), patch.object(w.subprocess,'run',return_value=MagicMock(stdout=result)):
                    with self.assertRaisesRegex(w.ProcessQueryUnavailable,'shape'): w.query_command_line(123)
            with patch.object(w.subprocess,'run') as run:
                with self.assertRaises(ValueError): w.query_command_line('123 OR 1=1')
                run.assert_not_called()

    def test_optional_preflight_failure_does_not_prepare_or_launch(self):
        with canonical_tempdir() as t:
            output=Path(t)/'output'; capture=io.StringIO()
            with patch.dict(os.environ,{'GITHUB_OUTPUT':str(output)}), patch.object(w,'query_command_line',side_effect=w.ProcessQueryUnavailable('process query unavailable: timeout')), patch.object(w,'prepare') as prep, patch.object(w,'worker') as worker, patch('sys.stdout',capture):
                w.check_process_query(); prep.assert_not_called(); worker.assert_not_called()
            self.assertEqual(output.read_text(),'ready=false\n'); self.assertIn('timeout',capture.getvalue())
            with patch.dict(os.environ,{'ARGV_QUERY_READY':'false'}), patch.object(w,'owned_app_processes') as processes, patch.object(w,'query_command_line') as query:
                w.report_app_argv(Path('/app'),Path('/fixture')); processes.assert_not_called(); query.assert_not_called()

    def test_query_result_requires_same_owned_identity_afterward(self):
        output=io.StringIO()
        with patch.dict(os.environ,{'ARGV_QUERY_READY':'true'}), patch.object(w,'owned_app_processes',side_effect=[[123],[]]), patch.object(w,'query_command_line',return_value='private-command'), patch.object(w,'windows_argv') as parse, patch('sys.stdout',output):
            w.report_app_argv(Path('/app'),Path('/fixture')); parse.assert_not_called()
        self.assertNotIn('private',output.getvalue()); self.assertIn('unavailable',output.getvalue())

    def test_job_process_list_is_complete_bounded_and_explicit(self):
        kernel=MagicMock()
        def query(job,kind,pointer,size,returned):
            self.assertEqual(job,123); self.assertEqual(kind,3)
            obj=pointer._obj; obj.assigned=2; obj.count=2; obj.ids[0]=1; obj.ids[1]=2; return 1
        kernel.QueryInformationJobObject.side_effect=query
        with patch.object(w,'_JOB',123), patch.object(w.ctypes,'WinDLL',return_value=kernel,create=True):
            self.assertEqual(w.job_process_ids(),[1,2])
            def truncated(*args): args[2]._obj.assigned=257; args[2]._obj.count=256; return 1
            kernel.QueryInformationJobObject.side_effect=truncated
            with self.assertRaises(ValueError): w.job_process_ids()
            kernel.QueryInformationJobObject.side_effect=None; kernel.QueryInformationJobObject.return_value=0
            with self.assertRaises(ValueError): w.job_process_ids()

    def test_process_image_closes_limited_handle_on_failure(self):
        kernel=MagicMock(); kernel.OpenProcess.return_value=44; kernel.QueryFullProcessImageNameW.return_value=0
        with patch.object(w.ctypes,'WinDLL',return_value=kernel,create=True), patch.object(w,'process_in_owned_job',return_value=True):
            with self.assertRaises(ValueError): w.process_image(123)
        kernel.OpenProcess.assert_called_once_with(0x1000,False,123); kernel.CloseHandle.assert_called_once_with(44)

    def test_entire_finite_readonly_shell_folder_chain_retries_once(self):
        with canonical_tempdir() as t:
            root=Path(t); deepest=Path('home/AppData/Roaming/Microsoft/Windows/Start Menu/Programs')
            chain=[deepest,*[p for p in deepest.parents if p!=Path('.')]]
            error=PermissionError('synthetic'); error.winerror=5
            info=MagicMock(st_mode=0o040700,st_file_attributes=17)
            def remove(path,onexc):
                for relative in chain: onexc(w.os.rmdir,str(root/relative),error)
            with patch.object(w.os,'name','nt'), patch.object(w,'Path',type(root)), patch.object(type(root),'lstat',return_value=info), patch.object(w,'stage',return_value=root), patch.object(w.shutil,'rmtree',side_effect=remove), patch.object(w.os,'rmdir') as retry, patch.object(w,'clear_readonly_attribute') as clear:
                self.remove_callback_tree(root)
                self.assertEqual(clear.call_count,7); self.assertEqual(retry.call_count,7)

    def test_owned_readonly_entries_get_one_delete_retry_each(self):
        with canonical_tempdir() as t:
            root=Path(t)
            for name,target,info in [
                ('rmdir',root/'home/AppData/Roaming/Microsoft/Windows/Start Menu/Programs',MagicMock(st_mode=0o040700,st_file_attributes=17)),
                ('rmdir',root/'installed/app',MagicMock(st_mode=0o040700,st_file_attributes=1)),
                ('unlink',root/'home/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/desktop.ini',MagicMock(st_mode=0o100600,st_file_attributes=1)),
            ]:
                error=PermissionError('synthetic'); error.winerror=5
                def fail(path,onexc): onexc(getattr(w.os,name),str(target),error)
                with patch.object(w.os,'name','nt'), patch.object(w,'Path',type(root)), patch.object(type(root),'lstat',autospec=True,side_effect=lambda path: info if path==target else MagicMock(st_mode=0o040700,st_file_attributes=16)), patch.object(w.shutil,'rmtree',side_effect=fail), patch.object(w.os,name) as retry, patch.object(w,'clear_readonly_attribute') as clear:
                    self.remove_callback_tree(root)
                    clear.assert_called_once_with(target,info.st_file_attributes); retry.assert_called_once_with(str(target))
                    clear.reset_mock(); retry.reset_mock(); retry.side_effect=PermissionError('still denied')
                    with self.assertRaises(PermissionError): self.remove_callback_tree(root)
                    self.assertEqual(retry.call_count,1)

    def test_readonly_cleanup_rejects_all_other_entries_and_errors(self):
        with canonical_tempdir() as t:
            root=Path(t); target=root/'home/AppData/Roaming/Microsoft/Windows/Start Menu/Programs'
            for attrs,mode,winerror,wrong_function in [
                (0x411,0o040700,5,False),(16,0o040700,5,False),
                (1,0o040700,32,False),(1,0o040700,5,True),
                (1,0o120777,5,False),(1,0o010600,5,False),
            ]:
                error=PermissionError('synthetic'); error.winerror=winerror
                info=MagicMock(st_mode=mode,st_file_attributes=attrs)
                def fail(current,onexc): onexc((lambda p: None) if wrong_function else w.os.rmdir,str(target),error)
                with patch.object(w.os,'name','nt'), patch.object(w,'Path',type(root)), patch.object(type(root),'lstat',autospec=True,side_effect=lambda path: info if path==target else MagicMock(st_mode=0o040700,st_file_attributes=16)), patch.object(w.shutil,'rmtree',side_effect=fail), patch.object(w,'clear_readonly_attribute') as clear:
                    with self.assertRaises(PermissionError): self.remove_callback_tree(root)
                    clear.assert_not_called()

    def test_cleanup_never_clears_root_or_escaping_target(self):
        with canonical_tempdir() as t:
            root=Path(t); error=PermissionError('synthetic'); error.winerror=5
            for target in [root,root/'..'/'outside',root.parent/'outside']:
                def fail(current,onexc): onexc(w.os.rmdir,str(target),error)
                with patch.object(w.os,'name','nt'), patch.object(w,'Path',type(root)), patch.object(w.shutil,'rmtree',side_effect=fail), patch.object(w,'clear_readonly_attribute') as clear:
                    with self.assertRaises(PermissionError): self.remove_callback_tree(root)
                    clear.assert_not_called()

    def test_dos_attribute_setter_preserves_every_other_bit(self):
        kernel=MagicMock(); kernel.SetFileAttributesW.return_value=1
        target=Path('/synthetic')
        with patch.object(w.ctypes,'WinDLL',return_value=kernel,create=True):
            w.clear_readonly_attribute(target,0x213)
            kernel.SetFileAttributesW.assert_called_once_with(str(target),0x212)
            kernel.SetFileAttributesW.return_value=0
            with self.assertRaises(ValueError): w.clear_readonly_attribute(target,0x213)

    @unittest.skipUnless(os.name=='nt','requires actual Windows command-line parser')
    def test_windows_command_line_parser_preserves_synthetic_file_argument(self):
        args=[r'D:\synthetic\md-opener.exe',r'D:\synthetic\file name.md','--flag']
        self.assertEqual(w.windows_argv(subprocess.list2cmdline(args)),args)

    def test_driver_cleanup_without_installer_stage(self):
        with canonical_tempdir() as t:
            root=Path(t)/w.DRIVER_STAGE; root.mkdir(); (root/'partial').touch()
            with patch.dict(os.environ,{'RUNNER_TEMP':t,'DRIVER_STAGE_PATH':str(root)},clear=True): w.cleanup()
            self.assertFalse(root.exists())

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
            worker='import importlib.util,subprocess,sys,time,os; s=importlib.util.spec_from_file_location("qa",'+repr(str(SCRIPT))+'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.enter_owned_job(); assert m.process_in_owned_job(os.getpid()); assert os.getpid() in m.job_process_ids(); assert os.path.samefile(m.process_image(os.getpid()),sys.executable); subprocess.Popen([sys.executable,"-c",'+repr(child)+']); time.sleep(60)'
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
