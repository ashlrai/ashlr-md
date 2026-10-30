import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkExternal,
  docFiles,
  headingSlugs,
  linkTargets,
  main,
  report,
  scan,
  slug,
} from './check-doc-links.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'doclinks-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

test('links to files, directories and anchors of the same page pass', () => {
  const root = fixture({
    'docs/a.md': [
      '# Title',
      'See [other](./b.md), [up](../README.md), [dir](../integrations/x/),',
      '[img](pic.png), [encoded](my%20note.md), [deep](sub/c.md#two),',
      '[self](#title) and [again](#title).',
      '',
    ].join('\n'),
    'docs/b.md': '# B\n',
    'docs/my note.md': '# N\n',
    'docs/pic.png': 'PNG',
    'docs/sub/c.md': '# C\n## Two\n',
    'integrations/x/README.md': '# X\n',
    'README.md': '# R\n',
  });
  const r = scan(root);
  assert.deepEqual(r.broken, []);
  assert.equal(r.files, 4);
  rmSync(root, { recursive: true });
});

test('a missing file is reported with its line', () => {
  const root = fixture({
    'docs/a.md': 'ok [x](./b.md)\n\nbroken [y](./gone.md) and [z](gone2.md#h)\n',
    'docs/b.md': '# B\n',
  });
  const r = scan(root);
  assert.deepEqual(
    r.broken.map((b) => [b.file, b.line, b.dest]),
    [
      ['docs/a.md', 3, './gone.md'],
      ['docs/a.md', 3, 'gone2.md#h'],
    ],
  );
  assert.equal(report(r).failed, true);
  rmSync(root, { recursive: true });
});

test('fragments must name a heading of the target, deduped like GitHub', () => {
  const root = fixture({
    'docs/a.md': '# Top\n[x](b.md#setup-1) ok, [y](b.md#setup-3) and [z](#missing) bad\n',
    'docs/b.md': '# Setup\n## Setup\n## Other\n',
  });
  const r = scan(root);
  assert.deepEqual(
    r.broken.map((b) => b.dest),
    ['b.md#setup-3', '#missing'],
  );
  rmSync(root, { recursive: true });
});

test('links in fenced code, code spans, comments and front matter are skipped', () => {
  const root = fixture({
    'docs/a.md': [
      '---',
      'link: "[x](fm.md)"',
      '---',
      '```',
      '[a](fenced.md)',
      '```',
      '`[b](span.md)` and `` ` [c](double.md) ` `` stand.',
      '<!-- [d](commented.md) -->',
      'An unmatched ` run stays literal: [e](real.md).',
    ].join('\n'),
    'docs/real.md': '# R\n',
  });
  const r = scan(root);
  assert.deepEqual(r.broken, []);
  assert.equal(r.checked, 1);
  rmSync(root, { recursive: true });
});

test('external links, `[t](a b)` and non-link brackets are not checked', () => {
  const root = fixture({
    'docs/a.md': [
      '[w](https://x.dev/y) [m](mailto:me@x.org) [t](tel:1) [p](//cdn/x)',
      '`[t](a b)` reads as written, and so does [t](a b) itself.',
      'A stray ](bracket) pair and [unclosed]( are not links.',
    ].join('\n'),
  });
  const r = scan(root);
  assert.deepEqual(r.broken, []);
  assert.equal(r.checked, 4); // the four external scheme links only
  rmSync(root, { recursive: true });
});

test('reference definitions are checked, footnote definitions are not', () => {
  const root = fixture({
    'docs/a.md': '[x]: ./missing.md "t"\n[^1]: ./footnote.md\nSee [x] and [^1].\n',
  });
  const r = scan(root);
  assert.deepEqual(
    r.broken.map((b) => b.dest),
    ['./missing.md'],
  );
  rmSync(root, { recursive: true });
});

test('empty destinations and folder anchors are flagged', () => {
  const root = fixture({
    'docs/a.md': '[e]() [f](dir/#top) [g](dir/#readme)\n',
    'docs/dir/README.md': '# D\n',
  });
  const r = scan(root);
  assert.deepEqual(
    r.broken.map((b) => [b.dest, b.reason]),
    [
      ['', 'empty destination'],
      ['dir/#top', 'a folder page has no #top anchor'],
    ],
  );
  rmSync(root, { recursive: true });
});

test('headings in blockquotes, lists and setext give anchors', () => {
  const src = '> # Quoted\n\n- # Listed\n\nSetext Title\n============\n\npara\n\n---\n';
  const slugs = headingSlugs(src);
  assert.ok(slugs.has('quoted'));
  assert.ok(slugs.has('listed'));
  assert.ok(slugs.has('setext-title'));
  assert.ok(!slugs.has('para')); // `---` after a blank line is a break
});

test('slug() matches github-slugger on the docs headings', () => {
  const cases = [
    ["What's not supported yet", 'whats-not-supported-yet'],
    ['Front matter in `export_metadata`', 'front-matter-in-export_metadata'],
    ['One-click (recommended)', 'one-click-recommended'],
    ['Embeds & transclusion', 'embeds--transclusion'],
    ['The `mdopener://` URL scheme', 'the-mdopener-url-scheme'],
  ];
  for (const [text, want] of cases) assert.equal(slug(headingTextOf(text)), want);
});

// headingText is module-private; headings exercise it via headingSlugs. For the
// table above, feed each through headingSlugs and read the only slug.
function headingTextOf(text) {
  const slugs = [...headingSlugs(`# ${text}\n`)];
  assert.equal(slugs.length, 1);
  return slugs[0];
}

test('a title after the destination, and a <dest with spaces>, are read', () => {
  const links = linkTargets('[a](x.md "a title") [b](<dir/my file.md>) [c](y.md#f)\n');
  assert.deepEqual(
    links.map((l) => l.dest),
    ['x.md', 'dir/my file.md', 'y.md#f'],
  );
});

test('generated dependency, build and fixture directories are not scanned', () => {
  const root = fixture({
    'README.md': '# R\n[ok](./docs/a.md)\n',
    'docs/a.md': '# A\n',
    'node_modules/pkg/README.md': '[x](./gone.md)\n',
    'target/doc/README.md': '[x](./gone.md)\n',
    'dist/assets/README.md': '[x](./gone.md)\n',
    '__fixtures__/case/README.md': '[x](./gone.md)\n',
    '.hidden/docs.md': '[x](./gone.md)\n',
  });
  const r = scan(root, { dirs: ['.'] });
  assert.deepEqual(r.broken, []);
  assert.equal(r.files, 2); // README.md and docs/a.md only
  rmSync(root, { recursive: true });
});

test('remote http(s) targets are collected once, at their first sighting', () => {
  const root = fixture({
    'docs/a.md': [
      '[a](https://x.dev/1) and [b](https://y.dev) then [c](https://x.dev/1) again.',
      '[d](mailto:me@x.org) [e](ssh://h) [f](./b.md)',
    ].join('\n'),
    'docs/b.md': '# B\n[z](https://x.dev/1) too.\n',
  });
  const r = scan(root);
  assert.deepEqual(
    r.external,
    [
      { url: 'https://x.dev/1', file: 'docs/a.md', line: 1 },
      { url: 'https://y.dev', file: 'docs/a.md', line: 1 },
    ],
  );
  rmSync(root, { recursive: true });
});

test('checkExternal probes HEAD first and falls back to GET', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/gone') return res.writeHead(404).end();
    if (req.url === '/head-refused' && req.method === 'HEAD') return res.writeHead(405).end();
    res.writeHead(200).end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const failed = await checkExternal([
    { url: `${base}/ok`, file: 'f.md', line: 1 },
    { url: `${base}/gone`, file: 'f.md', line: 2 },
    { url: `${base}/head-refused`, file: 'f.md', line: 3 },
  ]);
  assert.deepEqual(
    failed.map((f) => [f.url, f.reason]),
    [[`${base}/gone`, 'HTTP 404']],
  );
});

test('main() scans the whole repository by default and reports broken links', async () => {
  const root = fixture({
    'README.md': '# R\n[x](./gone.md)\n',
    'docs/a.md': '# A\n',
  });
  assert.equal(await main(root), 1);
  rmSync(root, { recursive: true });
});

test('every relative link in this repository resolves', () => {
  const { broken } = scan(REPO_ROOT, { dirs: ['.'] });
  assert.deepEqual(broken, []);
});

test('the README documents how Ashlr MD plugs into Phantom', () => {
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('## How Ashlr MD plugs into Phantom'));
  for (const target of [
    './docs/PHANTOM.md',
    './docs/PHANTOM.md#mdopen-exit-status',
    'https://github.com/ashlrai/phantom',
    'https://github.com/ashlrai/phantom-secrets',
    'https://phm.dev',
    '#how-ashlr-md-plugs-into-phantom',
  ]) {
    assert.ok(
      readme.includes(`](${target})`),
      `README.md should link to ${target}`,
    );
  }
  for (const text of [
    'phm inbox show',
    'mdopener-mcp',
    'mdopener://',
    'phantom exec',
    'phm_',
    'ASHLR_MD_ANTHROPIC_KEY_FROM_ENV',
  ]) {
    assert.ok(readme.includes(text), `README.md Phantom coverage should mention ${text}`);
  }
});

test('checkExternal handles rejected body cancellation and retries GET', async (t) => {
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (_url, { method }) => {
    methods.push(method);
    return {
      status: 200,
      body: { cancel: async () => { throw new Error('cancel failed'); } },
    };
  });
  const target = { url: 'https://example.com', file: 'f.md', line: 1 };
  assert.deepEqual(await checkExternal([target]), [{ ...target, reason: 'cancel failed' }]);
  assert.deepEqual(methods, ['HEAD', 'GET']);
});

test('CLI reports scan errors with a failing exit status', (t) => {
  const root = fixture({ 'docs/a.md': '# A\n' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(join(root, 'missing.md'), join(root, 'docs/dangling.md'));
  const result = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/check-doc-links.mjs'), root], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
  assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|at async/);
});

test('document paths use stable code-unit order across mixed case and numbers', (t) => {
  const names = ['z.md', 'a2.md', 'a10.md', 'A.md'];
  const root = fixture(Object.fromEntries(names.map((name) => [`docs/${name}`, '# Title\n'])));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(docFiles(root, ['docs']), ['A.md', 'a10.md', 'a2.md', 'z.md'].map((name) => join(root, 'docs', name)));
});
