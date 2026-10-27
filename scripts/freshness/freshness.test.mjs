import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { blocks, regenerate, root, run } from './sync.mjs';

const expected = {
  'version-badge': 'release-1.2.3-0969da.svg',
  'install-snippet': 'Ashlr_MD_1.2.3_x64-setup.exe /S',
  'version-table': '| Desktop app | 1.2.3 |',
  'example-version-pin': "ASHLR_MD_VERSION='1.2.3'",
};
for (const [name, text] of Object.entries(expected)) {
  test(`generates ${name} and preserves surrounding prose`, () => {
    const source = `before\n<!-- fresh:begin ${name} -->\nstale\n<!-- fresh:end -->\nafter\n`;
    const result = regenerate(source, blocks({ version: '1.2.3', date: '2026-01-02' }), 'fixture.md');
    assert.ok(result.includes(text));
    assert.ok(result.startsWith('before\n'));
    assert.ok(result.endsWith('\nafter\n'));
    assert.equal(regenerate(result, blocks({ version: '1.2.3', date: '2026-01-02' }), 'fixture.md'), result);
    assert.equal(regenerate(source.replaceAll('\n', '\r\n'), blocks({ version: '1.2.3', date: '2026-01-02' }), 'fixture.md'), result.replaceAll('\n', '\r\n'));
  });
}

test('rejects malformed, unknown, nested and unmatched markers', () => {
  for (const source of [
    '<!-- fresh:begin unknown -->', '<!-- fresh:end -->',
    '<!-- fresh:begin version-badge -->', '<!-- fresh:begin version-badge-->',
    '<!-- fresh:begin version-badge -->\n<!-- fresh:begin version-table -->',
  ]) assert.throws(() => regenerate(source, blocks({ version: '1.2.3' }), 'fixture.md'), /fixture.md:/);
});

test('CLI detects seeded drift, sync repairs it, and release bumps propagate', async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'freshness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const path of ['src-tauri', 'docs/nested', 'samples', 'scripts/freshness']) await mkdir(resolve(directory, path), { recursive: true });
  for (const script of ['sync.mjs', 'check.mjs']) await cp(resolve(root, 'scripts/freshness', script), resolve(directory, 'scripts/freshness', script));
  const writeSources = async (version) => {
    for (const path of ['package.json', 'src-tauri/tauri.conf.json']) await writeFile(resolve(directory, path), JSON.stringify({ version }));
    await writeFile(resolve(directory, 'CHANGELOG.md'), `# Changelog\n\n## [9.0.0] - Unreleased\n\n## [${version}] - 2026-01-02\n\nHistorical prose.\n`);
  };
  await writeSources('1.2.3');
  const files = ['README.md', 'docs/nested/install.md', 'docs/versions.md', 'samples/pins.md'];
  for (const [index, name] of Object.keys(expected).entries()) await writeFile(resolve(directory, files[index]), `<!-- fresh:begin ${name} -->\nstale\n<!-- fresh:end -->\n`);
  const cli = (name) => spawnSync(process.execPath, [resolve(directory, `scripts/freshness/${name}.mjs`)], { encoding: 'utf8', cwd: tmpdir() });
  assert.equal(cli('check').status, 1);
  assert.match(cli('check').stderr, /Freshness drift/);
  assert.match(await readFile(resolve(directory, 'README.md'), 'utf8'), /stale/);
  { const result = cli('sync'); assert.equal(result.status, 0, result.stderr); }
  assert.equal(cli('check').status, 0);
  assert.deepEqual(await run(directory, true), []);
  for (const [index, text] of Object.values(expected).entries()) assert.ok((await readFile(resolve(directory, files[index]), 'utf8')).includes(text));
  await writeSources('2.0.0');
  assert.equal(cli('check').status, 1);
  { const result = cli('sync'); assert.equal(result.status, 0, result.stderr); }
  assert.equal(cli('check').status, 0);
  for (const file of files) assert.ok((await readFile(resolve(directory, file), 'utf8')).includes('2.0.0'));
  await writeFile(resolve(directory, 'package.json'), '{"version":"3.0.0"}');
  assert.equal(cli('sync').status, 1);
  await writeSources('2.0.0');
  await writeFile(resolve(directory, 'CHANGELOG.md'), '## [3.0.0] - Unreleased\n');
  assert.equal(cli('check').status, 1);
});

test('invalid blocks prevent all writes', async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'freshness-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const path of ['src-tauri', 'docs', 'samples']) await mkdir(resolve(directory, path));
  for (const path of ['package.json', 'src-tauri/tauri.conf.json']) await writeFile(resolve(directory, path), '{"version":"1.2.3"}');
  await writeFile(resolve(directory, 'CHANGELOG.md'), '## [1.2.3] - 2026-01-02\n<!-- fresh:begin version-table -->\n<!-- fresh:end -->\n');
  await writeFile(resolve(directory, 'README.md'), '<!-- fresh:end -->');
  await assert.rejects(run(directory), /unmatched/);
  assert.ok(!(await readFile(resolve(directory, 'CHANGELOG.md'), 'utf8')).includes('| Desktop app |'));
});
