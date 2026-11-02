#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import tempfile
import signal
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('qa', Path(__file__).with_name('native-qa.py'))
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)

class Tests(unittest.TestCase):
    def test_dom_oracle(self):
        good = {'heading': qa.HEADING, 'text': 'Native WebView Unicode: café 日本語.'}
        self.assertTrue(qa.oracle(good))
        for bad in (None, {}, {**good,'heading':'wrong'}, {**good,'text': good['text']+' '}):
            self.assertFalse(qa.oracle(bad))

    def test_environment_excludes_credentials_overrides(self):
        with tempfile.TemporaryDirectory() as t, patch.dict(qa.os.environ, {'GH_TOKEN':'synthetic','ANTHROPIC_API_KEY':'synthetic','OLLAMA_HOST':'https://invalid.example','HTTP_PROXY':'http://invalid.example','PATH':'/usr/bin','DISPLAY':':99'}, clear=True):
            env = qa.app_env(Path(t))
            self.assertEqual(set(env), {'PATH','DISPLAY','HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR','TMPDIR'})
            self.assertTrue(all(Path(env[k]).stat().st_mode & 0o777 == 0o700 for k in ('HOME','XDG_RUNTIME_DIR','TMPDIR')))

    def test_zip_duplicate_and_symlink_rejected(self):
        for mode in ('duplicate','symlink'):
            with tempfile.TemporaryDirectory() as t:
                zpath = Path(t)/'x.zip'
                with zipfile.ZipFile(zpath,'w') as z:
                    if mode == 'duplicate':
                        z.writestr(qa.ZIP_APP,b'x'); z.writestr(qa.ZIP_APP,b'x')
                    else:
                        i=zipfile.ZipInfo(qa.ZIP_APP); i.external_attr=0o120777<<16; z.writestr(i,b'x')
                with self.assertRaises(ValueError): qa.select_linux(zpath,Path(t))

    def test_zip_hash_fail_closed(self):
        with tempfile.TemporaryDirectory() as t:
            zpath=Path(t)/'x.zip'
            with zipfile.ZipFile(zpath,'w') as z:
                z.writestr(qa.ZIP_APP,b'tampered'); z.writestr(qa.ZIP_APP+'.sig',b'synthetic')
            with self.assertRaisesRegex(ValueError,'artifact mismatch'): qa.select_linux(zpath,Path(t))

    def test_cleanup_targets_only_owned_group(self):
        from unittest.mock import Mock
        proc=Mock(pid=123456)
        with patch.object(qa.os,'killpg') as kill:
            qa.stop_group(proc)
            self.assertEqual([x.args for x in kill.call_args_list],[(123456,qa.signal.SIGTERM),(123456,qa.signal.SIGKILL)])
            proc.wait.assert_called_with(timeout=5)

    def test_probe_real_oracle_and_cleanup_with_fake_driver(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); app=root/'app'; app.write_bytes(b'synthetic')
            proc=Mock(pid=123456); proc.poll.return_value=None
            calls=[]
            def driver(method,path,payload=None):
                calls.append((method,path,payload))
                if path=='/session': return {'sessionId':'synthetic-1'}
                if path.endswith('/execute/sync'): return {'heading':qa.HEADING,'text':'Native WebView Unicode: café 日本語.'}
                return {}
            with patch.object(qa,'validate_probe_paths'), patch.object(qa.subprocess,'Popen',return_value=proc), patch.object(qa,'wd',side_effect=driver), patch.object(qa,'stop_group') as cleanup, patch.object(qa.signal,'signal'), patch.object(qa.signal,'alarm'), patch('builtins.print'):
                qa.probe(root,app)
                cleanup.assert_called_once_with(proc)
            self.assertTrue(any(m=='DELETE' for m,_,_ in calls))
            self.assertEqual(calls[1][2]['capabilities']['alwaysMatch']['tauri:options']['application'],str(app))

    def test_probe_failed_session_still_cleans_up(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); app=root/'app'; app.write_bytes(b'synthetic')
            proc=Mock(pid=123456); proc.poll.return_value=None
            def driver(method,path,payload=None):
                if path=='/session': raise TimeoutError('synthetic session timeout')
                return {}
            with patch.object(qa,'validate_probe_paths'), patch.object(qa.subprocess,'Popen',return_value=proc), patch.object(qa,'wd',side_effect=driver), patch.object(qa,'stop_group') as cleanup, patch.object(qa.signal,'signal'), patch.object(qa.signal,'alarm'), patch('builtins.print'):
                with self.assertRaises(TimeoutError): qa.probe(root,app)
                cleanup.assert_called_once_with(proc)

    def test_dom_deadline_still_deletes_session_and_stops_group(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); app=root/'app'; app.write_bytes(b'synthetic')
            proc=Mock(pid=123456); proc.poll.return_value=None
            calls=[]
            def driver(method,path,payload=None):
                calls.append((method,path))
                if path=='/session': return {'sessionId':'synthetic-1'}
                if path.endswith('/execute/sync'): raise TimeoutError('synthetic DOM deadline')
                return {}
            with patch.object(qa,'validate_probe_paths'), patch.object(qa.subprocess,'Popen',return_value=proc), patch.object(qa,'wd',side_effect=driver), patch.object(qa,'stop_group') as cleanup, patch.object(qa.signal,'signal'), patch.object(qa.signal,'alarm'), patch('builtins.print'):
                with self.assertRaises(TimeoutError): qa.probe(root,app)
                cleanup.assert_called_once_with(proc)
            self.assertIn(('DELETE','/session/synthetic-1'),calls)

    def test_malformed_delete_cannot_skip_group_cleanup(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); app=root/'app'; app.write_bytes(b'synthetic')
            proc=Mock(pid=123456); proc.poll.return_value=None
            def driver(method,path,payload=None):
                if method=='DELETE': raise KeyError('malformed delete response')
                if path=='/session': return {'sessionId':'synthetic-1'}
                if path.endswith('/execute/sync'): return {'heading':qa.HEADING,'text':'Native WebView Unicode: café 日本語.'}
                return {}
            with patch.object(qa,'validate_probe_paths'), patch.object(qa.subprocess,'Popen',return_value=proc), patch.object(qa,'wd',side_effect=driver), patch.object(qa,'stop_group') as cleanup, patch.object(qa.signal,'signal'), patch.object(qa.signal,'alarm'), patch('builtins.print'):
                with self.assertRaises(KeyError): qa.probe(root,app)
                cleanup.assert_called_once_with(proc)

    def test_probe_paths_reject_before_writes_or_launch(self):
        import hashlib, os
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); app=root/qa.APP; app.write_bytes(b'synthetic')
            with patch.object(qa,'APP_HASH',hashlib.sha256(b'synthetic').hexdigest()):
                qa.validate_probe_paths(root,app)
                for work, binary in ((Path('.'),app),(root,root/'other')):
                    with self.assertRaises(ValueError): qa.validate_probe_paths(work,binary)
                root.chmod(0o755)
                with self.assertRaises(ValueError): qa.validate_probe_paths(root,app)
                root.chmod(0o700)
                for name in ('native-smoke.md','driver.log'):
                    collision=root/name; collision.symlink_to(root/'absent')
                    with patch.object(qa,'app_env') as env, patch.object(qa.subprocess,'Popen') as launch:
                        with self.assertRaises(ValueError): qa.probe(root,app)
                        env.assert_not_called(); launch.assert_not_called()
                    collision.unlink()
                app.unlink(); app.symlink_to(root/'absent')
                with self.assertRaises(ValueError): qa.validate_probe_paths(root,app)

    def test_child_bad_hash_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); app=root/qa.APP; app.write_bytes(b'tampered')
            with patch.object(qa,'app_env') as env:
                with self.assertRaisesRegex(ValueError,'digest'): qa.probe(root,app)
                env.assert_not_called()

    def test_wd_route_rejected_before_network(self):
        for method,path in [('GET','/session/x'),('POST','/session/../execute/sync'),('POST','/session/é/execute/sync'),('DELETE','/session/x?evil=1'),('PUT','/session'),('POST','https://example.com'),('POST','/session/x/execute/sync/extra')]:
            with patch.object(qa.urllib.request,'Request') as request:
                with self.assertRaises(ValueError): qa.wd(method,path)
                request.assert_not_called()
        for method,path in [('GET','/status'),('POST','/session'),('DELETE','/session/a-b'),('POST','/session/a-b/execute/sync')]:
            self.assertTrue(qa.wd_route(method,path))
        self.assertFalse(qa.session_id('é'))
        self.assertFalse(qa.session_id('x'*129))
        self.assertTrue(qa.session_id('a-b-123'))

    def test_symlink_work_root_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); link=root/'link'; link.symlink_to(root,target_is_directory=True)
            with self.assertRaises(ValueError): qa.validate_probe_paths(link,link/qa.APP)

    def test_late_fixture_symlink_is_not_followed(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); app=root/qa.APP; app.write_bytes(b'synthetic')
            sentinel=root/'sentinel'; sentinel.write_text('unchanged')
            def late_collision(_):
                (root/'native-smoke.md').symlink_to(sentinel)
                return {}
            with patch.object(qa,'validate_probe_paths'), patch.object(qa,'app_env',side_effect=late_collision), patch.object(qa.subprocess,'Popen') as launch, patch.object(qa.signal,'signal'), patch.object(qa.signal,'alarm'):
                with self.assertRaises(FileExistsError): qa.probe(root,app)
                launch.assert_not_called()
            self.assertEqual(sentinel.read_text(),'unchanged')

    def test_wd_redirect_handler_refuses_redirects(self):
        from unittest.mock import Mock
        response=Mock(); response.__enter__=Mock(return_value=response); response.__exit__=Mock(return_value=False)
        response.read.return_value=b'{"value": {}}'
        opener=Mock(); opener.open.return_value=response
        with patch.object(qa.urllib.request,'build_opener',return_value=opener) as build:
            qa.wd('GET','/status')
            handlers=build.call_args.args
            redirect=next(h() for h in handlers if isinstance(h,type) and issubclass(h,qa.urllib.request.HTTPRedirectHandler))
            self.assertIsNone(redirect.redirect_request(None,None,None,None,None,'https://example.com'))

    def test_session_creation_gets_60_seconds_other_calls_10(self):
        from unittest.mock import MagicMock
        import io
        opener=MagicMock()
        for method,path,seconds in [('POST','/session',60),('GET','/status',10),('DELETE','/session/test-id',10),('POST','/session/test-id/execute/sync',10)]:
            opener.open.return_value=io.BytesIO(b'{"value": {}}')
            with patch.object(qa.urllib.request,'build_opener',return_value=opener):
                qa.wd(method,path)
            self.assertEqual(opener.open.call_args.kwargs['timeout'],seconds)

    def test_prepare_failure_publishes_owned_cleanup_not_probe(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); output=root/'output'; output.write_text('')
            with patch.dict(qa.os.environ,{'RUNNER_TEMP':t,'GITHUB_OUTPUT':str(output),'GH_TOKEN':'synthetic'},clear=True), patch.object(qa,'module',side_effect=ValueError('synthetic preparation failure')), patch.object(qa,'probe') as probe:
                with self.assertRaisesRegex(ValueError,'preparation failure'): qa.prepare()
                work=root/'md050-original-native-qa'
                self.assertTrue(work.is_dir()); self.assertEqual(work.stat().st_mode & 0o777,0o700)
                self.assertEqual(output.read_text(),f'stage={work}\n')
                qa.os.environ['STAGE_PATH']=str(work)
                with self.assertRaises(ValueError): qa.run_prepared()
                probe.assert_not_called()
                qa.cleanup(); self.assertFalse(work.exists())

    def test_prepare_collision_is_never_owned_or_removed(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); output=root/'output'; output.write_text(''); work=root/'md050-original-native-qa'; work.mkdir(); (work/'sentinel').write_text('unchanged')
            with patch.dict(qa.os.environ,{'RUNNER_TEMP':t,'GITHUB_OUTPUT':str(output),'GH_TOKEN':'synthetic'},clear=True):
                with self.assertRaises(FileExistsError): qa.prepare()
                self.assertEqual(output.read_text(),''); qa.cleanup()
                self.assertEqual((work/'sentinel').read_text(),'unchanged')

    def test_prepared_phase_refuses_token_and_cleans_after_probe_failure(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); work=root/'md050-original-native-qa'; work.mkdir(mode=0o700)
            (work/'qualified.json').write_text(qa.json.dumps({'sha':qa.SHA,'run':qa.RUN,'app_sha256':qa.APP_HASH}))
            with patch.dict(qa.os.environ,{'RUNNER_TEMP':t,'STAGE_PATH':str(work),'GH_TOKEN':'synthetic'},clear=True), patch.object(qa,'probe',side_effect=ValueError('synthetic probe failure')) as probe:
                with self.assertRaisesRegex(ValueError,'token'): qa.run_prepared()
                probe.assert_not_called(); del qa.os.environ['GH_TOKEN']
                with self.assertRaisesRegex(ValueError,'probe failure'): qa.run_prepared()
                probe.assert_called_once_with(work,work/qa.APP)
                qa.cleanup(); self.assertFalse(work.exists())

    def test_workflow_separates_token_and_always_cleanup(self):
        source=(Path(__file__).resolve().parents[1]/'.github/workflows/native-qa.yml').read_text()
        prep=source.split('- name: Prepare and verify original artifacts',1)[1].split('- name: Probe original native DOM',1)[0]
        after=source.split('- name: Probe original native DOM',1)[1]
        self.assertIn('GH_TOKEN: ${{ github.token }}',prep)
        self.assertNotIn('dbus-run-session',prep)
        self.assertNotIn('GH_TOKEN',after); self.assertNotIn('github.token',after)
        self.assertIn('if: always()',after)
        self.assertIn('scripts/native-qa.py --cleanup',after)
        self.assertIn('dbus-run-session -- xvfb-run -a python3 scripts/native-qa.py --probe',after)

    def test_no_arbitrary_cli_inputs(self):
        with patch.object(qa.sys,'argv',['qa','arbitrary']):
            with self.assertRaises(ValueError): qa.main()

class ProcessTests(unittest.TestCase):
    def test_real_owned_group_cleanup(self):
        import subprocess, sys, os, time
        code = "import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); pid=os.fork(); print(pid,flush=True); time.sleep(30)"
        proc=subprocess.Popen([sys.executable,'-c',code],stdout=subprocess.PIPE,start_new_session=True,text=True)
        try:
            child=int(proc.stdout.readline().strip())
            qa.stop_group(proc)
            self.assertIsNotNone(proc.returncode)
            # A dead child can briefly remain a zombie until the host reaps it.
            path=Path(f'/proc/{child}/stat')
            until=time.monotonic()+2
            while path.exists() and path.read_text().split()[2] != 'Z' and time.monotonic()<until:
                time.sleep(.02)
            self.assertTrue(not path.exists() or path.read_text().split()[2]=='Z')
        finally:
            try: os.killpg(proc.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            proc.wait(timeout=5)
            proc.stdout.close()

if __name__=='__main__': unittest.main()
