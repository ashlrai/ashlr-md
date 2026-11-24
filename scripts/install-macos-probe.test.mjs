import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(join(root, 'scripts/install.sh'), 'utf8');

function probeFunction() {
  const start = source.indexOf('probe_macos() {');
  assert.ok(start >= 0, 'probe_macos is missing');
  let depth = 0;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > start);
  return source.slice(start, end);
}

function runProbe(machine, cltOk) {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-probe-'));
  writeFileSync(join(dir, 'uname'), `#!/bin/sh\nprintf '%s\\n' '${machine}'\n`);
  writeFileSync(
    join(dir, 'xcode-select'),
    cltOk
      ? "#!/bin/sh\nif [ \"$1\" = -p ]; then printf '%s\\n' /Library/Developer/CommandLineTools; exit 0; fi\nexit 1\n"
      : '#!/bin/sh\nexit 1\n',
  );
  chmodSync(join(dir, 'uname'), 0o755);
  chmodSync(join(dir, 'xcode-select'), 0o755);
  const script = `
set -euo pipefail
info() { printf 'INFO %s\\n' "$*"; }
die() { printf 'DIE %s\\n' "$*" >&2; exit 7; }
${probeFunction()}
probe_macos
`;
  return execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', script], {
    env: { PATH: `${dir}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
}

test('Apple Silicon with Command Line Tools is accepted', () => {
  const out = runProbe('arm64', true);
  assert.match(out, /Apple Silicon \(arm64\)/);
  assert.match(out, /Xcode Command Line Tools: \/Library\/Developer\/CommandLineTools/);
});

test('Intel with Command Line Tools is accepted', () => {
  const out = runProbe('x86_64', true);
  assert.match(out, /Intel \(x86_64\)/);
});

test('a missing Command Line Tools install stops with xcode-select --install', () => {
  assert.throws(() => runProbe('arm64', false), (error) => {
    assert.equal(error.status, 7);
    assert.match(error.stderr, /xcode-select --install/);
    return true;
  });
});

test('an unknown Mac CPU stops before the build', () => {
  assert.throws(() => runProbe('ppc64', true), (error) => {
    assert.equal(error.status, 7);
    assert.match(error.stderr, /Unrecognized Mac CPU: ppc64/);
    return true;
  });
});

test('the probe runs only on Darwin', () => {
  const call = source.indexOf('\n  probe_macos\n');
  const darwin = source.indexOf('if [[ "$(uname)" == "Darwin" ]]; then');
  const next = source.indexOf('\nfi\n', darwin);
  assert.ok(call > darwin && call < next);
});
