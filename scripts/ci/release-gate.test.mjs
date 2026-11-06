import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { extractRuns } from './workflow-bash.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const steps = extractRuns(workflow).filter(step => step.name === 'Require a successful workflow_dispatch CI run on this sha');
assert.equal(steps.length, 1, 'exercise the actual release gate');
const sha = 'a'.repeat(40);

function execute(mode) {
  // Mock only the network and clock. Execute the workflow's actual Bash to
  // reproduce a tag arriving before the matching post-merge full CI finishes.
  const prelude = `
round=0
gh() {
  [ "$#" = 4 ] && [ "$1" = api ] && [ "$3" = --jq ] && [ "$4" = .total_count ] || return 90
  case "$2" in
    "repos/ashlrai/ashlr-md/actions/workflows/ci.yml/runs?event=workflow_dispatch&head_sha=$SHA&status=success&per_page=1") query_event=workflow_dispatch ;;
    "repos/ashlrai/ashlr-md/actions/workflows/ci.yml/runs?event=push&head_sha=$SHA&status=success&per_page=1") query_event=push ;;
    *) return 91 ;;
  esac
  case "$MODE:$round:$query_event" in
    immediate:0:push|late:2:push|manual:0:workflow_dispatch) printf '1' ;;
    malformed:*:workflow_dispatch) printf 'null' ;;
    missing:*:workflow_dispatch) printf '' ;;
    negative:*:workflow_dispatch) printf '%s' '-1' ;;
    api-error:*:workflow_dispatch) return 22 ;;
    *) printf '0' ;;
  esac
}
sleep() {
  [ "$1" = 30 ] || return 92
  round=$((round + 1))
}
`;
  const result = spawnSync('bash', ['-c', prelude + steps[0].run], {
    env: { ...process.env, MODE: mode, SHA: sha, REPO: 'ashlrai/ashlr-md', CI_WORKFLOW: 'ci.yml' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  return result;
}

for (const mode of ['immediate', 'manual', 'late']) {
  test(`release accepts ${mode} exact-SHA successful full CI`, () => {
    const result = execute(mode);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`full suite green on ${sha}`));
    assert.equal((result.stdout.match(/Waiting/g) ?? []).length, mode === 'late' ? 2 : 0);
  });
}

test('release stops after a bounded wait without successful full CI', () => {
  const result = execute('pending');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal((result.stdout.match(/Waiting/g) ?? []).length, 30);
  assert.match(result.stdout, /after 15 minutes/);
  assert.doesNotMatch(result.stdout, /full suite green/);
});

for (const mode of ['malformed', 'missing', 'negative', 'api-error']) {
  test(`release fails closed immediately on ${mode} evidence`, () => {
    const result = execute(mode);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Waiting|full suite green/);
  });
}
