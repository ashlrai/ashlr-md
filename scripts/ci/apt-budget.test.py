#!/usr/bin/env python3
"""The apt budget is the trailing green p95 plus the longest green step."""
import importlib.util
import json
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('apt_budget', Path(__file__).with_name('apt-budget.py'))
apt_budget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(apt_budget)


class BudgetTests(unittest.TestCase):
    def test_wall_is_p95_plus_longest_measured_step(self):
        data = json.loads(Path(__file__).with_name('apt-green-runs.json').read_text())
        durations = [row['seconds'] for row in data['runs']]
        p95, idle, wall = apt_budget.limits(data['runs'])
        self.assertEqual(idle, max(durations))
        self.assertEqual(wall, p95 + idle)
        self.assertGreater(idle, p95)
        self.assertEqual(len(data['runs']), 40)
        self.assertIn(44936510749, {row['id'] for row in data['runs']})

    def test_silence_past_the_cap_stops_the_child(self):
        code = apt_budget.watch(['python3', '-c', 'import time; time.sleep(30)'], idle=0.3, wall=5)
        self.assertEqual(code, 1)


if __name__ == '__main__':
    unittest.main()
