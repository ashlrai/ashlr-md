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
                self.assertEqual(body['target_commitish'], SHA)
                self.assertTrue(body['draft'])
                self.assertFalse(body['generate_release_notes'])
                return {'id': 9, 'tag_name': TAG, 'draft': True}
            if method == 'PATCH':
                self.assertEqual(body, {'draft': False})
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


if __name__ == '__main__':
    unittest.main()
