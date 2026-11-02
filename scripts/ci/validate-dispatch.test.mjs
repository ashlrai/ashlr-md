import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateJobs,
  validateTests,
  buildVitestArgs,
  validate,
  VALID_JOBS,
} from './validate-dispatch.mjs';

const SCRIPT = fileURLToPath(new URL('./validate-dispatch.mjs', import.meta.url));

// ── validateJobs ──────────────────────────────────────────────────────────

test('validateJobs: undefined or empty returns ok with empty array', () => {
  assert.deepEqual(validateJobs(undefined), { ok: true, jobs: [] });
  assert.deepEqual(validateJobs(''), { ok: true, jobs: [] });
});

test('validateJobs: single valid job', () => {
  assert.deepEqual(validateJobs('linux-full'), { ok: true, jobs: ['linux-full'] });
});

test('validateJobs: multiple valid jobs', () => {
  assert.deepEqual(
    validateJobs('linux-full,macos-full'),
    { ok: true, jobs: ['linux-full', 'macos-full'] },
  );
});

test('validateJobs: all valid jobs', () => {
  const all = [...VALID_JOBS].sort().join(',');
  const result = validateJobs(all);
  assert.equal(result.ok, true);
  assert.deepEqual(result.jobs.sort(), [...VALID_JOBS].sort());
});

test('validateJobs: rejects unknown job', () => {
  const r = validateJobs('unknown-job');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown job "unknown-job"/);
});

test('validateJobs: rejects shell injection patterns', () => {
  for (const input of ['linux-full; rm -rf /', 'linux-full`whoami`', '$(id)', 'linux-full & echo pwned']) {
    const r = validateJobs(input);
    assert.equal(r.ok, false, `should reject: ${input}`);
  }
});

test('validateJobs: rejects uppercase and special chars', () => {
  for (const input of ['Linux-Full', 'LINUX-FULL', 'linux_full', 'linux/full']) {
    const r = validateJobs(input);
    assert.equal(r.ok, false, `should reject: ${input}`);
  }
});

test('validateJobs: deduplicates', () => {
  const r = validateJobs('linux-full,macos-full,linux-full');
  assert.deepEqual(r.jobs, ['linux-full', 'macos-full']);
});

// ── validateTests ─────────────────────────────────────────────────────────

test('validateTests: undefined or empty returns ok with empty filter', () => {
  assert.deepEqual(validateTests(undefined), { ok: true, filter: '' });
  assert.deepEqual(validateTests(''), { ok: true, filter: '' });
});

test('validateTests: simple test name pattern', () => {
  assert.deepEqual(validateTests('login'), { ok: true, filter: 'login' });
});

test('validateTests: pattern with spaces and parens', () => {
  assert.deepEqual(validateTests('user login flow'), { ok: true, filter: 'user login flow' });
  assert.deepEqual(validateTests('should render (active)'), { ok: true, filter: 'should render (active)' });
  assert.deepEqual(validateTests('should^start'), { ok: true, filter: 'should^start' });
});

test('validateTests: pattern with character classes and quantifiers', () => {
  assert.deepEqual(validateTests('[admin]'), { ok: true, filter: '[admin]' });
  assert.deepEqual(validateTests('test{1,3}'), { ok: true, filter: 'test{1,3}' });
  assert.deepEqual(validateTests('foo*bar'), { ok: true, filter: 'foo*bar' });
  assert.deepEqual(validateTests('foo?bar'), { ok: true, filter: 'foo?bar' });
});

test('validateTests: path-like patterns', () => {
  assert.deepEqual(validateTests('src/components/App'), { ok: true, filter: 'src/components/App' });
  assert.deepEqual(validateTests('App.test - renders'), { ok: true, filter: 'App.test - renders' });
});

test('validateTests: rejects shell injection', () => {
  for (const input of ['login; rm -rf /', 'test`whoami`', '$(id)', 'test & echo pwned']) {
    const r = validateTests(input);
    assert.equal(r.ok, false, `should reject: ${input}`);
  }
});

test('validateTests: rejects dangerous chars', () => {
  for (const input of ['test"double"', "test'single'", 'test<redirect', 'test>redirect']) {
    const r = validateTests(input);
    assert.equal(r.ok, false, `should reject: ${input}`);
  }
});

test('validateTests: reports which chars are bad', () => {
  const r = validateTests('login; rm');
  assert.match(r.error, /disallowed characters.*;/);
});

// ── buildVitestArgs ───────────────────────────────────────────────────────

test('buildVitestArgs: empty filter returns empty array', () => {
  assert.deepEqual(buildVitestArgs(''), []);
  assert.deepEqual(buildVitestArgs(undefined), []);
});

test('buildVitestArgs: non-empty filter returns --test-name-pattern args', () => {
  assert.deepEqual(buildVitestArgs('login'), ['--test-name-pattern', 'login']);
  assert.deepEqual(buildVitestArgs('user auth'), ['--test-name-pattern', 'user auth']);
});

// ── validate (combined) ───────────────────────────────────────────────────

test('validate: both empty — ok', () => {
  const r = validate({ onlyJobs: '', onlyTests: '' });
  assert.deepEqual(r, { ok: true, jobs: [], filter: '' });
});

test('validate: valid jobs and tests', () => {
  const r = validate({ onlyJobs: 'linux-full', onlyTests: 'login' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.jobs, ['linux-full']);
  assert.equal(r.filter, 'login');
});

test('validate: invalid jobs — fails', () => {
  const r = validate({ onlyJobs: 'hack-job', onlyTests: 'login' });
  assert.equal(r.ok, false);
});

test('validate: invalid tests — fails', () => {
  const r = validate({ onlyJobs: 'linux-full', onlyTests: 'hack; rm' });
  assert.equal(r.ok, false);
});

test('validate: with writeLine callback', () => {
  const lines = [];
  const r = validate({
    onlyJobs: 'macos-full',
    onlyTests: 'auth',
    writeLine: (l) => lines.push(l),
  });
  assert.equal(r.ok, true);
  assert.ok(lines.some((l) => l.startsWith('dispatch_jobs=')));
  assert.ok(lines.some((l) => l.startsWith('dispatch_tests=')));
  assert.ok(lines.some((l) => l.startsWith('dispatch_vitest_args=')));
});

// ── CLI (main) ────────────────────────────────────────────────────────────

function runCli(envVars) {
  const childEnv = { ...process.env, ...envVars };
  delete childEnv.GITHUB_OUTPUT;
  return execFileSync('node', [SCRIPT], {
    encoding: 'utf8',
    env: childEnv,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
}

test('CLI: no inputs — ok with empty defaults', () => {
  const out = runCli({});
  assert.match(out, /dispatch_jobs=\[\]/);
  assert.match(out, /dispatch_tests=/);
});

test('CLI: valid only_jobs', () => {
  const out = runCli({ DAILYFIX_JOBS: 'linux-full,macos-full' });
  assert.match(out, /dispatch_jobs=\["linux-full","macos-full"\]/);
});

test('CLI: valid only_tests', () => {
  const out = runCli({ DAILYFIX_TESTS: 'login' });
  assert.match(out, /dispatch_tests=login/);
  assert.match(out, /dispatch_vitest_args=--test-name-pattern login/);
});

test('CLI: invalid only_jobs — exits 1', () => {
  let caught = false;
  try {
    runCli({ DAILYFIX_JOBS: 'evil; rm' });
  } catch (err) {
    caught = true;
    assert.equal(err.status, 1, `should exit with code 1 (got ${err.status})`);
  }
  assert.ok(caught, 'should have thrown');
});

test('CLI: invalid only_tests — exits 1', () => {
  let caught = false;
  try {
    runCli({ DAILYFIX_TESTS: 'test`hack`' });
  } catch (err) {
    caught = true;
    assert.equal(err.status, 1, `should exit with code 1 (got ${err.status})`);
  }
  assert.ok(caught, 'should have thrown');
});

test('CLI: with GITHUB_OUTPUT file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-test-'));
  const ghoPath = join(dir, 'env');
  writeFileSync(ghoPath, '');
  const env = { DAILYFIX_JOBS: 'fast', DAILYFIX_TESTS: 'smoke', GITHUB_OUTPUT: ghoPath };
  // Use stdio pipe for all streams so we can capture output
  execFileSync('node', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const content = readFileSync(ghoPath, 'utf8');
  assert.match(content, /dispatch_jobs=\["fast"\]/);
  assert.match(content, /dispatch_tests=smoke/);
  rmSync(dir, { recursive: true });
});

// ── Security R7: allowlist enforcement ────────────────────────────────────

test('R7: only_jobs never passes shell-active characters', () => {
  const shellChars = [';', '`', '$', '(', ')', '&', '|', '>', '<', '!', '"', "'"];
  for (const ch of shellChars) {
    const r = validateJobs(`linux-full${ch}pwned`);
    assert.equal(r.ok, false, `must reject ${ch}`);
  }
});

test('R7: only_tests rejects $ (shell variable expansion)', () => {
  const r = validateTests('test$VAR');
  assert.equal(r.ok, false);
});

test('R7: only_tests rejects backtick (command substitution)', () => {
  const r = validateTests('test`cmd`');
  assert.equal(r.ok, false);
});

test('R7: VALID_JOBS set contains only safe job names', () => {
  for (const job of VALID_JOBS) {
    assert.match(job, /^[a-z][a-z0-9-]*$/, `${job} must match safe pattern`);
    assert.doesNotMatch(job, /[;`$&|><!"'\\]/, `${job} must not contain shell-active chars`);
  }
});
