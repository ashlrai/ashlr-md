import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  ROOT,
  checkClaim,
  checkClaims,
  codeLines,
  declaredClaims,
  parseClaim,
  pathClaims,
  pathStatus,
  plainHeading,
  regenerate,
  renderBlock,
  rootDirs,
  sections,
  sectionAt,
  syncBlocks,
  watchedFiles,
} from './doclive.mjs';

// ── codeLines / sections ─────────────────────────────────────────────────────

test('codeLines tracks fences, info strings and CRLF', () => {
  const src = 'prose\n```ts\ncode\n```\r\nafter\n~~~\n~inside\n~~~\nend\n';
  const states = [...codeLines(src)].map((l) => l.fence);
  assert.deepEqual(states, [false, 'open', 'code', 'close', false, 'open', 'code', 'close', false, false]);
  // A ``` info string containing a backtick is not a fence.
  const notFence = [...codeLines('a\n``` `x`\nb\n')].map((l) => l.fence);
  assert.deepEqual(notFence, [false, false, false, false]);
  // Fences behind blockquote markers still count.
  const quoted = [...codeLines('> ```\n> x\n> ```\n')].map((l) => l.fence);
  assert.deepEqual(quoted, ['open', 'code', 'close', false]);
});

test('sections builds the heading path and preamble', () => {
  const src = 'intro\n# A\nbody\n## B\nmore\n# C\nlast\n';
  const secs = sections(src);
  assert.deepEqual(secs.map((s) => s.path), ['(top)', 'A', 'A > B', 'C']);
  assert.equal(sectionAt(secs, 2).path, 'A');
  assert.equal(sectionAt(secs, 4).path, 'A > B');
  assert.equal(sectionAt(secs, 6).path, 'C');
  // Headings inside fences do not split sections.
  const fenced = sections('# A\n```\n# not a heading\n```\n## B\nx\n');
  assert.deepEqual(fenced.map((s) => s.path), ['A', 'A > B']);
  assert.equal(plainHeading('**Bold** `code` [link](x)'), 'Bold code link');
});

// ── declared claims ──────────────────────────────────────────────────────────

test('declaredClaims reads whole-line comments outside fences only', () => {
  const src = [
    '<!-- doclive: exists docs/a.md -->',
    'text <!-- doclive: exists docs/b.md --> tail',
    '```md',
    '<!-- doclive: exists docs/c.md -->',
    '```',
    '<!-- doclive: bogus probe -->',
    '',
  ].join('\n');
  const claims = declaredClaims(src);
  assert.deepEqual(claims.map((c) => c.spec), ['exists docs/a.md', 'bogus probe']);
  assert.deepEqual(claims.map((c) => c.line), [1, 6]);
});

test('parseClaim covers every probe and rejects malformed specs', () => {
  assert.deepEqual(parseClaim('exists docs/a.md'), { probe: 'exists', path: 'docs/a.md' });
  assert.deepEqual(parseClaim('symbol src/x.ts#FOO'), { probe: 'symbol', path: 'src/x.ts', symbol: 'FOO' });
  const contains = parseClaim('contains src/x.ts /foo bar/');
  assert.equal(contains.probe, 'contains');
  assert.equal(contains.codeRe.source, 'foo bar');
  assert.ok(contains.codeRe.flags.includes('g'));
  const seq = parseClaim('seq src/x.rs /a: "(\\w+)"/ vs /^- `(\\w+)`/');
  assert.equal(seq.probe, 'seq');
  assert.equal(seq.codeRe.source, 'a: "(\\w+)"');
  assert.equal(seq.docRe.source, '^- `(\\w+)`');
  const set = parseClaim('set src/x.json#items /"(\\w+)":/ vs /`(\\w+)`/');
  assert.equal(set.probe, 'set');
  assert.equal(set.symbol, 'items');
  for (const bad of [
    'exists', 'symbol src/x.ts', 'symbol src/x.ts#', 'symbol src/x.ts#9bad',
    'contains src/x.ts', 'contains src/x.ts notregex', 'contains src/x.ts /a/ extra',
    'seq src/x.ts /a/', 'seq src/x.ts /a/ vs', 'seq src/x.ts /a/ nope /b/',
    'bogus src/x.ts',
  ]) {
    assert.throws(() => parseClaim(bad), /doclive|claim|expected|unknown|unterminated|needs/i, bad);
  }
});

// ── path claims ──────────────────────────────────────────────────────────────

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'doclive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'docs/nested'), { recursive: true });
  await mkdir(resolve(root, 'src/mcp/handlers'), { recursive: true });
  await mkdir(resolve(root, 'src-tauri/target'), { recursive: true });
  await writeFile(resolve(root, 'docs/guide.md'), '# Guide\n\nSee `src/tool.rs`.\n');
  await writeFile(resolve(root, 'docs/nested/deep.md'), '# Deep\n');
  await writeFile(resolve(root, 'src/tool.rs'), 'fn tool_registry() {}\n');
  await writeFile(resolve(root, 'src/registry.rs'), 'name: "open_file",\nname: "get_current_content",\n');
  return root;
}

test('pathStatus resolves doc-relative, root and cd bases; skips foreign shapes', async (t) => {
  const root = await fixture(t);
  const dirs = rootDirs(root);
  const bases = [root];
  assert.equal(pathStatus('docs/guide.md', { root, bases, dirs }), 'ok');
  assert.equal(pathStatus('docs/guide.md#frag', { root, bases, dirs }), 'ok');
  assert.equal(pathStatus('docs/NOPE.md', { root, bases, dirs }), 'missing');
  assert.equal(pathStatus('guide.md', { root, bases, dirs }), 'skip'); // no slash
  assert.equal(pathStatus('src/tool.rs', { root, bases, dirs }), 'ok');
  assert.equal(pathStatus('other/file.md', { root, bases, dirs }), 'skip'); // foreign tree
  assert.equal(pathStatus('sessions/x.md', { root, bases, dirs }), 'skip');
  assert.equal(pathStatus('https://example.com/a.md', { root, bases, dirs }), 'skip');
  assert.equal(pathStatus('/abs/path.md', { root, bases, dirs }), 'skip');
  assert.equal(pathStatus('docs/*.md', { root, bases, dirs }), 'skip');
  assert.equal(pathStatus('docs/STANDING-AUTHORITY.md', { root, bases, dirs }), 'skip'); // exempt
  assert.equal(pathStatus('./AshlrMD.AppImage', { root, bases, dirs }), 'skip'); // artifact
  assert.equal(pathStatus('src-tauri/target/release/x', { root, bases, dirs }), 'skip'); // build
});

test('pathClaims honors cd inside shell fences and resets per fence', async (t) => {
  const root = await fixture(t);
  const src = [
    '# D',
    '```bash',
    'cd docs',
    'cat ./nested/deep.md',   // cwd=docs → docs/nested/deep.md exists
    'cat ../src/tool.rs',     // cwd=docs → src/tool.rs exists
    '```',
    '```ts',
    'cd docs',                // not a shell fence: cd is not tracked
    'cat ./nested/deep.md',   // resolves vs doc dir/root → root/nested/deep.md missing
    'cat docs/nested/deep.md',// root-relative → ok
    '```',
    '`docs/guide.md` inline',
    '',
  ].join('\n');
  const claims = pathClaims(src, 'README.md', root);
  const pick = (token, status) => claims.filter((c) => c.token === token && c.status === status);
  assert.equal(pick('./nested/deep.md', 'ok').length, 1);   // bash fence, after cd
  assert.equal(pick('./nested/deep.md', 'missing').length, 1); // ts fence, no cd
  assert.equal(pick('../src/tool.rs', 'ok').length, 1);
  assert.equal(pick('docs/nested/deep.md', 'ok').length, 1);
  assert.equal(pick('docs/guide.md', 'ok').length, 1);
});

// ── checkClaim / checkClaims ─────────────────────────────────────────────────

test('checkClaim evaluates exists, symbol, contains, seq and set', async (t) => {
  const root = await fixture(t);
  const doc = [
    '# Tools',
    '',
    '1. `open_file`',
    '2. `get_current_content`',
    '',
    '<!-- doclive: exists docs/guide.md -->',
    '<!-- doclive: symbol src/tool.rs#tool_registry -->',
    '<!-- doclive: contains src/tool.rs /fn tool_registry/ -->',
    '<!-- doclive: seq src/registry.rs /name: "([a-z_]+)",/ vs /^\\d+\\. `([a-z_]+)`/ -->',
    '<!-- doclive: set src/registry.rs /name: "([a-z_]+)",/ vs /`([a-z_]+)`/ -->',
    '',
  ].join('\n');
  await writeFile(resolve(root, 'README.md'), doc);
  const result = checkClaims(root);
  assert.equal(result.ok, true, JSON.stringify(result.problems, null, 2));
  assert.ok(result.claims > 0);

  // Stale: drop one tool from the doc list.
  const stale = doc.replace('2. `get_current_content`\n', '');
  await writeFile(resolve(root, 'README.md'), stale);
  const bad = checkClaims(root);
  assert.equal(bad.ok, false);
  const seqProblem = bad.problems.find((p) => p.claim.includes('doclive: seq'));
  assert.ok(seqProblem, 'expected a seq claim problem');
  assert.equal(seqProblem.section, 'Tools');
  assert.match(seqProblem.reason, /ordered lists differ/);
});

test('checkClaim reports missing paths, symbols and bad regex matches', async (t) => {
  const root = await fixture(t);
  const lines = ['# S', '', 'x'].join('\n').split('\n');
  const sec = sections('# S\nx\n')[0];
  const problems = (spec) => checkClaim(root, parseClaim(spec), sec, lines);
  assert.deepEqual(problems('exists docs/NOPE.md'), ['doclive:exists docs/NOPE.md: no such path docs/NOPE.md']);
  assert.match(problems('symbol src/tool.rs#missing_fn')[0], /not defined/);
  assert.match(problems('contains src/tool.rs /absent_thing/')[0], /does not match/);
  assert.throws(() => parseClaim('bogus-path claim'));
});

// ── regeneration ─────────────────────────────────────────────────────────────

test('regenerate rewrites blocks, preserves prose, is idempotent, keeps CRLF', () => {
  const render = (name) => (name === 'docs-index' ? '- [A](./a.md)' : 'TABLE');
  const src = 'before\n<!-- doclive:begin docs-index -->\nstale\n<!-- doclive:end -->\nafter\n';
  const out = regenerate(src, render, 'docs/README.md', { 'docs/README.md': 'docs-index' });
  assert.equal(out, 'before\n<!-- doclive:begin docs-index -->\n- [A](./a.md)\n<!-- doclive:end -->\nafter\n');
  assert.equal(regenerate(out, render, 'docs/README.md'), out);
  const crlf = regenerate(src.replaceAll('\n', '\r\n'), render, 'docs/README.md');
  assert.ok(crlf.includes('\r\n'));
  assert.equal(crlf.replaceAll('\r\n', '\n'), out);
});

test('regenerate rejects malformed, nested, unmatched and missing markers', () => {
  const render = (name) => {
    if (name !== 'docs-index') throw new Error(`unknown doclive block ${name}`);
    return 'X';
  };
  const req = { 'f.md': 'docs-index' };
  for (const [src, re] of [
    ['<!-- doclive:begin unknown -->\n<!-- doclive:end -->\n', /unknown doclive block/],
    ['<!-- doclive:beginfoo -->\n', /malformed doclive marker/],
    ['text <!-- doclive: exists a --> tail\n', /malformed doclive marker/],
    ['<!-- doclive:end -->\n', /unmatched doclive end/],
    ['<!-- doclive:begin docs-index -->\n', /unclosed doclive block/],
    ['<!-- doclive:begin docs-index -->\n<!-- doclive:begin docs-index -->\n<!-- doclive:end -->\n<!-- doclive:end -->\n', /nested doclive block/],
    ['no blocks here\n', /expected exactly one docs-index/],
  ]) {
    assert.throws(() => regenerate(src, render, 'f.md', req), re, src.slice(0, 40));
  }
  // Claim comments are legal lines, not malformed markers.
  const ok = regenerate('<!-- doclive: exists a.md -->\n<!-- doclive:begin docs-index -->\n<!-- doclive:end -->\n', render, 'f.md', req);
  assert.ok(ok.includes('doclive: exists a.md'));
});

test('regenerate ignores markers inside fenced code', () => {
  const render = () => 'GENERATED';
  const src = '```md\n<!-- doclive:begin docs-index -->\nexample\n<!-- doclive:end -->\n```\n';
  assert.equal(regenerate(src, render, 'f.md'), src);
});

// ── block renderers + syncBlocks ─────────────────────────────────────────────

test('renderDocsIndex lists docs markdown with first-heading titles, self excluded', async (t) => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'docs/README.md'), '# Docs home\n\n<!-- doclive:begin docs-index -->\n<!-- doclive:end -->\n');
  await writeFile(resolve(root, 'docs/plain.md'), 'no heading here\n');
  const out = renderBlock(root, 'docs-index', resolve(root, 'docs/README.md'));
  const lines = out.split('\n');
  assert.ok(lines.includes('- [Guide](./guide.md)'));
  assert.ok(lines.includes('- [Deep](./nested/deep.md)'));
  assert.ok(lines.includes('- [plain](./plain.md)'));
  assert.ok(!lines.some((l) => l.includes('README.md)')), 'self excluded');
});

test('renderMcpEvents follows bridge wiring order then handler listen order', async (t) => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'src/mcp/bridge.ts'), [
    'import { handleB } from "./handlers/b";',
    'import { handleA1, handleA2 } from "./handlers/a";',
    'unlisteners.push(handleB());',
    'unlisteners.push(handleA1());',
    'unlisteners.push(handleA2());',
    '',
  ].join('\n'));
  await writeFile(resolve(root, 'src/mcp/handlers/a.ts'), 'listen<X>("mcp://a1", f);\nlisten<Y>("mcp://a2", g);\n');
  await writeFile(resolve(root, 'src/mcp/handlers/b.ts'), 'listen<Z>("mcp://b", h);\n');
  const out = renderBlock(root, 'mcp-events', resolve(root, 'docs/AGENTS.md'));
  assert.equal(out, [
    '| Event | Handler module |',
    '|---|---|',
    '| `mcp://b` | `b.ts` |',
    '| `mcp://a1` | `a.ts` |',
    '| `mcp://a2` | `a.ts` |',
  ].join('\n'));
});

test('syncBlocks rewrites drifted blocks and reports marker problems', async (t) => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'docs/README.md'), '# Docs\n\n<!-- doclive:begin docs-index -->\nstale\n<!-- doclive:end -->\n');
  const dry = syncBlocks(root, { write: false });
  assert.deepEqual(dry.changed, ['docs/README.md']);
  assert.equal(dry.ok, true);
  // Dry run changed nothing on disk.
  assert.ok((await readFile(resolve(root, 'docs/README.md'), 'utf8')).includes('stale'));
  const wet = syncBlocks(root);
  assert.deepEqual(wet.changed, ['docs/README.md']);
  const after = await readFile(resolve(root, 'docs/README.md'), 'utf8');
  assert.ok(after.includes('- [Guide](./guide.md)'));
  assert.ok(!after.includes('stale'));
  assert.deepEqual(syncBlocks(root).changed, [], 'idempotent');

  await writeFile(resolve(root, 'docs/bad.md'), '# Bad\n\n<!-- doclive:end -->\n');
  const problems = syncBlocks(root, { write: false });
  assert.equal(problems.ok, false);
  assert.equal(problems.problems[0].file, 'docs/bad.md');
});

test('watchedFiles covers WATCHED roots and markdown only', async (t) => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'llms.txt'), '# llms\n');
  await writeFile(resolve(root, 'docs/notes.txt'), 'not markdown\n');
  const files = watchedFiles(root).map((f) => f.slice(root.length + 1));
  assert.ok(files.includes('docs/guide.md'));
  assert.ok(files.includes('docs/nested/deep.md'));
  assert.ok(files.includes('llms.txt'));
  assert.ok(!files.some((f) => f.endsWith('.txt') && f.startsWith('docs/')));
});

// ── real repository smoke ────────────────────────────────────────────────────

test('the real repo is clean: claims pass and generated blocks are fresh', () => {
  const claims = checkClaims(ROOT);
  assert.equal(claims.ok, true, JSON.stringify(claims.problems.slice(0, 10), null, 2));
  const blocks = syncBlocks(ROOT, { write: false });
  assert.deepEqual(blocks.changed, [], `drift: ${blocks.changed.join(', ')}`);
  assert.equal(blocks.ok, true);
});
