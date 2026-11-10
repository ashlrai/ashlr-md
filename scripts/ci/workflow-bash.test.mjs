import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { checkRuns, extractRuns } from './workflow-bash.mjs';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows');

const workflow = (body) => `name: T
on: push
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
${body}
`;

test('unclosed quote in a bash run block is caught', () => {
  const yml = workflow(`      - name: Broken
        shell: bash
        run: |
          f() {
            echo "$1
          }
          f hi
`);
  const { failures } = checkRuns(extractRuns(yml));
  assert.equal(failures.length, 1);
  assert.match(failures[0].stderr, /syntax error|unexpected EOF while looking for matching/);
});

test('the same block with the quote closed passes', () => {
  const yml = workflow(`      - name: Fixed
        shell: bash
        run: |
          f() {
            echo "$1"
          }
          f hi
`);
  const { checked, failures } = checkRuns(extractRuns(yml));
  assert.equal(checked, 1);
  assert.equal(failures.length, 0);
});

test('explicit non-bash shells are skipped', () => {
  const yml = workflow(`      - name: PS
        shell: pwsh
        run: |
          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`);
  const { checked, skipped, failures } = checkRuns(extractRuns(yml));
  assert.equal(checked, 0);
  assert.equal(skipped, 1);
  assert.equal(failures.length, 0);
});

test('Windows runners default to pwsh and are skipped', () => {
  const yml = `name: T
on: push
jobs:
  j:
    runs-on: windows-2022
    steps:
      - name: PS
        run: |
          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`;
  const { checked, skipped } = checkRuns(extractRuns(yml));
  assert.equal(checked, 0);
  assert.equal(skipped, 1);
});

test('Windows-leg gated steps in a matrix job are skipped, unix legs checked', () => {
  const yml = `name: T
on: push
jobs:
  j:
    runs-on: \${{ matrix.platform }}
    steps:
      - name: Windows only
        if: matrix.os == 'Windows'
        run: |
          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      - name: Unix only
        if: matrix.os != 'Windows'
        run: |
          chmod +x ./tool
`;
  const { checked, skipped, failures } = checkRuns(extractRuns(yml));
  assert.equal(skipped, 1);
  assert.equal(checked, 1);
  assert.equal(failures.length, 0);
});

test('${{ }} expressions are stubbed before parsing', () => {
  const yml = workflow(`      - name: Expr
        run: gh api repos/\${{ github.repository }}/commits -f ref=refs/tags/v\${{ steps.v.outputs.version }}
`);
  const { checked, failures } = checkRuns(extractRuns(yml));
  assert.equal(checked, 1);
  assert.equal(failures.length, 0);
});

test('- run: | as the first step key is extracted', () => {
  const yml = workflow(`      - run: |
          echo one
          echo two
`);
  const steps = extractRuns(yml);
  assert.equal(steps.length, 1);
  assert.match(steps[0].run, /echo one/);
  assert.equal(checkRuns(steps).failures.length, 0);
});

test('explicit shell: bash on a Windows runner is still checked', () => {
  const yml = `name: T
on: push
jobs:
  j:
    runs-on: windows-2022
    steps:
      - name: Git bash step
        shell: bash
        run: |
          echo "$1
`;
  const { checked, failures } = checkRuns(extractRuns(yml));
  assert.equal(checked, 1);
  assert.equal(failures.length, 1);
});

test('steps after a dedent that ends the steps block are ignored', () => {
  const yml = `name: T
on: push
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
  k:
    runs-on: ubuntu-latest
    env:
      X: "echo \\"unterminated"
`;
  const steps = extractRuns(yml);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].run, 'echo ok');
});

// Locks the fix for the auto-tag.yml regression and guards every workflow.
test('all repository workflow run blocks pass bash -n', () => {
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const { failures } = checkRuns(extractRuns(readFileSync(join(WORKFLOWS, file), 'utf8')));
    assert.deepEqual(failures, [], file);
  }
});

// Exercise the real job expression on synthetic GitHub contexts. Workflow
// paths are a closed list; no network, credentials or publisher is invoked.
function autoTagAllowed(eventName, { repo = 'ashlrai/ashlr-md', headRepo = repo,
  conclusion = 'success', event = 'push', ref = 'refs/heads/main' } = {}) {
  const source = readFileSync(join(WORKFLOWS, 'auto-tag.yml'), 'utf8');
  const condition = source.match(/^    if: (.+)$/m)?.[1];
  assert.ok(condition, 'tag job condition exists');
  const fields = new Set(['github.event_name', 'github.event.workflow_run.conclusion',
    'github.event.workflow_run.event', 'github.event.workflow_run.head_repository.full_name',
    'github.repository', 'github.ref']);
  const identifiers = condition.replace(/'[^']*'/g, '').match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [];
  assert.ok(identifiers.every(field => fields.has(field)), 'closed condition field vocabulary');
  assert.match(condition, /^[A-Za-z0-9_.'/:()=&| -]+$/);
  return runInNewContext(condition, { github: { event_name: eventName, repository: repo, ref,
    event: { workflow_run: { conclusion, event, head_repository: { full_name: headRepo } } } } }, { timeout: 100 });
}

test('auto-tag admits successful same-repository push CI but denies fork or missing origin', () => {
  assert.equal(autoTagAllowed('workflow_run'), true);
  assert.equal(autoTagAllowed('workflow_run', { headRepo: 'untrusted/fork' }), false);
  assert.equal(autoTagAllowed('workflow_run', { headRepo: '' }), false);
  assert.equal(autoTagAllowed('workflow_run', { conclusion: 'failure' }), false);
  assert.equal(autoTagAllowed('workflow_run', { event: 'pull_request' }), false);
});

test('auto-tag keeps direct push and canonical main manual entry points unchanged', () => {
  assert.equal(autoTagAllowed('push', { conclusion: '', event: '', headRepo: '' }), true);
  assert.equal(autoTagAllowed('workflow_dispatch', { conclusion: '', event: '', headRepo: '' }), true);
  assert.equal(autoTagAllowed('workflow_dispatch', { ref: 'refs/heads/other', conclusion: '', event: '', headRepo: '' }), false);
});
