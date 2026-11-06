#!/usr/bin/env python3
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

    def test_subprocess_output_and_deadline_are_bounded(self):
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, 'output exceeded'):
            plan.bounded_command([sys.executable, '-c', 'import sys,time;sys.stdout.write("x"*4096);sys.stdout.flush();time.sleep(5)'], timeout=2, max_bytes=128)
        with self.assertRaisesRegex(ValueError, 'deadline'):
            plan.bounded_command([sys.executable, '-c', 'import time;time.sleep(5)'], timeout=0.05)
        self.assertLess(time.monotonic() - started, 3)


if __name__ == '__main__':
    unittest.main()
