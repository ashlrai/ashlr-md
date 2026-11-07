import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
// Deliberately fail if the workflow layout changes: exercise its real script,
// not a second implementation of the gate policy or a copied shell fixture.
function job(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `missing job ${name}`);
  return match[1];
}
const gate = job('gate');
const run = gate.match(/^        run: \|\n((?:          .*\n|\n)+)/m);
assert.ok(run, 'missing literal gate run block');
const script = run[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
const keys = ['fast', 'secret-scan', 'linux-full', 'macos-full', 'secret-shape'];
const fullJobs = ['linux-full', 'macos-full'];
function needs(event) {
  return Object.fromEntries(keys.map(key => [key, {result: ['pull_request', 'merge_group'].includes(event) && fullJobs.includes(key) ? 'skipped' : 'success'}]));
}
function execute(event, values, ref = 'refs/heads/main') {
  const result = spawnSync('bash', ['-c', script], {
    env: {...process.env, EVENT: event, REF: ref, NEEDS: JSON.stringify(values)},
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  return result;
}
function expectGate(event, values, passes) {
  const result = execute(event, values);
  assert.equal(result.status === 0, passes, `${event}: ${JSON.stringify(values)}\n${result.stdout}\n${result.stderr}`);
}

test('full job predicates select main push/daily/manual, never PR or queue', () => {
  assert.equal(gate.match(/^    if: (.+)$/m)?.[1], 'always()');
  const dependencies = gate.match(/^    needs: \[(.+)\]$/m)?.[1];
  assert.ok(dependencies, 'gate needs must remain an explicit dependency list');
  assert.deepEqual(dependencies.split(',').map(key => key.trim()).sort(), [...keys].sort());
  for (const name of fullJobs) {
    const condition = job(name).match(/^    if: (.+)$/m)?.[1];
    assert.ok(condition);
    // Parse only the supported OR-of-AND equality grammar, not arbitrary
    // GitHub expressions; reject future syntax rather than mis-evaluate it.
    const alternatives = condition.split(' || ').map(term =>
      term.replace(/^\((.*)\)$/, '$1').split(' && ').map(equality => {
        const match = equality.match(/^github\.(event_name|ref) == '([^']+)'$/);
        assert.ok(match, `unsupported predicate: ${equality}`);
        return [match[1], match[2]];
      }));
    const selected = (event_name, ref) => alternatives.some(terms =>
      terms.every(([key, value]) => ({event_name, ref})[key] === value));
    for (const event of ['push', 'pull_request', 'merge_group', 'schedule', 'workflow_dispatch']) {
      for (const ref of ['refs/heads/main', 'refs/heads/topic', 'refs/tags/v0.5.0', '']) {
        assert.equal(selected(event, ref),
          ['schedule', 'workflow_dispatch'].includes(event) || (event === 'push' && ref === 'refs/heads/main'),
          `${name}: ${event} ${ref}`);
      }
    }
  }
  assert.match(job('fast'), /run: node --test scripts\/ci\/gate\.test\.mjs/);
});

test('required fast job checks documentation links before merge', () => {
  assert.match(job('fast'), /- name: Check documentation links\n        run: bun run check:doc-links\n/);
  assert.doesNotMatch(job('fast').match(/- name: Check documentation links\n([\s\S]*?)(?=\n      - name:|\n  [a-z][a-z-]*:)/)?.[1] ?? '', /continue-on-error|\n        if:/);
});

for (const event of ['push', 'merge_group', 'schedule', 'workflow_dispatch', 'pull_request']) {
  test(`${event}: actual gate accepts intended successes/skips and rejects every required failure`, () => {
    expectGate(event, needs(event), true);
    for (const key of keys) {
      for (const state of ['failure', 'cancelled', 'skipped', '']) {
        const values = needs(event);
        values[key].result = state;
        expectGate(event, values, ['pull_request', 'merge_group'].includes(event) && fullJobs.includes(key) && state === 'skipped');
      }
      const missing = needs(event);
      delete missing[key];
      expectGate(event, missing, false);
      const missingResult = needs(event);
      missingResult[key] = {};
      expectGate(event, missingResult, false);
    }
    expectGate(event, {...needs(event), unexpected: {result: 'success'}}, false);
  });
}

test('Codecov remains schedule/manual only with no merge-queue OIDC expansion', () => {
  assert.equal(job('codecov').match(/^    if: (.+)$/m)?.[1], "${{ !cancelled() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') }}");
  for (const name of fullJobs) assert.doesNotMatch(job(name), /id-token:/);
});

test('post-merge full suite keeps coverage but only daily/manual uploads reports', () => {
  const linux = job('linux-full');
  assert.match(linux, /vitest run --coverage --coverage.reporter=lcov/);
  assert.match(linux, /if \[ ! -s "\$f" \]; then/);
  const upload = linux.match(/- name: Keep coverage reports for the Codecov job\n        if: (.+)/)?.[1];
  assert.equal(upload, "${{ !cancelled() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && (steps.unit.outcome == 'success' || steps.unit.outcome == 'failure') }}");
});

// The push predicate is safe only with a main-only trigger: no branches/tags
// outside main may start a second expensive full suite.
test('push trigger is restricted to main and PR/queue triggers remain', () => {
  const triggers = workflow.match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1];
  assert.ok(triggers);
  const push = triggers.match(/^  push:\n((?:    .*\n)+)/m)?.[1];
  assert.equal(push, '    branches: [main]\n');
  assert.match(triggers, /^  merge_group:\s*$/m);
  assert.match(triggers, /^  pull_request:\n    types: \[opened, synchronize, reopened\]/m);
});

test('actual gate rejects any unexpected non-main push even with successful jobs', () => {
  assert.match(gate, /REF: \$\{\{ github.ref \}\}/);
  for (const ref of ['refs/heads/topic', 'refs/tags/v0.5.0', '']) {
    const result = execute('push', needs('push'), ref);
    assert.notEqual(result.status, 0, ref);
    assert.match(result.stdout, /unexpected non-main push/);
  }
});
