import assert from 'node:assert/strict';
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
  assert.match(failures[0].stderr, /syntax error/);
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
