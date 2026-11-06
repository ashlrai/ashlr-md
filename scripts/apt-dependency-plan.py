#!/usr/bin/env python3
"""Measure the fixed Linux CI dependency plans; never install packages.

Archive-byte totals come from local APT Size metadata. They are estimates, not
network-transfer, cache-hit, or CI-duration measurements.
"""
import json
import os
import platform
import re
import selectors
import subprocess
import sys
import time
from pathlib import Path

PACKAGES = (
    'libwebkit2gtk-4.1-dev', 'build-essential', 'curl', 'wget', 'file',
    'libxdo-dev', 'libssl-dev', 'libayatana-appindicator3-dev', 'librsvg2-dev', 'patchelf',
)
MAX_OUTPUT = 8 * 1024 * 1024
MAX_PACKAGES = 512
NAME = r'[a-z0-9][a-z0-9+.-]*'
VERSION = r'[0-9A-Za-z.+:~\-]+'
ARCH = r'[a-z0-9][a-z0-9-]*'
INSTALL = re.compile(rf'^Inst ({NAME})(?::({ARCH}))?(?: \[[^\]]+\])? \(({VERSION}) .+ \[({ARCH})\]\)$')


def bounded_command(argv, timeout=120, max_bytes=MAX_OUTPUT):
    """Fixed callers only; consume bounded output without inheriting CI credentials."""
    child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             env={'LC_ALL': 'C', 'LANG': 'C', 'PATH': '/usr/bin:/bin'})
    deadline = time.monotonic() + timeout
    chunks = bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise ValueError('dependency command deadline exceeded')
                chunk = os.read(child.stdout.fileno(), 65536)
                if not chunk:
                    break
                chunks.extend(chunk)
                if len(chunks) > max_bytes:
                    raise ValueError('dependency command output exceeded its bound')
        code = child.wait(timeout=max(0.01, deadline - time.monotonic()))
        return code, chunks.decode('utf-8', errors='strict')
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        child.stdout.close()


def parse_plan(text):
    if len(text.encode('utf-8')) > MAX_OUTPUT:
        raise ValueError('simulation output too large')
    rows = {}
    for line in text.splitlines():
        if line.startswith('Remv '):
            raise ValueError('simulation would remove installed packages')
        if not line.startswith('Inst '):
            continue
        match = INSTALL.fullmatch(line)
        if not match:
            raise ValueError('unrecognized simulation package record')
        name, qualified_arch, version, arch = match.groups()
        if qualified_arch and qualified_arch != arch:
            raise ValueError('simulation architecture mismatch')
        key = (name, version, arch)
        if key in rows or any(previous[0] == name for previous in rows):
            raise ValueError('duplicate or ambiguous simulation package')
        rows[key] = None
        if len(rows) > MAX_PACKAGES:
            raise ValueError('simulation package count exceeded its bound')
    return rows


def parse_metadata(text):
    if len(text.encode('utf-8')) > MAX_OUTPUT:
        raise ValueError('APT metadata too large')
    rows = {}
    for block in re.split(r'\n\s*\n', text.strip()):
        if not block:
            continue
        fields = {}
        for line in block.splitlines():
            if line.startswith((' ', '\t')):
                continue
            key, separator, value = line.partition(':')
            if not separator or key in fields:
                raise ValueError('malformed or duplicate APT metadata field')
            fields[key] = value.strip()
        name, version, arch = (fields.get(key, '') for key in ('Package', 'Version', 'Architecture'))
        if not re.fullmatch(NAME, name) or not re.fullmatch(VERSION, version) or not re.fullmatch(ARCH, arch):
            raise ValueError('invalid APT package identity')
        raw_size = fields.get('Size', '')
        if not re.fullmatch(r'[0-9]{1,12}', raw_size) or not 0 < int(raw_size) <= 4 * 1024**3:
            raise ValueError('missing or invalid archive Size metadata')
        identity, size = (name, version, arch), int(raw_size)
        if identity in rows and rows[identity] != size:
            raise ValueError('ambiguous archive Size metadata')
        rows[identity] = size
    return rows


def summarize(plan, metadata, installed):
    keys = parse_plan(plan)
    sizes = parse_metadata(metadata)
    if set(keys) != set(sizes):
        raise ValueError('archive metadata does not exactly match the simulation')
    required = {}
    for name in PACKAGES:
        selected = [(version, arch) for package, version, arch in keys if package == name]
        value = selected[0] if selected else installed.get(name)
        if value is None:
            raise ValueError('required package missing from installed state and simulation')
        required[name] = list(value)
    total = sum(sizes.values())
    if total > 16 * 1024**3:
        raise ValueError('archive estimate exceeded its bound')
    return {'plannedPackageCount': len(keys), 'archiveBytesEstimate': total,
            'requiredPackageVersions': required,
            'plannedPackages': [{'name': name, 'version': version, 'architecture': arch,
                                 'archiveBytes': sizes[(name, version, arch)]}
                                for name, version, arch in sorted(keys)]}


def installed_roots(run):
    result = {}
    for name in PACKAGES:
        code, text = run(['/usr/bin/dpkg-query', '-W',
                          '--showformat=${db:Status-Status}\t${Version}\t${Architecture}\n', name])
        if code == 1 and f'no packages found matching {name}' in text:
            result[name] = None
            continue
        if code != 0:
            raise ValueError('installed package query unavailable')
        fields = text.strip().split('\t')
        if len(fields) != 3 or fields[0] != 'installed':
            raise ValueError('requested package has an incomplete installed state')
        if not re.fullmatch(VERSION, fields[1]) or not re.fullmatch(ARCH, fields[2]):
            raise ValueError('installed package identity unavailable')
        result[name] = (fields[1], fields[2])
    return result


def collect(run=bounded_command):
    installed = installed_roots(run)
    reports = {}
    plans = {}
    for label, extra in [('default', []), ('withoutRecommends', ['--no-install-recommends'])]:
        code, plan = run(['/usr/bin/apt-get', '--simulate', *extra, 'install', *PACKAGES])
        if code != 0:
            raise ValueError('APT simulation failed')
        selected = parse_plan(plan)
        plans[label] = selected
        if selected:
            specs = [f'{name}={version}' for name, version, _ in selected]
            code, metadata = run(['/usr/bin/apt-cache', 'show', *specs])
            if code != 0:
                raise ValueError('APT package metadata query failed')
        else:
            metadata = ''
        reports[label] = summarize(plan, metadata, installed)
    if installed != installed_roots(run):
        raise ValueError('installed package state changed during simulation')
    if not set(plans['withoutRecommends']).issubset(plans['default']):
        raise ValueError('minimal plan replaces rather than only removes dependencies')
    if reports['default']['requiredPackageVersions'] != reports['withoutRecommends']['requiredPackageVersions']:
        raise ValueError('required package versions change between plans')
    baseline_sizes = {(item['name'], item['version'], item['architecture']): item['archiveBytes']
                      for item in reports['default']['plannedPackages']}
    for item in reports['withoutRecommends']['plannedPackages']:
        key = (item['name'], item['version'], item['architecture'])
        if baseline_sizes[key] != item['archiveBytes']:
            raise ValueError('archive metadata changed between simulations')
    return {'schema': 'ashlr-md.apt-dependency-plan.v1', 'simulationOnly': True,
            'requestedPackages': list(PACKAGES), 'installedRootVersionsUnchanged': True,
            'sizeMeaning': 'APT Size metadata sum; not network bytes, cache hits, or elapsed-time prediction',
            'plans': reports,
            'removedPackages': sorted({key[0] for key in plans['default']} - {key[0] for key in plans['withoutRecommends']}),
            'archiveBytesReductionEstimate': reports['default']['archiveBytesEstimate'] - reports['withoutRecommends']['archiveBytesEstimate']}


def main():
    if len(sys.argv) != 1 or sys.platform != 'linux' or os.geteuid() != 0 or platform.machine() != 'x86_64':
        raise ValueError('probe requires its fixed root-owned Linux runner invocation')
    os_release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    if os_release.get('ID', '').strip('"') != 'ubuntu' or os_release.get('VERSION_ID', '').strip('"') != '22.04':
        raise ValueError('probe requires Ubuntu 22.04')
    report = collect()
    report['runner'] = {'os': 'ubuntu-22.04', 'machine': platform.machine(),
                        'imageVersion': os.environ.get('ImageVersion'), 'sourceSha': os.environ.get('GITHUB_SHA')}
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        sys.exit(f'APT plan unavailable; no qualification claimed: {error}')
