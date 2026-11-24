import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function bash(script, env) {
  return spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('setup and install scripts parse', () => {
  for (const file of ['scripts/setup.sh', 'scripts/install.sh', 'scripts/rustc-version.sh']) {
    const result = spawnSync('bash', ['-n', file], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('PowerShell setup names the rustc floor and does not prompt', () => {
  const read = (name) => spawnSync('cat', [`scripts/${name}`], { cwd: root, encoding: 'utf8' }).stdout;
  const floor = read('rustc-version.ps1');
  assert.match(floor, /1\.90/);
  assert.match(floor, /101/);
  assert.match(floor, /rust-toolchain\.toml/);
  const source = read('setup.ps1');
  assert.equal(/Read-Host/.test(source), false);
  assert.equal(/Invoke-Expression|\| iex\b/.test(source), false);
  assert.match(source, /rustc-version\.ps1/);
  assert.match(source, /--ignore-scripts/);
  assert.match(source, /Join-Path/);
});

test('setup.sh is non-interactive and names macOS and Linux', () => {
  const source = spawnSync('cat', ['scripts/setup.sh'], { cwd: root, encoding: 'utf8' }).stdout;
  assert.equal(/^\s*read\b/m.test(source), false);
  assert.match(source, /Darwin/);
  assert.match(source, /Linux/);
  assert.match(source, /bun install --frozen-lockfile --ignore-scripts/);
  assert.match(source, /discord\.gg\/jBQrSU6XeD/);
});

test('rustc 1.85.1 without rustup is refused before cargo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-rustc-'));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'rustc'), '#!/bin/sh\necho "rustc 1.85.1 (fake)"\n');
  chmodSync(join(bin, 'rustc'), 0o755);
  const result = bash(
    `
    set -euo pipefail
    source scripts/rustc-version.sh
    die() { printf '%s\\n' "$*" >&2; exit 1; }
    info() { printf '%s\\n' "$*"; }
    require_rustc "$PWD"
    `,
    { PATH: `${bin}:/usr/bin:/bin`, HOME: dir },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /1\.85\.1/);
  assert.match(result.stderr, /1\.90/);
  assert.match(result.stderr, /1\.99\.1/);
  assert.match(result.stderr, /101/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /cargo build/);
});

test('rustup installs the pin and an old default is then accepted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-rustup-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'rustup.log');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(
    join(bin, 'rustc'),
    '#!/bin/sh\nif [ "$RUSTUP_TOOLCHAIN" = "1.99.1" ]; then echo "rustc 1.99.1 (fake)"; else echo "rustc 1.85.1 (fake)"; fi\n',
  );
  writeFileSync(
    join(bin, 'rustup'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
  );
  chmodSync(join(bin, 'rustc'), 0o755);
  chmodSync(join(bin, 'rustup'), 0o755);
  const result = bash(
    `
    set -euo pipefail
    source scripts/rustc-version.sh
    die() { printf '%s\\n' "$*" >&2; exit 1; }
    info() { printf '%s\\n' "$*"; }
    require_rustc "$PWD"
    `,
    { PATH: `${bin}:/usr/bin:/bin`, HOME: dir },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rustc 1\.99\.1 meets the requirement \(1\.99\.1\)/);
  const calls = spawnSync('cat', [log], { encoding: 'utf8' }).stdout;
  assert.match(calls, /toolchain install 1\.99\.1/);
});

test('a compiler at the crate floor is accepted when rustup is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-floor-'));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'rustc'), '#!/bin/sh\necho "rustc 1.90.0 (fake)"\n');
  chmodSync(join(bin, 'rustc'), 0o755);
  const result = bash(
    `
    set -euo pipefail
    source scripts/rustc-version.sh
    die() { printf '%s\\n' "$*" >&2; exit 1; }
    info() { printf '%s\\n' "$*"; }
    require_rustc "$PWD"
    `,
    { PATH: `${bin}:/usr/bin:/bin`, HOME: dir },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /meets the requirement \(1\.90\)/);
});
