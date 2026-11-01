import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('updater assembly test does not hard-code a /tmp/ path', async () => {
  const source = await readFile(new URL('./test-assemble-updater.py', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\/tmp\//);
});
