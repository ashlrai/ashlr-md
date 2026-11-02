import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'md-fast-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Archive only tracked files, so the fixture is independent of local edits.
  const archive = join(dir, 'fixture.tar');
  execFileSync('git', ['archive', '--output', archive, 'origin/main', 'src', 'package.json', 'tsconfig.json', 'tsconfig.node.json', 'biome.json'], { cwd: root });
  execFileSync('tar', ['-xf', archive, '-C', dir]);
  rmSync(archive);
  mkdirSync(join(dir, 'scripts'));
  cpSync(join(root, 'scripts/fast-check.sh'), join(dir, 'scripts/fast-check.sh'));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: dir });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
  const home = join(dir, 'home');
  mkdirSync(home);
  return { dir, home };
}

function run({ dir, home }) {
  return spawnSync('bash', ['scripts/fast-check.sh'], {
    cwd: dir, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 120_000,
  });
}

test('clean tree passes all steps', (t) => {
  const result = run(fixture(t));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS typecheck\nPASS lint\nPASS node tests\nTotal: \d+ seconds/);
});

test('a type error fails the check and changed Node tests run', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'src/fast-check-seeded.ts'), 'const value: string = 42;\nexport default value;\n');
  writeFileSync(join(f.dir, 'scripts/changed.test.mjs'), "import { test } from 'node:test';\ntest('changed test', () => { throw new Error('seeded failure'); });\n");
  const result = run(f);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL typecheck/);
  assert.match(result.stdout, /FAIL node tests/);
  assert.match(result.stdout, /seeded failure/);
  assert.match(result.stdout, /Total: \d+ seconds/);
});
