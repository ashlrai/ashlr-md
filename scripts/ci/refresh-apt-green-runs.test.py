#!/usr/bin/env python3
import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    'refresh_apt', Path(__file__).with_name('refresh-apt-green-runs.py'))
refresh = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(refresh)


class RefreshTests(unittest.TestCase):
    def test_selects_only_successful_push_and_schedule_installs(self):
        rows = [
            (9, 'pull_request', [{'name': refresh.STEP, 'conclusion': 'success',
                                  'started_at': '2026-11-24T00:00:00Z', 'completed_at': '2026-11-24T00:00:30Z'}]),
            (8, 'push', [{'name': refresh.STEP, 'conclusion': 'skipped',
                          'started_at': '2026-11-24T00:00:00Z', 'completed_at': '2026-11-24T00:00:01Z'}]),
            (7, 'schedule', [{'name': refresh.STEP, 'conclusion': 'success',
                              'started_at': '2026-11-24T00:00:00Z', 'completed_at': '2026-11-24T00:00:40Z'}]),
            (6, 'push', [{'name': refresh.STEP, 'conclusion': 'success',
                          'started_at': '2026-11-24T00:01:00Z', 'completed_at': '2026-11-24T00:01:25Z'}]),
        ]
        chosen = refresh.select_installs(rows, 1)
        self.assertEqual(chosen, [{'id': 7, 'seconds': 40.0}])

    def test_same_window_ignores_description_text(self):
        old = {'description': 'a', 'runs': [{'id': 1, 'seconds': 25.0}]}
        new = {'description': 'b', 'runs': [{'id': 1, 'seconds': 25.0}]}
        self.assertTrue(refresh.same_window(old, new))
        new['runs'][0]['seconds'] = 30.0
        self.assertFalse(refresh.same_window(old, new))


if __name__ == '__main__':
    unittest.main()
