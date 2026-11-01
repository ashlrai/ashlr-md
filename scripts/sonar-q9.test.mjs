import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plan } from './ci/select.mjs';
import { reapplyHunks } from './resolve-conflicts.mjs';

test('partial crate selections retain deterministic code-point ordering', () => {
  const files = [
    'src-tauri/bins/mdopener-mcp/src/lib.rs',
    'src-tauri/bins/mdopen/src/main.rs',
  ];
  for (const paths of [files, [...files].reverse(), [...files, ...files]]) {
    assert.equal(plan('pull_request', paths).rustArgs, '-p mdopen -p mdopener-mcp');
  }
});

test('hunk matching rejects partial preimages and chooses the nearest complete match', () => {
  const patch = '@@ -3,2 +3,2 @@\n same\n-old\n+new';
  assert.deepEqual(reapplyHunks('same\nwrong\nsame\nold\nsame\nold', patch), {
    text: 'same\nwrong\nsame\nnew\nsame\nold', applied: 1, skipped: 0,
  });
});

test('missing complete preimages preserve main and report the skipped hunk', () => {
  assert.deepEqual(reapplyHunks('same\nwrong', '@@ -1,2 +1,2 @@\n same\n-old\n+new'), {
    text: 'same\nwrong', applied: 0, skipped: 1,
  });
});
