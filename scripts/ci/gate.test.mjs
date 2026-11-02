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
  return Object.fromEntries(keys.map(key => [key, {result: event === 'pull_request' && fullJobs.includes(key) ? 'skipped' : 'success'}]));
}
function execute(event, values) {
  const result = spawnSync('bash', ['-c', script], {
    env: {...process.env, EVENT: event, NEEDS: JSON.stringify(values)},
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  return result;
}
function expectGate(event, values, passes) {
  const result = execute(event, values);
  assert.equal(result.status === 0, passes, `${event}: ${JSON.stringify(values)}\n${result.stdout}\n${result.stderr}`);
}

test('full job predicates select queue/daily/manual, never ordinary PR', () => {
  assert.equal(gate.match(/^    if: (.+)$/m)?.[1], 'always()');
  const dependencies = gate.match(/^    needs: \[(.+)\]$/m)?.[1];
  assert.ok(dependencies, 'gate needs must remain an explicit dependency list');
  assert.deepEqual(dependencies.split(',').map(key => key.trim()).sort(), [...keys].sort());
  for (const name of fullJobs) {
    const condition = job(name).match(/^    if: (.+)$/m)?.[1];
    assert.ok(condition);
    // This intentionally supports only the workflow's plain OR-of-events
    // expression, failing on new syntax rather than silently mis-evaluating it.
    const events = condition.split(' || ').map(term => {
      const match = term.match(/^github\.event_name == '([a-z_]+)'$/);
      assert.ok(match, `unsupported predicate: ${term}`);
      return match[1];
    });
    assert.deepEqual(events.sort(), ['merge_group', 'schedule', 'workflow_dispatch']);
  }
  assert.match(job('fast'), /run: node --test scripts\/ci\/gate\.test\.mjs/);
});

for (const event of ['merge_group', 'schedule', 'workflow_dispatch', 'pull_request']) {
  test(`${event}: actual gate accepts intended successes/skips and rejects every required failure`, () => {
    expectGate(event, needs(event), true);
    for (const key of keys) {
      for (const state of ['failure', 'cancelled', 'skipped', '']) {
        const values = needs(event);
        values[key].result = state;
        expectGate(event, values, event === 'pull_request' && fullJobs.includes(key) && state === 'skipped');
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

test('queue keeps coverage generation but does not upload unused reports', () => {
  const linux = job('linux-full');
  assert.match(linux, /vitest run --coverage --coverage.reporter=lcov/);
  assert.match(linux, /if \[ ! -s "\$f" \]; then/);
  const upload = linux.match(/- name: Keep coverage reports for the Codecov job\n        if: (.+)/)?.[1];
  assert.equal(upload, "${{ !cancelled() && github.event_name != 'merge_group' && (steps.unit.outcome == 'success' || steps.unit.outcome == 'failure') }}");
});
