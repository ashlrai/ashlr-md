import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPTS_DIR, '..');

const PKG = JSON.parse(
  readFileSync(resolve(ROOT, 'package.json'), 'utf8'),
);

test('patchedDependencies has at least one entry', () => {
  assert.ok(
    PKG.patchedDependencies && Object.keys(PKG.patchedDependencies).length > 0,
    'patchedDependencies must list at least one patched dependency',
  );
});

test('every patchedDependency points to an existing patch file whose first line is diff --git', () => {
  const deps = PKG.patchedDependencies;
  assert.ok(deps, 'patchedDependencies must exist');

  for (const [spec, patchPath] of Object.entries(deps)) {
    assert.ok(
      typeof patchPath === 'string' && patchPath.length > 0,
      `${spec} maps to a non-empty string path`,
    );

    const resolved = resolve(ROOT, patchPath);
    assert.ok(
      existsSync(resolved),
      `patch file for ${spec} should exist at ${patchPath}`,
    );

    const content = readFileSync(resolved, 'utf8');
    const firstLine = content.split('\n')[0];
    assert.ok(
      firstLine.startsWith('diff --git'),
      `${patchPath} must start with "diff --git", got: ${JSON.stringify(firstLine)}`,
    );
  }
});
