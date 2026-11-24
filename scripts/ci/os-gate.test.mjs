import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./os-gate.sh', import.meta.url));

function gate(needs) {
  return spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, NEEDS: needs == null ? '' : JSON.stringify(needs) },
  });
}

test('a path-gated skip passes and a failure or cancellation fails', () => {
  assert.equal(gate({ 'os-windows': { result: 'success' }, 'install-smoke-windows': { result: 'skipped' } }).status, 0);
  const failed = gate({ 'os-windows': { result: 'failure' }, 'install-smoke-windows': { result: 'skipped' } });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /os-windows=failure/);
  assert.notEqual(gate({ classify: { result: 'cancelled' } }).status, 0);
  assert.notEqual(gate(null).status, 0);
});
