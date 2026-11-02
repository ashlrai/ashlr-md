import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// An exception must explain the dependency and why its lifecycle script is needed.
function unsafeInstalls(source) {
  const lines = source.split(/\r?\n/);
  return lines.flatMap((line, index) => {
    if (/^\s*#/.test(line) || !/(?:^|[;&|]\s*)(?:bun|npm|pnpm|yarn)\s+install\b/.test(line.trim())) return [];
    if (/\s--ignore-scripts(?:\s|$|[;&])/.test(line)) return [];
    if (/^\s*#\s*ignore-scripts exception:\s*\S.+/i.test(lines[index - 1] ?? '')) return [];
    return [index + 1];
  });
}

test('install scripts disable dependency lifecycle scripts or document an exception', () => {
  for (const file of ['install.sh', 'generate-icons.sh']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.deepEqual(unsafeInstalls(source), [], `${file} has unprotected install lines`);
  }
});

test('install guard requires a flag or an immediately preceding explanation', () => {
  assert.deepEqual(unsafeInstalls('bun install --frozen-lockfile'), [1]);
  assert.deepEqual(unsafeInstalls('bun install --ignore-scripts'), []);
  assert.deepEqual(unsafeInstalls('# ignore-scripts exception: native package needs its build\nbun install'), []);
  assert.deepEqual(unsafeInstalls('# unrelated comment\nbun install'), [2]);
  assert.deepEqual(unsafeInstalls('# bun install\necho done'), []);
});
