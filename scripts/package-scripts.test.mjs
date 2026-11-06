import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

// Match repository-relative paths at shell word boundaries, including paths
// quoted as a whole and commands joined without whitespace (e.g. a&&b).
function references(scripts) {
  const paths = [];
  for (const [name, command] of Object.entries(scripts)) {
    const pattern = /(?:^|[\s"'`=;&|()<>])(?:\.\/)?(scripts\/[\w./@+-]+)/g;
    for (const match of command.matchAll(pattern)) paths.push({ name, path: match[1] });
  }
  return paths;
}

function missingFiles(scripts, isFile) {
  return references(scripts).filter(({ path }) => !isFile(path));
}

test('finds script paths across shell commands and reports their npm script', () => {
  const scripts = { check: 'node ./scripts/a.mjs&&node "scripts/ci/b.test.mjs"; cat scripts/missing.sh', other: 'echo nonscripts/nope' };
  assert.deepEqual(missingFiles(scripts, path => path !== 'scripts/missing.sh'), [
    { name: 'check', path: 'scripts/missing.sh' },
  ]);
  assert.deepEqual(references(scripts).map(item => item.path), [
    'scripts/a.mjs', 'scripts/ci/b.test.mjs', 'scripts/missing.sh',
  ]);
});

test('every scripts/ file referenced by package.json exists', () => {
  const { scripts } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const missing = missingFiles(scripts, path => {
    try {
      return statSync(resolve(root, path)).isFile();
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
  });
  assert.deepEqual(missing, [], `Missing script files:\n${missing.map(({ name, path }) => `  ${name}: ${path}`).join('\n')}`);
});
