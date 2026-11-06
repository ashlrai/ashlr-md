"""Exercise original ZIP transport against the real provenance verifier."""
import copy
import importlib.util
from pathlib import Path
import shutil
import unittest


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare = load('prepare_assembly', 'prepare-release-assembly.py')
fixture = load('assembly_fixture', 'test-release-provenance.py')


class HostedAssemblyTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture.ProvenanceTests()
        self.fixture.setUp()
        self.directory = Path(self.fixture.tmp.name) / 'original-zips'
        self.env = {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main',
                    'GITHUB_REPOSITORY': 'ashlrai/ashlr-md', 'GITHUB_REPOSITORY_ID': str(fixture.RID),
                    'GITHUB_SHA': fixture.OTHER}
        self.downloads = []

    def tearDown(self):
        self.fixture.tearDown()

    def download(self, artifact, destination):
        self.downloads.append(artifact['id'])
        shutil.copyfile(self.fixture.zips[artifact['name']], destination)

    def run_prepare(self, **kwargs):
        return prepare.prepare('v0.4.0', fixture.SHA, fixture.RUN, 1, self.directory,
                               env=self.env, api=self.fixture.api, download=kwargs.get('download', self.download))

    def test_original_bytes_and_all_live_proofs_are_retained(self):
        evidence = self.run_prepare()
        self.assertEqual(evidence['sha'], fixture.SHA)
        self.assertEqual(evidence['release_attempt'], 1)
        self.assertEqual(len(self.downloads), 4)
        self.assertEqual(sorted(p.name for p in self.directory.iterdir()),
                         sorted(name + '.zip' for name in prepare.provenance.LEGS))
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        for name, original in self.fixture.zips.items():
            self.assertEqual((self.directory / (name + '.zip')).read_bytes(), original.read_bytes())

    def test_main_only_repository_and_manual_context_precede_downloads(self):
        for key, value in [('GITHUB_REF', 'refs/tags/v0.4.0'), ('GITHUB_REF', 'refs/heads/feature'),
                           ('GITHUB_EVENT_NAME', 'pull_request'), ('GITHUB_REPOSITORY', 'foreign/repo'),
                           ('GITHUB_REPOSITORY_ID', '42'), ('GITHUB_SHA', 'not-a-sha')]:
            with self.subTest(key=key, value=value):
                env = {**self.env, key: value}
                with self.assertRaises(ValueError):
                    prepare.prepare('v0.4.0', fixture.SHA, fixture.RUN, 1, self.directory,
                                    env=env, api=self.fixture.api, download=self.download)
                self.assertFalse(self.directory.exists())
                self.assertEqual(self.downloads, [])

    def test_wrong_run_attempt_or_source_refuses_before_download(self):
        run = self.fixture.data[f'{fixture.REPO}/actions/runs/{fixture.RUN}']
        for key, value in [('run_attempt', 2), ('head_sha', fixture.OTHER), ('event', 'workflow_dispatch'),
                           ('head_branch', 'v0.4.1'), ('conclusion', 'failure')]:
            with self.subTest(key=key):
                original = run[key]
                run[key] = value
                with self.assertRaises(ValueError):
                    self.run_prepare()
                run[key] = original
                self.assertFalse(self.directory.exists())
                self.assertEqual(self.downloads, [])

    def test_exact_inventory_and_artifact_binding_are_required(self):
        path = f'{fixture.REPO}/actions/runs/{fixture.RUN}/artifacts?per_page=100&page=1'
        original = copy.deepcopy(self.fixture.data[path])
        changes = [lambda rows: rows.append({**rows[0], 'name': 'unexpected'}),
                   lambda rows: rows.pop(),
                   lambda rows: rows[0].update(expired=True),
                   lambda rows: rows[0]['workflow_run'].update(head_sha=fixture.OTHER),
                   lambda rows: rows[0].update(digest='sha256:bad'),
                   lambda rows: rows[0].update(id=rows[1]['id'])]
        for change in changes:
            data = copy.deepcopy(original)
            change(data['artifacts'])
            data['total_count'] = len(data['artifacts'])
            self.fixture.data[path] = data
            with self.assertRaises(ValueError):
                self.run_prepare()
            self.assertEqual(self.downloads, [])
            self.assertFalse(self.directory.exists())

    def test_substituted_zip_and_incomplete_ci_are_not_handoffs(self):
        def changed(artifact, destination):
            self.download(artifact, destination)
            destination.write_bytes(b'FAKE replaced ZIP')
        with self.assertRaises(ValueError):
            self.run_prepare(download=changed)
        self.assertFalse(self.directory.exists())
        path = f'{fixture.REPO}/actions/runs/{fixture.CI}/attempts/1/jobs?per_page=100&page=1'
        self.fixture.data[path]['jobs'][0]['conclusion'] = 'skipped'
        with self.assertRaisesRegex(ValueError, 'manual full CI'):
            self.run_prepare()
        self.assertFalse(self.directory.exists())

    def test_metadata_cannot_substitute_identical_bytes_under_new_artifact_ids(self):
        path = f'{fixture.REPO}/actions/runs/{fixture.RUN}/artifacts?per_page=100&page=1'
        changed = False
        def raced(artifact, destination):
            nonlocal changed
            self.download(artifact, destination)
            if not changed:
                changed = True
                self.fixture.data[path]['artifacts'][0]['id'] += 1000
        with self.assertRaisesRegex(ValueError, 'inventory changed'):
            self.run_prepare(download=raced)
        self.assertFalse(self.directory.exists())

    def test_existing_output_is_never_replaced_or_cleaned(self):
        self.directory.mkdir()
        sentinel = self.directory / 'keep'
        sentinel.write_text('existing owner')
        with self.assertRaises(FileExistsError):
            self.run_prepare()
        self.assertEqual(sentinel.read_text(), 'existing owner')
        self.assertEqual(self.downloads, [])

    def test_downloader_failure_removes_only_its_own_partial_staging(self):
        def unavailable(_artifact, destination):
            destination.write_bytes(b'FAKE incomplete transport')
            raise OSError('FAKE transport unavailable')
        with self.assertRaises(OSError):
            self.run_prepare(download=unavailable)
        self.assertFalse(self.directory.exists())


if __name__ == '__main__':
    unittest.main()
