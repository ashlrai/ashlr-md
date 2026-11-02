import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { blocks, regenerate, root, run, sources } from './sync.mjs';

const expected = {
  'version-badge': 'release-0.4.0-0969da.svg',
  'install-snippet': 'Ashlr_MD_X.Y.Z_x64-setup.exe /S',
  'version-table': '| Desktop app | 0.4.0 |',
  'example-release-page': "ASHLR_MD_RELEASE='https://github.com/ashlrai/ashlr-md/releases/latest'",
  'site-download': 'https://github.com/ashlrai/ashlr-md/releases/tag/v0.4.0',
};
for (const [name, text] of Object.entries(expected)) {
  test(`generates ${name} and preserves surrounding prose`, () => {
    const source = `before\n<!-- fresh:begin ${name} -->\nstale\n<!-- fresh:end -->\nafter\n`;
    const templates = blocks({ sourceVersion: '0.5.0', publishedVersion: '0.4.0', publishedDate: '2026-06-06' });
    const result = regenerate(source, templates, 'fixture.md');
    assert.ok(result.includes(text));
    assert.ok(result.startsWith('before\n'));
    assert.ok(result.endsWith('\nafter\n'));
    assert.equal(regenerate(result, templates, 'fixture.md'), result);
    assert.equal(regenerate(source.replaceAll('\n', '\r\n'), templates, 'fixture.md'), result.replaceAll('\n', '\r\n'));
  });
}

test('rejects malformed, unknown, nested and unmatched markers', () => {
  for (const source of [
    '<!-- fresh:begin unknown -->', '<!-- fresh:end -->',
    '<!-- fresh:begin version-badge -->', '<!-- fresh:begin version-badge-->',
    '<!-- fresh:begin version-badge -->\n<!-- fresh:begin version-table -->',
  ]) assert.throws(() => regenerate(source, blocks({ publishedVersion: '0.4.0' }), 'fixture.md'), /fixture.md:/);
});

async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'md-release-freshness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const path of ['src-tauri', 'docs/nested', 'samples', 'landing', 'scripts/freshness']) {
    await mkdir(resolve(directory, path), { recursive: true });
  }
  for (const script of ['sync.mjs', 'check.mjs']) await cp(resolve(root, 'scripts/freshness', script), resolve(directory, 'scripts/freshness', script));
  for (const path of ['package.json', 'src-tauri/tauri.conf.json']) await writeFile(resolve(directory, path), JSON.stringify({ version: '0.4.0' }));
  await writeFile(resolve(directory, 'scripts/freshness/published.json'), '{"version":"0.4.0"}\n');
  await writeFile(resolve(directory, 'CHANGELOG.md'), '# Changelog\n<!-- fresh:begin version-table -->\nstale\n<!-- fresh:end -->\n\n## [0.4.0] - 2026-06-06\n');
  await writeFile(resolve(directory, 'README.md'), '<!-- fresh:begin version-badge -->\nstale\n<!-- fresh:end -->\n');
  await writeFile(resolve(directory, 'docs/nested/install.md'), '<!-- fresh:begin install-snippet -->\nstale\n<!-- fresh:end -->\n');
  await writeFile(resolve(directory, 'samples/plan.md'), '<!-- fresh:begin example-release-page -->\nstale\n<!-- fresh:end -->\n');
  await writeFile(resolve(directory, 'landing/index.html'), '<!-- fresh:begin site-download -->\nstale\n<!-- fresh:end -->\n');
  return directory;
}

test('a dated future source build does not publish it or change runtime version', async (t) => {
  const directory = await fixture(t);
  const read = (path) => readFile(resolve(directory, path), 'utf8');
  const cli = (name) => spawnSync(process.execPath, [resolve(directory, `scripts/freshness/${name}.mjs`)], { encoding: 'utf8', cwd: tmpdir() });
  assert.equal(cli('check').status, 1);
  assert.match(cli('check').stderr, /Freshness drift/);
  { const result = cli('sync'); assert.equal(result.status, 0, result.stderr); }
  assert.equal(cli('check').status, 0);
  assert.deepEqual(await run(directory, true), []);

  // Simulate a fully versioned candidate without changing the release receipt.
  for (const path of ['package.json', 'src-tauri/tauri.conf.json', 'server.json']) {
    await writeFile(resolve(directory, path), '{"version":"0.5.0"}\n');
  }
  await writeFile(resolve(directory, 'src-tauri/Cargo.toml'), '[package]\nversion = "0.5.0"\n');
  const changelog = await read('CHANGELOG.md');
  await writeFile(resolve(directory, 'CHANGELOG.md'), changelog.replace('## [0.4.0]', '## [0.5.0] - 2026-11-01\n\nCandidate.\n\n## [0.4.0]'));
  assert.deepEqual(await sources(directory), { sourceVersion: '0.5.0', publishedVersion: '0.4.0', publishedDate: '2026-06-06' });
  { const result = cli('sync'); assert.equal(result.status, 0, result.stderr); }
  assert.equal(cli('check').status, 0);
  assert.match(await read('README.md'), /release-0\.4\.0/);
  assert.match(await read('CHANGELOG.md'), /Desktop app \| 0\.4\.0/);
  const html = await read('landing/index.html');
  assert.match(html, /href="https:\/\/github\.com\/ashlrai\/ashlr-md\/releases\/tag\/v0\.4\.0"/);
  assert.doesNotMatch(html, /0\.5\.0/);
  assert.match(await read('docs/nested/install.md'), /Ashlr_MD_X\.Y\.Z_x64-setup\.exe/);
  assert.doesNotMatch(await read('samples/plan.md'), /0\.4\.0|0\.5\.0/);
  assert.equal(JSON.parse(await read('package.json')).version, '0.5.0');
  assert.equal(JSON.parse(await read('src-tauri/tauri.conf.json')).version, '0.5.0');
  assert.equal(JSON.parse(await read('server.json')).version, '0.5.0');
  assert.match(await read('src-tauri/Cargo.toml'), /version = "0\.5\.0"/);

  // Only an explicit receipt change advances public claims.
  await writeFile(resolve(directory, 'scripts/freshness/published.json'), '{"version":"0.5.0"}\n');
  { const result = cli('sync'); assert.equal(result.status, 0, result.stderr); }
  assert.equal(cli('check').status, 0);
  assert.match(await read('landing/index.html'), /releases\/tag\/v0\.5\.0/);
  assert.match(await read('README.md'), /release-0\.5\.0/);
});

test('invalid or ambiguous receipts fail before any write', async (t) => {
  const directory = await fixture(t);
  await run(directory);
  const readme = await readFile(resolve(directory, 'README.md'), 'utf8');
  const receipt = resolve(directory, 'scripts/freshness/published.json');
  await rm(receipt);
  await assert.rejects(run(directory), /published\.json/);
  assert.equal(await readFile(resolve(directory, 'README.md'), 'utf8'), readme);
  for (const invalid of ['not-json', '{}', '{"version":"not-a-version"}', '{"version":"9.9.9"}']) {
    await writeFile(receipt, invalid);
    await assert.rejects(run(directory));
    assert.equal(await readFile(resolve(directory, 'README.md'), 'utf8'), readme);
  }
  await writeFile(receipt, '{"version":"0.4.0"}');
  const path = resolve(directory, 'CHANGELOG.md');
  await writeFile(path, (await readFile(path, 'utf8')) + '\n## [0.4.0] - 2026-06-07\n');
  await assert.rejects(run(directory), /exactly one dated changelog/);
  assert.equal(await readFile(resolve(directory, 'README.md'), 'utf8'), readme);
});

test('invalid blocks and source disagreement prevent all writes', async (t) => {
  const directory = await fixture(t);
  const readmePath = resolve(directory, 'README.md');
  await writeFile(readmePath, '<!-- fresh:end -->');
  await assert.rejects(run(directory), /unmatched/);
  assert.ok(!(await readFile(resolve(directory, 'CHANGELOG.md'), 'utf8')).includes('| Desktop app |'));
  await writeFile(resolve(directory, 'package.json'), '{"version":"0.5.0"}');
  await assert.rejects(run(directory), /disagree/);
  assert.equal(await readFile(readmePath, 'utf8'), '<!-- fresh:end -->');
});
