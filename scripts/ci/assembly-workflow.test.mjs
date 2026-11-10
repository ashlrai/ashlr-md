import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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


test('provenance API reads authenticate with the read-only job token', () => {
  // Anonymous api.github.com reads share 60/hour per runner IP; prepare plus
  // assemble each rerun the full proof and failed with HTTP 403 rate limit.
  for (const name of ['Download original source-bound artifact ZIPs', 'Assemble and verify all four updater payloads']) {
    const start = workflow.indexOf(`- name: ${name}\n`);
    assert.ok(start > 0, name);
    const step = workflow.slice(start, workflow.indexOf('\n      - ', start + 1));
    assert.match(step, /^\s+GH_TOKEN: \$\{\{ github\.token \}\}$/m, name);
  }
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
  const simulate = runs.find(step => step.name === 'Simulate fixed plans and compare official archive mirrors').run;
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

test('Linux CI upgrades source URIs from its checked-out source before the unchanged install', () => {
  const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const linux = ci.slice(ci.indexOf('    name: Linux full suite'), ci.indexOf('  macos:'));
  assert.match(linux, /timeout-minutes: 30/);
  assert.match(linux, /uses: actions\/checkout@[a-f0-9]{40}/);
  const step = extractRuns(linux).find(item => item.name === 'Install Linux system dependencies');
  assert.match(linux, /name: Install Linux system dependencies\n\s+timeout-minutes: 15/);
  assert.match(step.run, /^sudo python3 scripts\/apt-https-sources\.py\n/);
  assert.match(step.run, /Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30/);
  assert.match(step.run, /sudo apt-get "\$\{apt_opts\[@\]\}" update/);
  assert.doesNotMatch(step.run, /no-install-recommends/);
});

test('assembly dispatch peels an annotated tag and refuses a downgrade', () => {
  const source = readFileSync(new URL('../../.github/workflows/release-assemble-dispatch.yml', import.meta.url), 'utf8');
  const step = extractRuns(source).find(item => item.name === 'Validate the release build and CI, then dispatch assembly');
  assert.ok(step);
  assert.match(step.run, /git\/ref\/tags/);
  assert.match(step.run, /refs\/tags\//);
  assert.equal(step.run.split('peel_release_tag').length - 1, 3);
  assert.doesNotMatch(step.run, /commits\/\$RELEASE_TAG/);
  assert.doesNotMatch(step.run, /2>\/dev\/null/);
  assert.doesNotMatch(step.run, /grep -q 404/);
  assert.match(step.run, /gh api -i /);
  assert.match(step.run, /\[ "\$http_status" = 404 \]/);
  assert.match(step.run, /could not read/);
  assert.match(step.run, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.doesNotMatch(step.run, /--log|version carriers match/);
  const directory = mkdtempSync(join(tmpdir(), 'md-dispatch-'));
  const bin = join(directory, 'bin');
  const runner = join(directory, 'runner');
  mkdirSync(bin);
  mkdirSync(runner);
  const trace = join(directory, 'trace');
  const dispatched = join(directory, 'dispatched');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TRACE"
case "$*" in
  *"run download"*)
    dir=$(printf '%s\\n' "$*" | sed -n 's/.*--dir //p')
    mkdir -p "$dir"
    printf '%s\\n' '{"event":"workflow_dispatch","inputs_version":"0.7.5","version":"0.7.5","tag":"v0.7.5","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' > "$dir/release-binding.json"
    ;;
  *git/ref/tags/v0.7.5*)
    printf '%s\\n' '{"ref":"refs/tags/v0.7.5","object":{"type":"tag","sha":"dddddddddddddddddddddddddddddddddddddddd"}}'
    ;;
  *git/tags/dddddddddddddddddddddddddddddddddddddddd*)
    printf '%s\\n' '{"sha":"dddddddddddddddddddddddddddddddddddddddd","object":{"type":"commit","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'
    ;;
  *git/ref/tags/v0.7.3*)
    if [ -n "\${GH_FAKE_REF_NAME:-}" ]; then
      printf '%s\\n' "{\\"ref\\":\\"\${GH_FAKE_REF_NAME}\\",\\"object\\":{\\"type\\":\\"commit\\",\\"sha\\":\\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\"}}"
    elif [ -n "\${GH_FAKE_PUSH_ANNOTATED:-}" ]; then
      printf '%s\\n' '{"ref":"refs/tags/v0.7.3","object":{"type":"tag","sha":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}}'
    else
      printf '%s\\n' '{"ref":"refs/tags/v0.7.3","object":{"type":"commit","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}'
    fi
    ;;
  *git/tags/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee*)
    printf '%s\\n' '{"sha":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","object":{"type":"commit","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}'
    ;;
  *releases/tags/*|*releases/latest*)
    code=404
    if [ -n "\${GH_FAKE_HTTP_STATUS:-}" ]; then code="\${GH_FAKE_HTTP_STATUS}"; fi
    if [ -n "\${GH_FAKE_RELEASE_ERROR:-}" ] && printf '%s' "$*" | grep -q 'releases/tags/'; then code=500; fi
    if [ -n "\${GH_FAKE_LATEST_ERROR:-}" ] && printf '%s' "$*" | grep -q 'releases/latest'; then code=500; fi
    if [ -n "\${GH_FAKE_LATEST:-}" ] && printf '%s' "$*" | grep -q 'releases/latest' && [ "\$code" = 404 ]; then
      printf '%s\\n\\n%s\\n' 'HTTP/2.0 200 OK' "{\\"tag_name\\":\\"\${GH_FAKE_LATEST}\\",\\"draft\\":false}"
      exit 0
    fi
    printf '%s\\n\\n%s\\n' "HTTP/2.0 \${code} Synthetic" "{\\"message\\":\\"body mentions 404\\",\\"status\\":\\"\${code}\\"}"
    if [ "\$code" = 200 ]; then exit 0; fi
    exit 1
    ;;
  *actions/runs/42739085824*) printf '%s\\n' '.github/workflows/release.yml workflow_dispatch success 1 main cccccccccccccccccccccccccccccccccccccccc' ;;
  *actions/runs/99*) printf '%s\\n' '.github/workflows/release.yml push success 1 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' ;;
  *workflows/ci.yml/runs*) printf '%s\\n' 1 ;;
  *"workflow run"*) printf '%s\\n' "$*" > "$DISPATCHED" ;;
  *) echo "unmocked: $*" >&2; exit 9 ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const base = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TRACE: trace,
    DISPATCHED: dispatched,
    RUNNER_TEMP: runner,
    REPO: 'ashlrai/ashlr-md',
  };
  try {
    const dispatchedRun = spawnSync('bash', ['-c', step.run], {
      encoding: 'utf8',
      env: {
        ...base,
        EVENT: 'workflow_dispatch',
        HEAD_BRANCH: 'main',
        HEAD_SHA: 'c'.repeat(40),
        RELEASE_RUN_ID: '42739085824',
      },
    });
    assert.equal(dispatchedRun.status, 0, dispatchedRun.stderr + dispatchedRun.stdout);
    const sent = readFileSync(dispatched, 'utf8');
    assert.match(sent, /release_tag=v0\.7\.5/);
    assert.match(sent, /source_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    const calls = readFileSync(trace, 'utf8');
    assert.match(calls, /git\/ref\/tags\/v0\.7\.5/);
    assert.match(calls, /git\/tags\/dddddddddddddddddddddddddddddddddddddddd/);
    assert.doesNotMatch(calls, /--log/);
    rmSync(dispatched);
    const downgraded = spawnSync('bash', ['-c', step.run], {
      encoding: 'utf8',
      env: { ...base, EVENT: 'workflow_dispatch', HEAD_BRANCH: 'main', HEAD_SHA: 'c'.repeat(40),
        RELEASE_RUN_ID: '42739085824', GH_FAKE_LATEST: 'v9.9.9' },
    });
    assert.notEqual(downgraded.status, 0);
    assert.match(downgraded.stderr + downgraded.stdout, /not strictly greater/);
    const pushed = spawnSync('bash', ['-c', step.run], {
      encoding: 'utf8',
      env: { ...base, EVENT: 'push', HEAD_BRANCH: 'v0.7.3', HEAD_SHA: 'b'.repeat(40), RELEASE_RUN_ID: '99' },
    });
    assert.equal(pushed.status, 0, pushed.stderr + pushed.stdout);
    assert.match(readFileSync(dispatched, 'utf8'), /source_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
    assert.match(readFileSync(trace, 'utf8'), /git\/ref\/tags\/v0\.7\.3/);
    assert.doesNotMatch(readFileSync(trace, 'utf8'), /commits\/v0\.7\.3/);
    rmSync(dispatched);
    const annotatedPush = spawnSync('bash', ['-c', step.run], {
      encoding: 'utf8',
      env: { ...base, EVENT: 'push', HEAD_BRANCH: 'v0.7.3', HEAD_SHA: 'b'.repeat(40), RELEASE_RUN_ID: '99',
        GH_FAKE_PUSH_ANNOTATED: '1' },
    });
    assert.equal(annotatedPush.status, 0, annotatedPush.stderr + annotatedPush.stdout);
    assert.match(readFileSync(trace, 'utf8'), /git\/tags\/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/);
    assert.match(readFileSync(dispatched, 'utf8'), /source_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
    rmSync(dispatched);
    const unanchored = spawnSync('bash', ['-c', step.run], {
      encoding: 'utf8',
      env: { ...base, EVENT: 'push', HEAD_BRANCH: 'v0.7.3', HEAD_SHA: 'b'.repeat(40), RELEASE_RUN_ID: '99',
        GH_FAKE_REF_NAME: 'refs/heads/v0.7.3' },
    });
    assert.notEqual(unanchored.status, 0);
    assert.match(unanchored.stderr + unanchored.stdout, /tag ref mismatch/);
    assert.throws(() => readFileSync(dispatched, 'utf8'));
    const releaseError = spawnSync('bash', ['-c', step.run], {
      encoding: 'utf8',
      env: { ...base, EVENT: 'workflow_dispatch', HEAD_BRANCH: 'main', HEAD_SHA: 'c'.repeat(40),
        RELEASE_RUN_ID: '42739085824', GH_FAKE_RELEASE_ERROR: 'HTTP 500: Server Error' },
    });
    assert.notEqual(releaseError.status, 0);
    assert.match(releaseError.stderr + releaseError.stdout, /could not read the GitHub Release/);
    assert.throws(() => readFileSync(dispatched, 'utf8'));
    const latestError = spawnSync('bash', ['-c', step.run], {
      encoding: 'utf8',
      env: { ...base, EVENT: 'workflow_dispatch', HEAD_BRANCH: 'main', HEAD_SHA: 'c'.repeat(40),
        RELEASE_RUN_ID: '42739085824', GH_FAKE_LATEST_ERROR: 'HTTP 500: Server Error' },
    });
    assert.notEqual(latestError.status, 0);
    assert.match(latestError.stderr + latestError.stdout, /could not read the latest GitHub Release/);
    assert.throws(() => readFileSync(dispatched, 'utf8'));
    const mentions404 = spawnSync('bash', ['-c', step.run], {
      encoding: 'utf8',
      env: { ...base, EVENT: 'workflow_dispatch', HEAD_BRANCH: 'main', HEAD_SHA: 'c'.repeat(40),
        RELEASE_RUN_ID: '42739085824', GH_FAKE_HTTP_STATUS: '500' },
    });
    assert.notEqual(mentions404.status, 0, mentions404.stderr + mentions404.stdout);
    assert.match(mentions404.stderr + mentions404.stdout, /could not read the GitHub Release/);
    assert.throws(() => readFileSync(dispatched, 'utf8'));
    const notThreeDigits = spawnSync('bash', ['-c', step.run], {
      encoding: 'utf8',
      env: { ...base, EVENT: 'workflow_dispatch', HEAD_BRANCH: 'main', HEAD_SHA: 'c'.repeat(40),
        RELEASE_RUN_ID: '42739085824', GH_FAKE_HTTP_STATUS: '4040' },
    });
    assert.notEqual(notThreeDigits.status, 0);
    assert.match(notThreeDigits.stderr + notThreeDigits.stdout, /could not read the GitHub Release/);
    assert.throws(() => readFileSync(dispatched, 'utf8'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('every setup-bun step pins an exact Bun version instead of resolving latest', () => {
  for (const file of ['ci.yml', 'release.yml']) {
    const text = readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
    const pins = [...text.matchAll(/bun-version:\s*(\S+)/g)].map(m => m[1]);
    assert.ok(pins.length >= 1, `${file} installs Bun`);
    for (const pin of pins) assert.match(pin, /^\d+\.\d+\.\d+$/, `${file} must not float on ${pin}`);
  }
});
