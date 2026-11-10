#!/usr/bin/env python3
"""Offline checks for the verified-release publisher. No GitHub calls."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    'publish_verified_release',
    Path(__file__).resolve().with_name('publish-verified-release.py'),
)
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)

SHA = 'a' * 40
OTHER = 'b' * 40
TAG_OBJECT = 'c' * 40
VERSION = '0.4.0'
TAG = f'v{VERSION}'
WORKFLOW = Path(__file__).resolve().parents[1] / '.github/workflows/release-publish.yml'
SOURCE = Path(__file__).resolve().with_name('publish-verified-release.py')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def leg_zips():
    return {name: f'{name}.zip' for name in publish.provenance.LEGS}


class PublishTests(unittest.TestCase):
    def test_workflow_does_not_check_out_or_run_the_triggering_run(self):
        text = WORKFLOW.read_text()
        resolve, publish_job = text.split('\n  publish:\n', 1)
        self.assertNotIn('head_sha', text)
        self.assertNotIn('pull_request_target', text)
        self.assertNotIn('id-token', text)
        self.assertNotIn('NPM_TOKEN', text)
        self.assertNotIn('secrets.', text)
        self.assertNotIn('echo "$GH_TOKEN"', text)
        self.assertNotIn('echo "$GITHUB_TOKEN"', text)
        self.assertNotIn('git checkout', text)
        self.assertNotIn('git push', text)
        self.assertNotIn('chmod', text)
        self.assertEqual(text.count('ref: ${{ github.sha }}'), 2)
        self.assertEqual(text.count('persist-credentials: false'), 2)
        self.assertIn('python3 scripts/publish-verified-release.py --mode resolve', text)
        self.assertIn('python3 scripts/publish-verified-release.py --mode publish', text)
        self.assertNotIn('python3 publish-data', text)
        self.assertNotIn('bash publish-data', text)
        self.assertIn("github.repository == 'ashlrai/ashlr-md'", text)
        self.assertIn("event == 'workflow_dispatch'", text)
        self.assertIn("head_branch == 'main'", text)
        self.assertIn('head_repository.full_name == github.repository', text)
        self.assertIn("run_attempt == 1", text)
        self.assertEqual(text.count("github.ref == 'refs/heads/main'"), 2)
        self.assertIn("github.event_name == 'workflow_dispatch'", publish_job)
        self.assertIn('assemble_run_id:', text)
        self.assertIn('inputs.assemble_run_id', publish_job)
        self.assertNotIn('ref: ${{ inputs', text)
        self.assertNotIn('ref: ${{ github.event.inputs', text)
        self.assertNotIn('environment:', resolve)
        self.assertNotIn('contents: write', resolve)
        self.assertIn('permissions: {}', text)
        source = SOURCE.read_text()
        self.assertNotIn('head_sha', source)
        self.assertNotIn('git push', source)
        self.assertNotIn('git checkout', source)
        self.assertIn('verify_provenance(', source)
        self.assertIn('peel_annotated_tag(', source)
        self.assertIn("refusing to mutate a git object", source)

    def test_main_dispatch_uses_the_same_assemble_run_checks(self):
        previous = (os.environ.get('ASSEMBLE_RUN_ID'), os.environ.get('ASSEMBLE_ATTEMPT'))
        os.environ['ASSEMBLE_RUN_ID'] = '42747484631;touch /tmp/pwned'
        os.environ['ASSEMBLE_ATTEMPT'] = '1'
        try:
            with self.assertRaisesRegex(ValueError, 'only assembly attempt 1'):
                publish.environ_run()
        finally:
            for key, value in zip(('ASSEMBLE_RUN_ID', 'ASSEMBLE_ATTEMPT'), previous):
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

        def assemble_run(branch):
            def api(path):
                if path.endswith('/actions/runs/42747484631'):
                    return {
                        'path': '.github/workflows/release-assemble.yml',
                        'event': 'workflow_dispatch',
                        'head_branch': branch,
                        'run_attempt': 1,
                        'status': 'completed',
                        'conclusion': 'success',
                        'repository': {'full_name': 'ashlrai/ashlr-md'},
                        'head_repository': {'full_name': 'ashlrai/ashlr-md'},
                    }
                if path.endswith('/attempts/1/jobs?per_page=100&page=1'):
                    return {'total_count': 1, 'jobs': [{
                        'name': 'assemble', 'status': 'completed', 'conclusion': 'success',
                    }]}
                raise AssertionError(path)
            return api

        with self.assertRaisesRegex(ValueError, 'successful main dispatch'):
            publish.require_assemble_success(assemble_run('feature'), 42747484631)
        publish.require_assemble_success(assemble_run('main'), 42747484631)

    def test_publish_job_uses_the_production_environment(self):
        text = WORKFLOW.read_text()
        publish_job = text.split('\n  publish:\n', 1)[1]
        self.assertIn('\n    environment: Production\n', '\n' + publish_job)
        self.assertEqual(text.count('environment:'), 1)
        self.assertNotIn('environment: release', text)

    def test_concurrency_is_the_release_tag_and_existing_releases_are_refused(self):
        publish_job = WORKFLOW.read_text().split('\n  publish:\n', 1)[1]
        self.assertIn('group: release-publish-${{ needs.resolve.outputs.tag }}', publish_job)
        self.assertIn('cancel-in-progress: false', publish_job)
        group = [line.strip() for line in publish_job.splitlines() if line.strip().startswith('group:')]
        self.assertEqual(group, ['group: release-publish-${{ needs.resolve.outputs.tag }}'])
        calls = []

        def api(path):
            calls.append(path)
            if path.endswith(f'/releases/tags/{TAG}'):
                return {'draft': True, 'tag_name': TAG}
            raise AssertionError(path)

        with self.assertRaisesRegex(ValueError, 'a GitHub Release already exists for this tag'):
            publish.assert_release_absent(api, TAG)
        self.assertEqual(calls, [f'{publish.provenance.REPO}/releases/tags/{TAG}'])

        def published(path):
            if path.endswith(f'/releases/tags/{TAG}'):
                return {'draft': False, 'tag_name': TAG}
            raise AssertionError(path)

        with self.assertRaisesRegex(ValueError, 'a GitHub Release already exists for this tag'):
            publish.assert_release_absent(published, TAG)

        writes = []

        def absent(path):
            if path.endswith(f'/git/ref/tags/{TAG}'):
                return {'ref': f'refs/tags/{TAG}', 'object': {'type': 'commit', 'sha': SHA}}
            if path.endswith(f'/releases/tags/{TAG}'):
                raise FileNotFoundError(path)
            if path.endswith('/releases/9'):
                return {'id': 9, 'tag_name': TAG, 'draft': False, 'make_latest': 'true'}
            if path.endswith('/releases/latest'):
                return {'tag_name': TAG, 'draft': False}
            raise AssertionError(path)

        def write(method, path, body=None):
            writes.append((method, path, body))
            if method != 'GET' and '/git/' in path:
                raise AssertionError('git mutation')
            raise AssertionError('write after a release exists')

        def existing(path):
            if path.endswith(f'/releases/tags/{TAG}'):
                return {'draft': False, 'tag_name': TAG, 'id': 4}
            if path.endswith(f'/git/ref/tags/{TAG}'):
                return {'ref': f'refs/tags/{TAG}', 'object': {'type': 'commit', 'sha': SHA}}
            raise AssertionError(path)

        with self.assertRaisesRegex(ValueError, 'a GitHub Release already exists for this tag'):
            publish.publish_release(existing, write, TAG, SHA, 'notes\n', [], lambda *_args: None)
        self.assertEqual(writes, [])

        def create(method, path, body=None):
            writes.append((method, path, body))
            if method != 'GET' and '/git/' in path:
                raise AssertionError('git mutation')
            if method == 'POST':
                self.assertEqual(body['tag_name'], TAG)
                self.assertNotIn('target_commitish', body)
                self.assertTrue(body['draft'])
                self.assertFalse(body['generate_release_notes'])
                self.assertEqual(body['make_latest'], 'false')
                self.assertIn('"make_latest": "false"', json.dumps(body))
                return {'id': 9, 'tag_name': TAG, 'draft': True}
            if method == 'PATCH':
                self.assertEqual(body, {'draft': False, 'make_latest': 'true'})
                return {'id': 9, 'tag_name': TAG, 'draft': False}
            raise AssertionError(method)

        asset = None
        with tempfile.TemporaryDirectory() as tmp:
            asset = Path(tmp) / 'Ashlr_MD_0.4.0_amd64.deb'
            asset.write_bytes(b'deb')
            published_release = publish.publish_release(
                absent, create, TAG, SHA, 'notes\n', [asset], lambda tag, path: writes.append(('UPLOAD', tag, path.name)))
        self.assertFalse(published_release['draft'])
        self.assertNotIn('DELETE', [method for method, _path, _body in writes])
        self.assertTrue(all(method in ('POST', 'PATCH', 'UPLOAD') or '/git/' not in path
                            for method, path, _body in writes))

    def test_publish_fails_unless_the_reread_release_is_latest(self):
        def api(path, make_latest='true', latest_tag=TAG):
            if path.endswith(f'/git/ref/tags/{TAG}'):
                return {'ref': f'refs/tags/{TAG}', 'object': {'type': 'commit', 'sha': SHA}}
            if path.endswith(f'/releases/tags/{TAG}'):
                raise FileNotFoundError(path)
            if path.endswith('/releases/9'):
                return {'id': 9, 'tag_name': TAG, 'draft': False, 'make_latest': make_latest}
            if path.endswith('/releases/latest'):
                return {'tag_name': latest_tag, 'draft': False}
            raise AssertionError(path)

        def write(method, path, body=None):
            if method == 'POST':
                return {'id': 9, 'tag_name': TAG, 'draft': True}
            if method == 'PATCH':
                return {'id': 9, 'tag_name': TAG, 'draft': False}
            if method == 'DELETE':
                raise AssertionError('published release must not be deleted')
            raise AssertionError(method)

        with self.assertRaisesRegex(ValueError, 'not marked make_latest'):
            publish.publish_release(lambda path: api(path, make_latest='false'), write, TAG, SHA, 'notes\n', [], lambda *_args: None)
        with self.assertRaisesRegex(ValueError, 'not the latest release'):
            publish.publish_release(lambda path: api(path, latest_tag='v9.9.9'), write, TAG, SHA, 'notes\n', [], lambda *_args: None)

    def test_abort_reports_a_tag_this_run_created_and_does_not_delete_it(self):
        peels = {'n': 0}

        def api(path):
            if path.endswith(f'/git/ref/tags/{TAG}'):
                peels['n'] += 1
                pointed = SHA if peels['n'] == 1 else OTHER
                return {'ref': f'refs/tags/{TAG}', 'object': {'type': 'commit', 'sha': pointed}}
            if path.endswith(f'/releases/tags/{TAG}'):
                raise FileNotFoundError(path)
            raise AssertionError(path)

        writes = []

        def write(method, path, body=None):
            writes.append((method, path))
            if '/git/' in path:
                raise AssertionError('git mutation')
            if method == 'POST':
                return {'id': 9, 'tag_name': TAG, 'draft': True}
            if method == 'DELETE':
                self.assertEqual(path, '/repos/ashlrai/ashlr-md/releases/9')
                return {}
            raise AssertionError(method)

        with self.assertRaises(ValueError) as caught:
            publish.publish_release(api, write, TAG, SHA, 'notes\n', [], lambda *_args: None)
        message = str(caught.exception)
        self.assertIn('was not deleted', message)
        self.assertIn(OTHER, message)
        self.assertIn(SHA, message)
        self.assertNotIn('git/', ' '.join(path for _method, path in writes))
        self.assertIn(('DELETE', '/repos/ashlrai/ashlr-md/releases/9'), writes)

    def test_created_tag_report_scrubs_secrets(self):
        secrets = (
            'ghp_FAKEFAKEFAKEFAKE',
            'ghr_FAKEFAKEFAKEFAKE',
            'Bearer fake-bearer-token',
            'bearer FAKE-BEARER-TOKEN',
        )
        leaked = ' '.join(secrets)

        def api(path):
            if path.endswith(f'/git/ref/tags/{TAG}'):
                return {'ref': f'refs/tags/{TAG}', 'object': {'type': 'commit', 'sha': leaked}}
            raise AssertionError(path)

        with self.assertRaises(ValueError) as caught:
            publish.report_tag_created_during_publish(api, TAG, SHA, RuntimeError('upload failed'))
        message = str(caught.exception)
        self.assertIn('was not deleted', message)
        self.assertIn(SHA, message)
        self.assertIn('[redacted]', message)
        for secret in secrets:
            self.assertNotIn(secret, message)
        self.assertNotIn('fake-bearer-token', message)
        self.assertNotIn('FAKE-BEARER-TOKEN', message)

    def test_annotated_peel_and_binding_come_from_provenance(self):
        seen = []

        def api(path):
            seen.append(path)
            if path.endswith(f'/git/ref/tags/{TAG}'):
                return {'ref': f'refs/tags/{TAG}', 'object': {'type': 'tag', 'sha': TAG_OBJECT}}
            if path.endswith(f'/git/tags/{TAG_OBJECT}'):
                return {'sha': TAG_OBJECT, 'object': {'type': 'commit', 'sha': OTHER}}
            raise AssertionError(path)

        with self.assertRaisesRegex(ValueError, 'peeled tag does not match reviewed SHA'):
            publish.prove(api, TAG, SHA, 1, leg_zips(), None)
        self.assertIn(f'{publish.provenance.REPO}/git/tags/{TAG_OBJECT}', seen)
        previous = os.environ.get('EXPECTED_TAG')
        os.environ['EXPECTED_TAG'] = TAG
        try:
            self.assertEqual(publish.lock_tag(TAG), TAG)
            with self.assertRaisesRegex(ValueError, 'publish lock'):
                publish.lock_tag('v0.4.1')
        finally:
            if previous is None:
                os.environ.pop('EXPECTED_TAG', None)
            else:
                os.environ['EXPECTED_TAG'] = previous

    def test_staging_hashes_signatures_and_installer_bytes(self):
        calls = []

        def verifier(pubkey, sig, payload):
            calls.append((pubkey, sig.read_text(encoding='utf-8'), payload.read_bytes()))

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            selected = {}
            signature = 'good-sig\n'
            payload = b'payload'
            for target, suffix in publish.UPDATERS.items():
                name = publish.asset_name(VERSION, suffix)
                (root / name).write_bytes(payload)
                (root / (name + '.sig')).write_text(signature, encoding='utf-8')
                selected[target] = {
                    'asset_sha256': digest(payload),
                    'signature_sha256': digest(signature.encode()),
                }
            record = {'version': VERSION, 'tag': TAG, 'sha': SHA, 'selected_assets': selected}
            (root / 'provenance.json').write_text(json.dumps(record), encoding='utf-8')
            manifest = publish.latest_manifest(
                VERSION, '2026-11-10T00:00:00Z', {target: signature for target in publish.UPDATERS})
            (root / 'latest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
            verified = publish.verify_staging(root, 'public-key', VERSION, TAG, SHA, verifier)
            self.assertEqual(verified['sha'], SHA)
            self.assertEqual(len(calls), 4)
            self.assertTrue(all(item[0] == 'public-key' and item[2] == payload for item in calls))
            (root / publish.asset_name(VERSION, 'amd64.AppImage')).write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'does not match provenance hashes'):
                publish.verify_staging(root, 'public-key', VERSION, TAG, SHA, verifier)

            unpacked = {}
            for leg, source_name, _suffix in publish.INSTALLERS:
                unpacked.setdefault(leg, root / leg)
                unpacked[leg].mkdir(exist_ok=True)
                nested = unpacked[leg] / 'nested'
                nested.mkdir(exist_ok=True)
                (nested / source_name.format(version=VERSION)).write_bytes(b'installer-' + leg.encode())
            renamed = publish.rename_installers(unpacked, VERSION, root / 'out')
            self.assertEqual(renamed[0].read_bytes(), b'installer-bundle-macos-15')
            extra = unpacked['bundle-macos-15'] / 'Ashlr MD_0.4.0_aarch64.dmg'
            extra.write_bytes(b'other')
            with self.assertRaisesRegex(ValueError, 'expected exactly one'):
                publish.rename_installers(unpacked, VERSION, root / 'again')

    def test_changelog_section_and_failed_upload_removes_the_draft(self):
        notes = publish.changelog_notes(
            '# Log\n\n## [0.4.0] - 2026-01-01\n\n- Fixed.\n\n## [0.3.0] - 2025-01-01\n\n- Old.\n',
            VERSION,
        )
        self.assertIn('Fixed.', notes)
        self.assertNotIn('0.3.0', notes)
        writes = []

        def absent(path):
            if path.endswith(f'/git/ref/tags/{TAG}'):
                return {'ref': f'refs/tags/{TAG}', 'object': {'type': 'commit', 'sha': SHA}}
            if path.endswith(f'/releases/tags/{TAG}'):
                raise FileNotFoundError(path)
            raise AssertionError(path)

        def write(method, path, body=None):
            writes.append(method)
            if method == 'POST':
                return {'id': 9, 'tag_name': TAG, 'draft': True}
            if method == 'DELETE':
                self.assertEqual(path, '/repos/ashlrai/ashlr-md/releases/9')
                return {}
            raise AssertionError(method)

        def explode(_tag, _path):
            raise ValueError('asset upload failed')

        with self.assertRaisesRegex(ValueError, 'asset upload failed'):
            publish.publish_release(absent, write, TAG, SHA, notes, ['unused'], explode)
        self.assertEqual(writes, ['POST', 'DELETE'])

    def test_write_failure_reports_http_status_and_hides_the_token(self):
        secrets = (
            'ghp_FAKEFAKEFAKEFAKE',
            'ghs_FAKEFAKEFAKEFAKE',
            'github_pat_FAKEFAKEFAKEFAKE',
            'gho_FAKEFAKEFAKEFAKE',
            'ghu_FAKEFAKEFAKEFAKE',
            'ghr_FAKEFAKEFAKEFAKE',
            'Bearer fake-bearer-token',
            'bearer FAKE-BEARER-TOKEN',
        )
        cases = (
            ('422', 'Validation Failed', 'Draft releases cannot be set as latest'),
            ('403', 'Resource not accessible by integration', 'Resource not accessible by integration'),
        )
        for status, summary, detail in cases:
            with tempfile.TemporaryDirectory() as tmp:
                fake = Path(tmp) / 'gh'
                fake.write_text(
                    '#!/bin/sh\n'
                    f'echo \'{{"message":"{summary}","errors":[{{"message":"{detail}"}}],"status":"{status}"}}\'\n'
                    f'echo "gh: {summary} (HTTP {status})" >&2\n'
                    'echo "token ghp_FAKEFAKEFAKEFAKE ghs_FAKEFAKEFAKEFAKE github_pat_FAKEFAKEFAKEFAKE '
                    'gho_FAKEFAKEFAKEFAKE ghu_FAKEFAKEFAKEFAKE ghr_FAKEFAKEFAKEFAKE '
                    'Bearer fake-bearer-token bearer FAKE-BEARER-TOKEN" >&2\n'
                    'exit 1\n',
                    encoding='utf-8',
                )
                fake.chmod(0o755)
                previous_path = os.environ.get('PATH', '')
                previous_token = os.environ.get('GH_TOKEN')
                os.environ['PATH'] = tmp + os.pathsep + previous_path
                os.environ['GH_TOKEN'] = secrets[0]
                try:
                    with self.assertRaises(ValueError) as caught:
                        publish.gh_write('POST', '/repos/ashlrai/ashlr-md/releases', {'draft': True})
                finally:
                    os.environ['PATH'] = previous_path
                    if previous_token is None:
                        os.environ.pop('GH_TOKEN', None)
                    else:
                        os.environ['GH_TOKEN'] = previous_token
            message = str(caught.exception)
            self.assertIn(f'HTTP {status}', message)
            self.assertIn(detail, message)
            for secret in secrets:
                self.assertNotIn(secret, message)
            self.assertNotIn('fake-bearer-token', message)
            self.assertNotIn('FAKE-BEARER-TOKEN', message)


if __name__ == '__main__':
    unittest.main()
