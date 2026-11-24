#!/usr/bin/env python3
"""Rebuild scripts/ci/apt-green-runs.json from the newest successful installs.

The window size is the number of runs already in the file, so this does not
invent a new sample size. It never pushes. A caller that must publish the
change opens a pull request.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(__file__).with_name('apt-green-runs.json')
STEP = 'Install Linux system dependencies'
HTTP_TIMEOUT_SECONDS = 30


def load(path=DATA):
    return json.loads(Path(path).read_text())


def same_window(old, new):
    def key(doc):
        return [(row['id'], row['seconds']) for row in doc['runs']]
    return key(old) == key(new)


def duration_seconds(started, completed):
    start = datetime.fromisoformat(started.replace('Z', '+00:00'))
    end = datetime.fromisoformat(completed.replace('Z', '+00:00'))
    return round((end - start).total_seconds(), 3)


def select_installs(runs_with_steps, window):
    """runs_with_steps: newest first. Each item is (run_id, event, steps)."""
    chosen = []
    for run_id, event, steps in runs_with_steps:
        if event not in ('push', 'schedule'):
            continue
        step = next((item for item in steps if item.get('name') == STEP), None)
        if not step or step.get('conclusion') != 'success':
            continue
        if not step.get('started_at') or not step.get('completed_at'):
            continue
        chosen.append({'id': int(run_id), 'seconds': duration_seconds(step['started_at'], step['completed_at'])})
        if len(chosen) == window:
            break
    return chosen


def document(runs):
    ordered = sorted(runs, key=lambda row: row['id'])
    return {
        'description': (
            'Trailing green Install Linux system dependencies steps. '
            'seconds is started_at to completed_at on the Linux full suite job. '
            f'Window of {len(ordered)} successful push and schedule runs, '
            f'ids {ordered[0]["id"]} through {ordered[-1]["id"]}.'
        ),
        'runs': ordered,
    }


def _get(url, token):
    headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ashlr-md-apt-budget',
    }
    if token:
        headers['Authorization'] = f'Bearer {token}'
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
        return json.load(response)


def fetch_window(repo, token, window):
    chosen = []
    page = 1
    while len(chosen) < window and page <= 5:
        url = (
            f'https://api.github.com/repos/{repo}/actions/workflows/ci.yml/runs'
            f'?status=success&per_page=50&page={page}'
        )
        payload = _get(url, token)
        batch = payload.get('workflow_runs') or []
        if not batch:
            break
        for run in batch:
            if len(chosen) >= window:
                break
            event = run.get('event')
            if event not in ('push', 'schedule'):
                continue
            jobs = _get(run['jobs_url'], token)
            steps = []
            for job in jobs.get('jobs') or []:
                if job.get('name') == 'Linux full suite':
                    steps = job.get('steps') or []
                    break
            picked = select_installs([(run['id'], event, steps)], 1)
            chosen.extend(picked)
        page += 1
    if len(chosen) < window:
        raise RuntimeError(f'found {len(chosen)} green installs, need {window}')
    return document(chosen[:window])


def write_output(changed):
    path = os.environ.get('GITHUB_OUTPUT')
    if not path:
        return
    with open(path, 'a', encoding='utf-8') as handle:
        handle.write(f'changed={"true" if changed else "false"}\n')


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    write = '--write' in argv
    current = load()
    window = len(current['runs'])
    repo = os.environ.get('GITHUB_REPOSITORY', 'ashlrai/ashlr-md')
    token = os.environ.get('GITHUB_TOKEN') or None
    try:
        fresh = fetch_window(repo, token, window)
    except Exception as error:
        if token:
            try:
                fresh = fetch_window(repo, None, window)
            except Exception as retry:
                print(f'apt budget refresh skipped: {retry}', file=sys.stderr)
                write_output(False)
                return 0
        else:
            print(f'apt budget refresh skipped: {error}', file=sys.stderr)
            write_output(False)
            return 0
    if same_window(current, fresh):
        print(f'apt budget window unchanged ({window} runs)')
        write_output(False)
        return 0
    print(f'apt budget window moved ({window} runs)')
    if write:
        DATA.write_text(json.dumps(fresh, indent=2) + '\n')
    write_output(True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
