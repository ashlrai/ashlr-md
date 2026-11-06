#!/usr/bin/env python3
import hashlib
import importlib.util
from pathlib import Path
import sys
import time
import unittest

spec = importlib.util.spec_from_file_location('apt_plan', Path(__file__).with_name('apt-dependency-plan.py'))
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


def inst(name='libwebkit2gtk-4.1-dev', version='2.0', arch='amd64'):
    return f'Inst {name} ({version} Ubuntu:22.04/jammy [{arch}])\n'


def metadata(name='libwebkit2gtk-4.1-dev', version='2.0', arch='amd64', size=100):
    return f'Package: {name}\nVersion: {version}\nArchitecture: {arch}\nSize: {size}\nInstalled-Size: 99999\n\n'


class AptPlanTests(unittest.TestCase):
    def test_exact_epoch_multiarch_and_archive_size(self):
        text = inst('libfoo:amd64', '1:2.3-4~ubuntu1')
        rows = plan.parse_plan(text)
        self.assertEqual(list(rows), [('libfoo', '1:2.3-4~ubuntu1', 'amd64')])
        self.assertEqual(plan.parse_metadata(metadata('libfoo', '1:2.3-4~ubuntu1'))[next(iter(rows))], 100)
        self.assertIn(('data-common', '1', 'all'), plan.parse_plan(inst('data-common', '1', 'all')))

    def test_malformed_duplicate_or_removal_plan_refuses(self):
        for text in [inst() * 2, 'Remv curl [1]\n', 'Inst malformed\n', inst('libfoo:arm64'),
                     ''.join(inst(f'pkg-{i}') for i in range(plan.MAX_PACKAGES + 1))]:
            with self.subTest(text=text[:80]), self.assertRaises(ValueError):
                plan.parse_plan(text)

    def test_missing_negative_overflow_and_ambiguous_archive_size_refuse(self):
        for text in [metadata(size=0), metadata(size=-1), metadata(size=4 * 1024**3 + 1),
                     metadata().replace('Size: 100\n', ''), metadata() + metadata(size=101),
                     metadata().replace('Size: 100\n', 'Size: 100\nSize: 100\n')]:
            with self.subTest(text=text[:80]), self.assertRaises(ValueError):
                plan.parse_metadata(text)
        # Identical repository mirrors do not double-count one package archive.
        self.assertEqual(len(plan.parse_metadata(metadata() * 2)), 1)

    def test_summary_requires_exact_metadata_and_all_explicit_roots(self):
        installed = {name: ('1', 'amd64') for name in plan.PACKAGES}
        report = plan.summarize(inst(), metadata(), installed)
        self.assertEqual(report['archiveBytesEstimate'], 100)
        self.assertEqual(len(report['requiredPackageVersions']), 10)
        for data in ['', metadata(version='3.0'), metadata() + metadata('unexpected')]:
            with self.assertRaises(ValueError):
                plan.summarize(inst(), data, installed)
        installed[plan.PACKAGES[0]] = None
        with self.assertRaises(ValueError):
            plan.summarize('', '', installed)

    def fake_runner(self, fail=None, minimal='normal'):
        calls = []
        def run(argv):
            calls.append(argv)
            if argv[0].endswith('dpkg-query'):
                if argv[-1] == plan.PACKAGES[0]:
                    return 1, f'dpkg-query: no packages found matching {argv[-1]}\n'
                return 0, 'installed\t1\tamd64\n'
            if fail and argv[0].endswith(fail):
                return 7, 'synthetic unavailable command\n'
            if argv[0].endswith('apt-get'):
                base = inst()
                if '--no-install-recommends' not in argv:
                    return 0, base + inst('optional-plugin', '1')
                return 0, base if minimal == 'normal' else inst(version='3.0')
            if argv[0].endswith('apt-cache'):
                records = []
                for item in argv[2:]:
                    name, version = item.split('=', 1)
                    records.append(metadata(name, version, size=100 if name == plan.PACKAGES[0] else 50))
                return 0, ''.join(records)
            self.fail('unexpected command')
        return run, calls

    def test_two_simulations_keep_exact_ten_roots_and_remove_only_optional_package(self):
        run, calls = self.fake_runner()
        report = plan.collect(run)
        self.assertTrue(report['simulationOnly'])
        self.assertEqual(report['archiveBytesReductionEstimate'], 50)
        self.assertEqual(report['removedPackages'], ['optional-plugin'])
        self.assertEqual(report['plans']['default']['plannedPackageCount'], 2)
        self.assertEqual(report['plans']['withoutRecommends']['plannedPackageCount'], 1)
        apt = [argv for argv in calls if argv[0].endswith('apt-get')]
        self.assertEqual(len(apt), 2)
        for argv in apt:
            self.assertIn('--simulate', argv)
            self.assertEqual(tuple(argv[argv.index('install') + 1:]), plan.PACKAGES)
        self.assertIn('not network bytes', report['sizeMeaning'])

    def test_command_failure_or_changed_required_versions_cannot_claim_savings(self):
        for command in ['apt-get', 'apt-cache']:
            with self.subTest(command=command), self.assertRaises(ValueError):
                plan.collect(self.fake_runner(fail=command)[0])
        with self.assertRaises(ValueError):
            plan.collect(self.fake_runner(minimal='changed')[0])

    def test_shared_archive_metadata_cannot_drift_between_simulations(self):
        run, _ = self.fake_runner()
        def changed(argv):
            code, text = run(argv)
            if argv[0].endswith('apt-cache') and len(argv[2:]) == 1:
                text = text.replace('Size: 100\n', 'Size: 101\n')
            return code, text
        with self.assertRaisesRegex(ValueError, 'metadata changed'):
            plan.collect(changed)

    def archive_record(self, name='libwebkit2gtk-4.1-0', body=b'synthetic deb bytes'):
        return {'name': name, 'version': '2.0', 'architecture': 'amd64', 'size': len(body),
                'filename': f'{plan.DOWNLOAD_POOLS[name]}{name}_2.0_amd64.deb',
                'sha256': hashlib.sha256(body).hexdigest()}

    def archive_text(self, record):
        return metadata(record['name'], record['version'], record['architecture'], record['size']).strip() + f"\nFilename: {record['filename']}\nSHA256: {record['sha256']}\n\n"

    def test_exact_official_archive_record_and_binary_process_output(self):
        record = self.archive_record()
        parsed = plan.download_metadata(self.archive_text(record))
        self.assertEqual(list(parsed.values()), [record])
        code, body = plan.bounded_command([sys.executable, '-c', 'import sys;sys.stdout.buffer.write(bytes([0,255]))'], binary=True)
        self.assertEqual(code, 0)
        self.assertEqual(body, bytes([0, 255]))

    def test_official_gets_are_closed_bounded_and_hash_verified(self):
        record = self.archive_record()
        calls = []
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            return 0, b'synthetic deb bytes'
        result = plan.download_one(plan.MIRRORS[0], record, run)
        self.assertEqual(result['status'], 'verified')
        self.assertEqual(result['verifiedSha256'], record['sha256'])
        argv, limits = calls[0]
        self.assertEqual(argv[:2], ['/usr/bin/curl', '--disable'])
        self.assertIn('--max-redirs', argv)
        self.assertEqual(argv[argv.index('--max-redirs') + 1], '0')
        self.assertEqual(argv[-1], plan.MIRRORS[0] + record['filename'])
        self.assertEqual(limits, {'timeout': 35, 'max_bytes': record['size'], 'binary': True})
        for bad in ['http://localhost/', 'https://other.invalid/']:
            with self.assertRaises(ValueError):
                plan.download_one(bad, record, run)
        self.assertEqual(len(calls), 1)

    def test_download_metadata_rejects_paths_identity_hash_and_oversize(self):
        base = self.archive_record()
        for change in [{'filename': 'pool/main/../bad.deb'}, {'filename': 'https://other.invalid/bad.deb'},
                       {'filename': 'pool/main/w/wrong_2.0_amd64.deb'}, {'sha256': 'bad'},
                       {'size': plan.MAX_DOWNLOAD + 1}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                plan.download_metadata(self.archive_text({**base, **change}))
        with self.assertRaises(ValueError):
            plan.download_metadata(self.archive_text(base) + self.archive_text({**base, 'sha256': 'a' * 64}))

    def test_official_webkit_universe_and_javascriptcore_main_pool_bindings(self):
        for name, pool in [('libjavascriptcoregtk-4.1-0', 'pool/main/w/webkit2gtk/'),
                           ('libwebkit2gtk-4.1-0', 'pool/universe/w/webkit2gtk/')]:
            record = self.archive_record(name)
            record['filename'] = f'{pool}{name}_2.50.4-0ubuntu0.22.04.1_amd64.deb'
            self.assertEqual(list(plan.download_metadata(self.archive_text(record)).values()), [record])
            for wrong in ['pool/main/x/other/', 'pool/universe/x/other/',
                          'pool/universe/w/webkit2gtk/' if '/main/' in pool else 'pool/main/w/webkit2gtk/']:
                with self.subTest(name=name, pool=wrong), self.assertRaises(ValueError):
                    plan.download_metadata(self.archive_text({**record, 'filename': wrong + record['filename'].rsplit('/', 1)[1]}))

    def test_failed_partial_or_changed_bytes_never_become_verified(self):
        record = self.archive_record()
        for code, body, status in [(0, b'x' * record['size'], 'integrity-mismatch'),
                                   (0, b'x', 'integrity-mismatch'), (28, b'', 'unavailable')]:
            result = plan.download_one(plan.MIRRORS[0], record, lambda *args, **kwargs: (code, body))
            self.assertEqual(result['status'], status)
            self.assertNotIn('verifiedBytes', result)
        def refused(*args, **kwargs):
            raise ValueError('synthetic deadline')
        self.assertEqual(plan.download_one(plan.MIRRORS[0], record, refused)['status'], 'bounded-download-refused')

    def test_comparison_fetches_only_two_exact_packages_from_two_official_hosts(self):
        records = [self.archive_record(name) for name in plan.DOWNLOAD_PACKAGES]
        report = {'plans': {'withoutRecommends': {'plannedPackages': [
            {'name': r['name'], 'version': r['version'], 'architecture': r['architecture'], 'archiveBytes': r['size']} for r in records]}}}
        calls = []
        def run(argv, **kwargs):
            calls.append(argv)
            if argv[0].endswith('apt-cache'):
                return 0, ''.join(self.archive_text(r) for r in records)
            return 0, b'synthetic deb bytes'
        result = plan.compare_mirrors(report, run)
        self.assertEqual(len(result['downloads']), 4)
        self.assertTrue(all(row['status'] == 'verified' for row in result['downloads']))
        self.assertFalse(result['payloadsExecutedOrInstalled'])
        self.assertEqual(len([call for call in calls if call[0].endswith('curl')]), 4)
        wrong = {'plans': {'withoutRecommends': {'plannedPackages': report['plans']['withoutRecommends']['plannedPackages'][:1]}}}
        with self.assertRaises(ValueError):
            plan.compare_mirrors(wrong, run)

    def test_subprocess_output_and_deadline_are_bounded(self):
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, 'output exceeded'):
            plan.bounded_command([sys.executable, '-c', 'import sys,time;sys.stdout.write("x"*4096);sys.stdout.flush();time.sleep(5)'], timeout=2, max_bytes=128)
        with self.assertRaisesRegex(ValueError, 'deadline'):
            plan.bounded_command([sys.executable, '-c', 'import time;time.sleep(5)'], timeout=0.05)
        self.assertLess(time.monotonic() - started, 3)


if __name__ == '__main__':
    unittest.main()
