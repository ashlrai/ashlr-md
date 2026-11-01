"""Synthetic, test-only GitHub provenance API and ZIP fixtures; no credentials."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('release_provenance', Path(__file__).with_name('release-provenance.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

SHA = 'a' * 40
OTHER = 'b' * 40
REPO = '/repos/ashlrai/ashlr-md'
RID = 1257779576
RUN = 2345
CI = 6789
RELEASE_WORKFLOW = 288178007
CI_WORKFLOW = 288178008
PLATFORMS = ('macos-15', 'macos-15-intel', 'ubuntu-22.04', 'windows-latest')

class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.zips = {}
        self.data = {}
        self.contents = {
            'src-tauri/tauri.conf.json': json.dumps({'version':'0.4.0','plugins':{'updater':{'pubkey':'test-public-key'}}}),
            'src-tauri/Cargo.toml': '[package]\nname="md-opener"\nversion="0.4.0"\n',
            'package.json': '{"name":"test","version":"0.4.0"}',
            '.github/workflows/release.yml': 'name: Release\n',
            '.github/workflows/ci.yml': 'name: CI\n',
        }
        for name, data in self.contents.items():
            self.data[f'{REPO}/contents/{name}?ref={SHA}'] = {'encoding':'base64', 'path':name, 'size':len(data.encode()), 'sha':hashlib.sha1(b'blob ' + str(len(data.encode())).encode() + b'\0' + data.encode()).hexdigest(), 'content':base64.b64encode(data.encode()).decode()}
        repo = {'id':RID, 'full_name':'ashlrai/ashlr-md'}
        self.data[f'{REPO}/git/ref/tags/v0.4.0'] = {'ref':'refs/tags/v0.4.0','object':{'type':'commit','sha':SHA}}
        self.data[f'{REPO}/actions/workflows/release.yml'] = {'id':RELEASE_WORKFLOW, 'path':'.github/workflows/release.yml'}
        self.data[f'{REPO}/actions/workflows/ci.yml'] = {'id':CI_WORKFLOW, 'path':'.github/workflows/ci.yml'}
        self.data[f'{REPO}/actions/runs/{RUN}'] = {'id':RUN,'workflow_id':RELEASE_WORKFLOW, 'path':'.github/workflows/release.yml', 'head_sha':SHA, 'head_branch':'v0.4.0', 'event':'push', 'status':'completed', 'conclusion':'success', 'run_attempt':1,'repository':repo,'head_repository':repo}
        steps = [{'name':'Build Tauri app','status':'completed','conclusion':'success'}, {'name':'Upload bundle artifacts','status':'completed','conclusion':'success'}]
        jobs = [{'id':n+1,'run_id':RUN,'head_sha':SHA,'name':f'Build & release ({platform})','status':'completed','conclusion':'success','steps':copy.deepcopy(steps)} for n,platform in enumerate(PLATFORMS)]
        jobs.append({'id':10,'run_id':RUN,'head_sha':SHA,'name':'Full suite green on release sha','status':'completed','conclusion':'success','steps':[{'name':'Require a successful workflow_dispatch CI run on this sha','status':'completed','conclusion':'success'}]})
        self.data[f'{REPO}/actions/runs/{RUN}/attempts/1/jobs?per_page=100&page=1'] = {'total_count':len(jobs),'jobs':jobs}
        ci = {'id':CI,'workflow_id':CI_WORKFLOW,'path':'.github/workflows/ci.yml','head_sha':SHA,'event':'workflow_dispatch','status':'completed','conclusion':'success','run_attempt':1,'repository':repo,'head_repository':repo}
        self.data[f'{REPO}/actions/workflows/ci.yml/runs?event=workflow_dispatch&head_sha={SHA}&per_page=100&page=1'] = {'total_count':1,'workflow_runs':[ci]}
        self.data[f'{REPO}/actions/runs/{CI}/attempts/1/jobs?per_page=100&page=1'] = {'total_count':2,'jobs':[{'id':101,'run_id':CI,'head_sha':SHA,'name':'Linux full suite','status':'completed','conclusion':'success'}, {'id':102,'run_id':CI,'head_sha':SHA,'name':'macOS full suite','status':'completed','conclusion':'success'}]}
        artifacts = []
        for n,platform in enumerate(PLATFORMS):
            name = f'bundle-{platform}'
            path = root / (name + '.zip')
            with zipfile.ZipFile(path,'w') as z: z.writestr('placeholder.txt',f'test-only {platform}')
            self.zips[name] = path
            artifacts.append({'id':500+n,'name':name,'size_in_bytes':path.stat().st_size,'expired':False,'digest':'sha256:'+hashlib.sha256(path.read_bytes()).hexdigest(),'workflow_run':{'id':RUN,'repository_id':RID,'head_repository_id':RID,'head_sha':SHA}})
        self.data[f'{REPO}/actions/runs/{RUN}/artifacts?per_page=100&page=1'] = {'total_count':4,'artifacts':artifacts}
    def tearDown(self): self.tmp.cleanup()
    def api(self, path):
        if path not in self.data: raise AssertionError(f'unexpected API path {path}')
        return copy.deepcopy(self.data[path])
    def verify(self): return p.verify_provenance(self.api, 'v0.4.0', SHA, RUN, self.zips)
    def test_happy_path(self): self.assertIsNotNone(self.verify())
    def test_wrong_tag_commit(self):
        self.data[f'{REPO}/git/ref/tags/v0.4.0']['object']['sha'] = OTHER
        with self.assertRaises((ValueError, RuntimeError)): self.verify()
    def test_wrong_head_sha_or_repo(self):
        run = self.data[f'{REPO}/actions/runs/{RUN}']; run['head_sha'] = OTHER
        with self.assertRaises((ValueError, RuntimeError)): self.verify()
        run['head_sha'] = SHA; run['head_repository'] = {'id':42,'full_name':'other/repo'}
        with self.assertRaises((ValueError, RuntimeError)): self.verify()
    def test_rerun_not_accepted(self):
        self.data[f'{REPO}/actions/runs/{RUN}']['run_attempt'] = 2
        with self.assertRaises((ValueError, RuntimeError)): self.verify()
    def test_missing_or_skipped_job(self):
        jobs = self.data[f'{REPO}/actions/runs/{RUN}/attempts/1/jobs?per_page=100&page=1']['jobs']
        response = self.data[f'{REPO}/actions/runs/{RUN}/attempts/1/jobs?per_page=100&page=1']
        removed = jobs.pop(0); response['total_count'] -= 1
        with self.assertRaisesRegex(ValueError, 'job Build & release'): self.verify()
        jobs.insert(0,removed); response['total_count'] += 1; jobs[0]['conclusion'] = 'skipped'
        with self.assertRaises((ValueError, RuntimeError)): self.verify()
    def test_job_run_and_sha_binding(self):
        jobs = self.data[f'{REPO}/actions/runs/{RUN}/attempts/1/jobs?per_page=100&page=1']['jobs']
        for key, wrong in (('run_id', 999), ('head_sha', OTHER)):
            old = jobs[0][key]; jobs[0][key] = wrong
            with self.assertRaisesRegex(ValueError, 'run/SHA mismatch'): self.verify()
            jobs[0][key] = old
    def test_artifact_size_mismatch(self):
        artifacts = self.data[f'{REPO}/actions/runs/{RUN}/artifacts?per_page=100&page=1']['artifacts']
        artifacts[0]['size_in_bytes'] += 1
        with self.assertRaisesRegex(ValueError, 'ZIP size mismatch'): self.verify()
    def test_skipped_build_or_upload(self):
        jobs = self.data[f'{REPO}/actions/runs/{RUN}/attempts/1/jobs?per_page=100&page=1']['jobs']
        for index in (0,1):
            jobs[0]['steps'][index]['conclusion'] = 'skipped'
            with self.assertRaises((ValueError, RuntimeError)): self.verify()
            jobs[0]['steps'][index]['conclusion'] = 'success'
    def test_expired_or_substituted_artifact(self):
        artifacts = self.data[f'{REPO}/actions/runs/{RUN}/artifacts?per_page=100&page=1']['artifacts']
        artifacts[0]['expired'] = True
        with self.assertRaises((ValueError, RuntimeError)): self.verify()
        artifacts[0]['expired'] = False
        self.zips[artifacts[0]['name']].write_bytes(b'substituted test-only ZIP')
        with self.assertRaises((ValueError, RuntimeError)): self.verify()
    def test_artifact_binding_and_duplicates(self):
        artifacts = self.data[f'{REPO}/actions/runs/{RUN}/artifacts?per_page=100&page=1']['artifacts']
        artifacts[0]['workflow_run']['head_sha'] = OTHER
        with self.assertRaises((ValueError, RuntimeError)): self.verify()
        artifacts[0]['workflow_run']['head_sha'] = SHA
        artifacts.append(copy.deepcopy(artifacts[0])); self.data[f'{REPO}/actions/runs/{RUN}/artifacts?per_page=100&page=1']['total_count'] += 1
        with self.assertRaisesRegex(ValueError, 'expected exactly one artifact'): self.verify()
    def test_missing_manual_full_ci(self):
        runs = self.data[f'{REPO}/actions/workflows/ci.yml/runs?event=workflow_dispatch&head_sha={SHA}&per_page=100&page=1']
        runs['workflow_runs'] = []; runs['total_count'] = 0
        with self.assertRaisesRegex(ValueError, 'no successful exact-SHA manual full CI'): self.verify()
    def test_run_identity_fields_and_failed_step(self):
        run = self.data[f'{REPO}/actions/runs/{RUN}']
        for field, value in [('head_branch', 'v0.3.0'), ('event','workflow_dispatch'), ('workflow_id',123), ('status','in_progress'), ('conclusion','failure')]:
            original = run[field]; run[field] = value
            with self.assertRaisesRegex(ValueError, 'identity/status'): self.verify()
            run[field] = original
        jobs = self.data[f'{REPO}/actions/runs/{RUN}/attempts/1/jobs?per_page=100&page=1']['jobs']
        jobs[0]['steps'][0]['conclusion'] = 'failure'
        with self.assertRaisesRegex(ValueError, 'step .* did not succeed'): self.verify()
    def test_ci_must_match_head_event_and_both_full_jobs(self):
        runs = self.data[f'{REPO}/actions/workflows/ci.yml/runs?event=workflow_dispatch&head_sha={SHA}&per_page=100&page=1']['workflow_runs']
        for field, value in [('head_sha', OTHER), ('event','push'), ('conclusion','failure'), ('workflow_id',123)]:
            original = runs[0][field]; runs[0][field] = value
            with self.assertRaisesRegex(ValueError, 'no successful exact-SHA manual full CI'): self.verify()
            runs[0][field] = original
        jobs = self.data[f'{REPO}/actions/runs/{CI}/attempts/1/jobs?per_page=100&page=1']['jobs']
        jobs[1]['conclusion'] = 'skipped'
        with self.assertRaisesRegex(ValueError, 'no successful exact-SHA manual full CI'): self.verify()
    def test_annotated_tag_peels_to_expected_sha(self):
        tagsha = 'c' * 40
        self.data[f'{REPO}/git/ref/tags/v0.4.0']['object'] = {'type':'tag','sha':tagsha}
        self.data[f'{REPO}/git/tags/{tagsha}'] = {'sha':tagsha,'object':{'type':'commit','sha':SHA}}
        self.assertIsNotNone(self.verify())
        self.data[f'{REPO}/git/tags/{tagsha}']['object']['sha'] = OTHER
        with self.assertRaisesRegex(ValueError, 'peeled tag'): self.verify()
    def test_api_error_does_not_accept_receipt(self):
        def error(_): raise OSError('test-only API unavailable')
        with self.assertRaisesRegex(OSError, 'unavailable'): p.verify_provenance(error, 'v0.4.0', SHA, RUN, self.zips)
    def test_missing_digest_or_wrong_artifact_run(self):
        artifacts = self.data[f'{REPO}/actions/runs/{RUN}/artifacts?per_page=100&page=1']['artifacts']
        original = artifacts[0]['digest']; artifacts[0]['digest'] = None
        with self.assertRaisesRegex(ValueError, 'identity/digest/expiry'): self.verify()
        artifacts[0]['digest'] = original; artifacts[0]['workflow_run']['id'] = 1
        with self.assertRaisesRegex(ValueError, 'identity/digest/expiry'): self.verify()
    def test_pagination_fetches_every_page_and_rejects_truncation(self):
        responses = {'/probe?per_page=100&page=1':{'total_count':101,'jobs':list(range(100))}, '/probe?per_page=100&page=2':{'total_count':101,'jobs':[100]}}
        self.assertEqual(p.pages(lambda path: responses[path], '/probe', 'jobs'), list(range(101)))
        responses['/probe?per_page=100&page=2']['jobs'] = []
        with self.assertRaisesRegex(ValueError, 'incomplete'): p.pages(lambda path: responses[path], '/probe', 'jobs')
    def test_live_contract_zip_assembly_integration(self):
        # Public vector from minisign-verify 0.2.5 README. Synthetic plain-text
        # payloads are not executables: platform inspection is mocked in this
        # test only; updater signature verification is the real Rust helper.
        key = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"
        sig = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA=="
        b64 = lambda x: base64.b64encode(x.encode()).decode()
        raw = json.dumps({'version':'0.4.0','plugins':{'updater':{'pubkey':b64(key)}}}).encode()
        content = self.data[f'{REPO}/contents/src-tauri/tauri.conf.json?ref={SHA}']
        content.update(content=base64.b64encode(raw).decode(), size=len(raw), sha=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest())
        names = {'bundle-macos-15':'Ashlr MD.app.tar.gz', 'bundle-macos-15-intel':'Ashlr MD.app.tar.gz', 'bundle-ubuntu-22.04':'Ashlr MD_0.4.0_amd64.AppImage', 'bundle-windows-latest':'Ashlr MD_0.4.0_x64-setup.exe'}
        artifacts = self.data[f'{REPO}/actions/runs/{RUN}/artifacts?per_page=100&page=1']['artifacts']
        for item in artifacts:
            name = names[item['name']]; path = self.zips[item['name']]
            with zipfile.ZipFile(path, 'w') as z:
                z.writestr('bundle/' + name, b'test')
                z.writestr('bundle/' + name + '.sig', b64(sig))
            item['digest'] = 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest(); item['size_in_bytes'] = path.stat().st_size
        def load(name):
            if name == 'release-provenance': return p
            return archive
        def module(filename, name):
            spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename)); result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result); return result
        archive = module('release-archive.py', 'test_release_archive')
        asm = module('assemble-updater.py', 'test_release_assembly')
        staging_root = Path(self.tmp.name) / 'private-release-staging'
        out = staging_root / 'staged'
        argv = ['assemble-updater.py', self.tmp.name, 'staged', '--tag','v0.4.0','--source-sha',SHA,'--run-id',str(RUN),'--pub-date','2026-01-01T00:00:00Z']
        with patch.object(asm, 'STAGING_ROOT', staging_root), patch.object(p, 'fetch', self.api), patch.object(asm, 'load_local', side_effect=load), patch.object(asm, 'verify_platform'), patch.object(sys, 'argv', argv):
            asm.main()
        manifest = json.loads((out/'latest.json').read_text()); report = json.loads((out/'provenance.json').read_text())
        self.assertEqual(set(manifest['platforms']), {'darwin-aarch64','darwin-x86_64','linux-x86_64','windows-x86_64'})
        self.assertEqual(manifest['platforms']['linux-x86_64']['signature'], b64(sig))
        self.assertEqual(report['release_run'], RUN)
        self.assertEqual(report['linux_version_evidence'], 'source-bound CI provenance, not embedded runtime version')
        self.assertEqual((out/'Ashlr_MD_0.4.0_amd64.AppImage').read_bytes(), b'test')
        # A substituted original ZIP cannot produce output despite valid API metadata.
        self.zips['bundle-macos-15'].write_bytes(b'substituted')
        bad = staging_root / 'bad'; argv[2] = 'bad'
        with patch.object(asm, 'STAGING_ROOT', staging_root), patch.object(p, 'fetch', self.api), patch.object(asm, 'load_local', side_effect=load), patch.object(asm, 'verify_platform'), patch.object(sys, 'argv', argv):
            with self.assertRaises(SystemExit) as error: asm.main()
        self.assertEqual(error.exception.code, 1); self.assertFalse(bad.exists())
        # An unavailable API likewise blocks before extraction or output.
        failed = staging_root / 'api-failed'; argv[2] = 'api-failed'
        def unavailable(_): raise OSError('synthetic API failure')
        with patch.object(asm, 'STAGING_ROOT', staging_root), patch.object(p, 'fetch', unavailable), patch.object(asm, 'load_local', side_effect=load), patch.object(asm, 'verify_platform'), patch.object(sys, 'argv', argv):
            with self.assertRaises(SystemExit) as error: asm.main()
        self.assertEqual(error.exception.code, 1); self.assertFalse(failed.exists())
        # Even a ZIP whose API digest is internally consistent cannot make an
        # invalid updater signature pass the actual cryptographic verifier.
        original = artifacts[0]; name = names[original['name']]; path = self.zips[original['name']]
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('bundle/' + name, b'tampered signed bytes')
            z.writestr('bundle/' + name + '.sig', b64(sig))
        original['digest'] = 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest(); original['size_in_bytes'] = path.stat().st_size
        bad_sig = staging_root / 'bad-signature'; argv[2] = 'bad-signature'
        with patch.object(asm, 'STAGING_ROOT', staging_root), patch.object(p, 'fetch', self.api), patch.object(asm, 'load_local', side_effect=load), patch.object(asm, 'verify_platform'), patch.object(sys, 'argv', argv):
            with self.assertRaises(SystemExit) as error: asm.main()
        self.assertEqual(error.exception.code, 1); self.assertFalse(bad_sig.exists())
    def test_source_versions_disagree(self):
        data = self.data[f'{REPO}/contents/package.json?ref={SHA}']
        raw = b'{"version":"9.9.9"}'
        data['content'] = base64.b64encode(raw).decode(); data['size'] = len(raw); data['sha'] = hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
        with self.assertRaises((ValueError, RuntimeError)): self.verify()

if __name__ == '__main__': unittest.main()
