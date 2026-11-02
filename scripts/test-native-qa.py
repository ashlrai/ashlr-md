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
            with patch.object(qa.subprocess,'Popen',return_value=proc), patch.object(qa,'wd',side_effect=driver), patch.object(qa,'stop_group') as cleanup, patch.object(qa.signal,'signal'), patch.object(qa.signal,'alarm'), patch('builtins.print'):
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
            with patch.object(qa.subprocess,'Popen',return_value=proc), patch.object(qa,'wd',side_effect=driver), patch.object(qa,'stop_group') as cleanup, patch.object(qa.signal,'signal'), patch.object(qa.signal,'alarm'), patch('builtins.print'):
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
            with patch.object(qa.subprocess,'Popen',return_value=proc), patch.object(qa,'wd',side_effect=driver), patch.object(qa,'stop_group') as cleanup, patch.object(qa.signal,'signal'), patch.object(qa.signal,'alarm'), patch('builtins.print'):
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
            with patch.object(qa.subprocess,'Popen',return_value=proc), patch.object(qa,'wd',side_effect=driver), patch.object(qa,'stop_group') as cleanup, patch.object(qa.signal,'signal'), patch.object(qa.signal,'alarm'), patch('builtins.print'):
                with self.assertRaises(KeyError): qa.probe(root,app)
                cleanup.assert_called_once_with(proc)

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
