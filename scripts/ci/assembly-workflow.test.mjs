import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { extractRuns } from './workflow-bash.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/release-assemble.yml', import.meta.url), 'utf8');

function readOnlyContract(text) {
  assert.match(text, /if: github\.repository == 'ashlrai\/ashlr-md' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(text, /\b(?:secrets|id-token|write-all)\b|:\s*write\b|persist-credentials:\s*true/);
  assert.doesNotMatch(text, /^\s+(?:push|pull_request|workflow_run):/m);
  for (const use of text.matchAll(/uses:\s*([^\s]+)/g)) assert.match(use[1], /@[a-f0-9]{40}$/);
  assert.match(text, /contents: read/);
  assert.match(text, /actions: read/);
  assert.match(text, /name: Upload verified staging\n\s+uses:/);
  assert.doesNotMatch(text, /if:\s*always\(\)/);
  assert.doesNotMatch(text, /gh release|npm publish|git (?:push|tag)/);
  assert.match(text, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(text, /ref: \$\{\{\s*inputs\./, 'every checkout must remain trusted policy, including when another job checks out policy too');
  const runs = extractRuns(text);
  assert.ok(runs.length >= 4);
  for (const step of runs) assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./, 'inputs must enter through quoted environment values');
}

test('hosted assembly retains read-only authority and trusted workflow source', () => readOnlyContract(workflow));

for (const [name, change] of [
  ['feature dispatch', text => text.replace("github.ref == 'refs/heads/main'", "github.ref == 'refs/heads/feature'")],
  ['release write permission', text => text.replace('contents: read', 'contents: write')],
  ['OIDC signing authority', text => text.replace('actions: read', 'actions: read\n      id-token: write')],
  ['unconditional upload', text => text.replace('name: Upload verified staging', 'name: Upload verified staging\n        if: always()')],
  ['floating inspection action', text => text.replace('actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'actions/checkout@main')],
  ['candidate code checkout', text => text.replace('ref: $' + '{{ github.sha }}', 'ref: $' + '{{ inputs.source_sha }}')],
]) test(`hosted assembly refuses ${name}`, () => assert.throws(() => readOnlyContract(change(workflow))));

test('download step passes hostile inputs as literal arguments, never shell code', () => {
  const steps = extractRuns(workflow).filter(step => step.name === 'Download original source-bound artifact ZIPs');
  assert.equal(steps.length, 1);
  const directory = mkdtempSync(join(tmpdir(), 'md-assembly-shell-'));
  try {
    const trace = join(directory, 'args.json');
    const hostile = '$(touch SHOULD_NOT_EXIST); /tmp/source';
    const prelude = `set -euo pipefail\npython3() { command node -e 'require("fs").writeFileSync(process.env.TRACE, JSON.stringify(process.argv.slice(1)))' -- "$@"; }\n`;
    const result = spawnSync('bash', ['-c', prelude + steps[0].run], {
      cwd: directory, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, TRACE: trace, RUNNER_TEMP: directory, RELEASE_TAG: 'v0.7.2', SOURCE_SHA: hostile,
        RELEASE_RUN_ID: '123', RELEASE_RUN_ATTEMPT: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(trace, 'utf8'));
    assert.deepEqual(args, ['scripts/prepare-release-assembly.py', '--tag', 'v0.7.2', '--source-sha', hostile,
      '--run-id', '123', '--run-attempt', '1']);
    assert.throws(() => readFileSync(join(directory, 'SHOULD_NOT_EXIST')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('dependency probe is an isolated simulation with no assembly authority', () => {
  const normal = workflow.slice(workflow.indexOf('  assemble:'), workflow.indexOf('  apt-plan:'));
  const probe = workflow.slice(workflow.indexOf('  apt-plan:'));
  assert.match(normal, /!inputs\.apt_plan_only/);
  for (const guard of ["github.event_name == 'workflow_dispatch'", 'inputs.apt_plan_only',
    "github.repository == 'ashlrai/ashlr-md'", "github.ref == 'refs/heads/main'", 'github.ref_protected',
    "github.workflow_ref == 'ashlrai/ashlr-md/.github/workflows/release-assemble.yml@refs/heads/main'"]) assert.ok(probe.includes(guard), guard);
  assert.match(probe, /runs-on: ubuntu-22\.04/); assert.match(probe, /timeout-minutes: 8/);
  assert.doesNotMatch(probe, /prepare-release-assembly|assemble-updater|\.release-staging|RELEASE_RUN_ID|GH_TOKEN/);
  const runs = extractRuns(probe);
  assert.equal(runs.length, 3);
  const metadata = runs.find(step => step.name === 'Refresh package metadata only').run;
  assert.match(metadata, /sudo apt-get .* update/); assert.doesNotMatch(metadata, /\binstall\b/);
  const simulate = runs.find(step => step.name === 'Simulate both fixed dependency plans without installing').run;
  assert.match(simulate, /python3 scripts\/apt-dependency-plan\.py > "\$RUNNER_TEMP\/md-apt-plan\.json"/);
  assert.doesNotMatch(simulate, /apt-get|\$\{\{.*inputs/);
});

test('dependency probe retains exactly the ten explicit full-CI prerequisites', () => {
  const helper = readFileSync(new URL('../apt-dependency-plan.py', import.meta.url), 'utf8');
  const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const install = extractRuns(ci).find(step => step.name === 'Install Linux system dependencies').run;
  const required = install.slice(install.indexOf('install -y') + 'install -y'.length).replaceAll('\\', '').trim().split(/\s+/).sort();
  const declaration = helper.slice(helper.indexOf('PACKAGES = ('), helper.indexOf('MAX_OUTPUT ='));
  const declared = [...declaration.matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
  assert.equal(declared.length, 10); assert.deepEqual(declared, required);
  assert.match(helper, /'\/usr\/bin\/apt-get', '--simulate'/);
});
