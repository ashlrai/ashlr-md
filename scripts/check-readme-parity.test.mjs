import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkReadme } from './check-readme-parity.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'readme-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/check.mjs'), '');
  return root;
}

test('repository README has no unmatched entries', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  assert.deepEqual(checkReadme(root).errors, []);
});

test('made-up scripts fail for each package manager, including inline commands', t => {
  const root = fixture(t);
  for (const manager of ['bun', 'npm', 'pnpm', 'yarn']) {
    const result = checkReadme(root, `Run \`${manager} run made-up\` next.`);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /README.md:1: unknown package script made-up/);
  }
  assert.deepEqual(checkReadme(root, '`npm run test -- --watch`').errors, []);
  assert.equal(checkReadme(root, '`bun run toString`').errors.length, 1);
});

test('checks command arguments, inline paths, links and HTML images', t => {
  const root = fixture(t);
  const markdown = '```bash\nnode scripts/missing.mjs\n```\n`missing.json`\n[doc](missing.md#heading)\n<img src="missing.png" />';
  assert.equal(checkReadme(root, markdown).errors.length, 4);
  assert.deepEqual(checkReadme(root, '`node scripts/check.mjs`').errors, []);
});

test('cd resolves subsequent paths and resets at the next fence', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'scripts/build.sh'), '');
  assert.deepEqual(checkReadme(root, '```bash\ncd scripts && ./build.sh\n./build.sh\n```\n`script.json`').errors,
    ['README.md:5: missing repository path script.json']);
});

test('classifies installed paths, examples and external references without probing them', t => {
  const root = fixture(t);
  const result = checkReadme(root, '`~/.cursor/mcp.json` `/Applications/Ashlr MD.app` `notes.md` `docs/LOCAL-INFERENCE.md` [web](https://example.com/no.md)');
  assert.deepEqual(result.errors, []);
  assert.equal(result.entries.filter(e => e.kind === 'example/runtime/other-repo').length, 4);
});

test('checker finds a made-up script injected into the real README', () => {
  const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
  assert.match(checkReadme(root, '`bun run made-up`').errors.join('\n'), /unknown package script made-up/);
});

test('CLI exits nonzero on a made-up script', t => {
  const root = fixture(t);
  const checker = join(root, 'scripts/check-readme-parity.mjs');
  copyFileSync(fileURLToPath(new URL('./check-readme-parity.mjs', import.meta.url)), checker);
  writeFileSync(join(root, 'README.md'), '`npm run made-up`');
  const result = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown package script made-up/);
});
