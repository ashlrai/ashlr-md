#!/usr/bin/env python3
"""Install the Linux CI packages under a budget taken from measured green runs.

The wall budget is the p95 of those step durations plus the idle-output cap.
The idle cap is the longest trailing green step: a gap inside a run cannot
exceed the run, so this cap does not reject any run in the measured set.
A mirror that stops printing, as run 44779190348 did for 265s, is stopped
at the cap instead of the old 15 minute step timeout.
"""
import importlib.util
import json
import os
import select
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(__file__).with_name('apt-green-runs.json')
PLAN = ROOT / 'scripts' / 'apt-dependency-plan.py'


def percentile(values, q):
    ordered = sorted(values)
    if not ordered:
        raise ValueError('no measured durations')
    index = (len(ordered) - 1) * q
    low = int(index)
    high = min(low + 1, len(ordered) - 1)
    if low == high:
        return float(ordered[low])
    return ordered[low] * (high - index) + ordered[high] * (index - low)


def limits(runs):
    durations = [float(row['seconds']) for row in runs]
    p95 = percentile(durations, 0.95)
    # Upper bound on a silence inside any trailing green step.
    idle = max(durations)
    return p95, idle, p95 + idle


def packages():
    spec = importlib.util.spec_from_file_location('apt_plan', PLAN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return list(module.PACKAGES)


def watch(argv, idle, wall):
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    started = time.monotonic()
    last = started
    stream = proc.stdout
    os.set_blocking(stream.fileno(), False)
    try:
        while True:
            code = proc.poll()
            if code is not None:
                rest = stream.read() or b''
                if rest:
                    sys.stdout.buffer.write(rest)
                    sys.stdout.buffer.flush()
                return code
            now = time.monotonic()
            if now - last >= idle:
                proc.kill()
                proc.wait()
                print(f'::error::apt produced no output for {idle:.3f}s, the longest trailing green install', file=sys.stderr)
                return 1
            if now - started >= wall:
                proc.kill()
                proc.wait()
                print(f'::error::apt exceeded {wall:.3f}s (p95 {wall - idle:.3f}s plus that idle cap)', file=sys.stderr)
                return 1
            wait = min(idle - (now - last), wall - (now - started))
            ready, _, _ = select.select([stream], [], [], max(wait, 0))
            if not ready:
                continue
            chunk = stream.read()
            if not chunk:
                continue
            last = time.monotonic()
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
    finally:
        stream.close()


def main():
    runs = json.loads(DATA.read_text())['runs']
    p95, idle, wall = limits(runs)
    print(f'apt budget wall={wall:.3f}s p95={p95:.3f}s idle={idle:.3f}s n={len(runs)}', flush=True)
    names = packages()
    script = '\n'.join([
        'set -euo pipefail',
        'sudo python3 scripts/apt-https-sources.py',
        'sudo stdbuf -oL -eL apt-get update',
        'sudo stdbuf -oL -eL apt-get install -y ' + ' '.join(names),
    ])
    return watch(['bash', '-c', script], idle, wall)


if __name__ == '__main__':
    sys.exit(main())
