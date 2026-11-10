#!/usr/bin/env python3
"""Offline checks for the verified-release publisher. No GitHub calls."""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import importlib.util

spec = importlib.util.spec_from_file_location(
    'publish_verified_release',
    Path(__file__).resolve().with_name('publish-verified-release.py'),
)
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)

SHA = 'a' * 40
VERSION = '0.4.0'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def staging(root, payload=b'payload', signature='good-sig\n'):
    root = Path(root)
    selected = {}
    for target, suffix in publish.UPDATERS.items():
        name = publish.asset_name(VERSION, suffix)
        (root / name).write_bytes(payload)
        (root / (name + '.sig')).write_text(signature)
        selected[target] = {
            'asset_sha256': digest(payload),
            'signature_sha256': digest(signature.encode()),
        }
    provenance = {'version': VERSION, 'tag': f'v{VERSION}', 'sha': SHA, 'selected_assets': selected,
                  'artifacts': {name: {'id': index + 1, 'digest': 'sha256:' + digest(b'zip-' + name.encode())}
                                for index, name in enumerate(sorted(publish.INSTALLERS and [
                                    'bundle-macos-15', 'bundle-macos-15-intel',
                                    'bundle-ubuntu-22.04', 'bundle-windows-latest']))}}
    (root / 'provenance.json').write_text(json.dumps(provenance))
    manifest = publish.latest_manifest(VERSION, '2026-11-10T00:00:00Z',
                                       {target: signature for target in publish.UPDATERS})
    (root / 'latest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return provenance


class PublishTests(unittest.TestCase):
    def test_staging_hashes_signatures_and_rewritten_manifest(self):
        calls = []

        def verifier(pubkey, sig, payload):
            calls.append((pubkey, sig.read_text(), payload.read_bytes()))

        with tempfile.TemporaryDirectory() as tmp:
            staging(tmp)
            verified = publish.verify_staging(tmp, 'public-key', verifier)
            self.assertEqual(verified['sha'], SHA)
            self.assertEqual(len(calls), 4)
            self.assertTrue(all(item[0] == 'public-key' and item[2] == b'payload' for item in calls))
            self.assertEqual(json.loads((Path(tmp) / 'latest.json').read_text())['version'], VERSION)
            (Path(tmp) / publish.asset_name(VERSION, 'amd64.AppImage')).write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'does not match provenance hashes'):
                publish.verify_staging(tmp, 'public-key', verifier)

    def test_publish_as_rename_preserves_bytes_and_rejects_duplicates(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            unpacked = {}
            for leg, source_name, _publish_name in publish.INSTALLERS:
                unpacked.setdefault(leg, root / leg)
                unpacked[leg].mkdir(exist_ok=True)
                (unpacked[leg] / 'nested').mkdir(exist_ok=True)
                (unpacked[leg] / 'nested' / source_name.format(version=VERSION)).write_bytes(b'installer-' + leg.encode())
            renamed = publish.rename_installers(unpacked, VERSION, root / 'out')
            self.assertEqual(
                [path.name for path in renamed],
                [name.format(version=VERSION) for _leg, _source, name in publish.INSTALLERS],
            )
            self.assertEqual(renamed[0].read_bytes(), b'installer-bundle-macos-15')
            extra = unpacked['bundle-macos-15'] / 'Ashlr MD_0.4.0_aarch64.dmg'
            extra.write_bytes(b'other')
            with self.assertRaisesRegex(ValueError, 'expected exactly one'):
                publish.rename_installers(unpacked, VERSION, root / 'again')

    def test_publish_does_not_move_the_tag_and_refuses_a_published_release(self):
        calls = []
        uploads = []

        def api(method, path, body=None):
            calls.append((method, path, body))
            if method != 'GET' and '/git/' in path:
                raise AssertionError('git mutation')
            if path.endswith(f'/git/ref/tags/v{VERSION}'):
                return {'ref': f'refs/tags/v{VERSION}', 'object': {'type': 'commit', 'sha': SHA}}
            if path.endswith('/releases/latest'):
                raise FileNotFoundError(path)
            if path.endswith(f'/releases/tags/v{VERSION}'):
                raise FileNotFoundError(path)
            if method == 'POST' and path.endswith('/releases'):
                self.assertEqual(body['target_commitish'], SHA)
                self.assertEqual(body['tag_name'], f'v{VERSION}')
                self.assertTrue(body['draft'])
                self.assertFalse(body['generate_release_notes'])
                return {'id': 9, 'tag_name': f'v{VERSION}', 'draft': True, 'assets': []}
            if method == 'PATCH':
                self.assertEqual(body, {'draft': False})
                return {'id': 9, 'tag_name': f'v{VERSION}', 'draft': False}
            raise AssertionError(path)

        with tempfile.TemporaryDirectory() as tmp:
            asset = Path(tmp) / 'Ashlr_MD_0.4.0_amd64.deb'
            asset.write_bytes(b'deb')
            published = publish.publish_github(f'v{VERSION}', SHA, 'notes\n', [asset], api, lambda tag, path: uploads.append((tag, path.name)))
        self.assertFalse(published['draft'])
        self.assertEqual(uploads, [(f'v{VERSION}', asset.name)])
        self.assertTrue(all(method == 'GET' or '/git/' not in path for method, path, _body in calls))
        calls.clear()

        def published_release(method, path, body=None):
            if path.endswith(f'/releases/tags/v{VERSION}'):
                return {'draft': False, 'tag_name': f'v{VERSION}', 'target_commitish': SHA}
            if path.endswith(f'/git/ref/tags/v{VERSION}'):
                return {'ref': f'refs/tags/v{VERSION}', 'object': {'type': 'commit', 'sha': SHA}}
            raise AssertionError(path)

        with self.assertRaisesRegex(ValueError, 'tag is already published'):
            publish.publish_github(f'v{VERSION}', SHA, 'notes\n', [], published_release, lambda *_args: None)
        self.assertIsNone(publish.bind_exact_tag(f'v{VERSION}', SHA, {
            'inputs_version': VERSION, 'version': VERSION, 'tag': f'v{VERSION}', 'sha': SHA}))
        with self.assertRaisesRegex(ValueError, 'prepare binding does not match the assembled tag'):
            publish.bind_exact_tag(f'v{VERSION}', SHA, {
                'inputs_version': '0.9.9', 'version': '0.9.9', 'tag': 'v0.9.9', 'sha': 'b' * 40})
        def older(method, path, body=None):
            if path.endswith('/releases/latest'):
                return {'tag_name': 'v0.9.0', 'draft': False}
            if path.endswith(f'/releases/tags/v{VERSION}'):
                raise FileNotFoundError(path)
            if path.endswith(f'/git/ref/tags/v{VERSION}'):
                return {'ref': f'refs/tags/v{VERSION}', 'object': {'type': 'commit', 'sha': SHA}}
            raise AssertionError(path)
        with self.assertRaisesRegex(ValueError, 'not strictly greater'):
            publish.publish_github(f'v{VERSION}', SHA, 'notes\n', [], older, lambda *_args: None)

    def test_original_zip_digest_is_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = b'zip-bytes'
            artifacts = {
                'bundle-macos-15': {'id': 1, 'digest': 'sha256:' + digest(body)},
                'bundle-macos-15-intel': {'id': 2, 'digest': 'sha256:' + digest(body)},
                'bundle-ubuntu-22.04': {'id': 3, 'digest': 'sha256:' + digest(b'nope')},
                'bundle-windows-latest': {'id': 4, 'digest': 'sha256:' + digest(body)},
            }

            def download(artifact_id, archive):
                archive.write_bytes(body)

            def unpack(archive, expected, dest):
                dest.mkdir()
                return {}

            with self.assertRaisesRegex(ValueError, 'does not match provenance digest'):
                publish.fetch_original_zips(artifacts, tmp, download, unpack)

    def test_changelog_section_and_workflow_contract(self):
        notes = publish.changelog_notes('# Log\n\n## [0.4.0] - 2026-01-01\n\n- Fixed.\n\n## [0.3.0] - 2025-01-01\n\n- Old.\n', VERSION)
        self.assertIn('Fixed.', notes)
        self.assertNotIn('0.3.0', notes)
        text = (Path(__file__).resolve().parents[1] / '.github/workflows/release-publish.yml').read_text()
        self.assertIn('contents: write', text)
        self.assertEqual(text.count('contents: write'), 1)
        self.assertNotIn('git push', text)
        self.assertNotIn('contents: write', text.split('jobs:', 1)[0])
        self.assertIn('persist-credentials: false', text)
        self.assertIn("== 'assemble'", Path(__file__).resolve().with_name('publish-verified-release.py').read_text())
        source = Path(__file__).resolve().with_name('publish-verified-release.py').read_text()
        self.assertNotIn('git push', source)
        self.assertIn("refusing to mutate a git object", source)


if __name__ == '__main__':
    unittest.main()
