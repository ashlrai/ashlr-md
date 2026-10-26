import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headingSlugs, linkTargets, report, scan, slug } from './check-doc-links.mjs';

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
