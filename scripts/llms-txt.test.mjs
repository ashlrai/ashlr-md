// Checks the repo-root llms.txt (llmstxt.org shape) against the working tree:
// an H1 title first, one blockquote summary, H2 sections of `- [title](path): note`
// entries, and every relative link resolving to a file in the repo (with its
// #fragment naming a real heading when given). Link extraction and heading
// slugs come from check-doc-links.mjs so both checkers agree on what a link is.
// Run with `node --test scripts/llms-txt.test.mjs`, which `npm test` also runs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headingSlugs, linkTargets, maskCode } from './check-doc-links.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Structural and link problems in an llms.txt body, relative to `root`.
 * Returns human-readable strings; an empty array means the file conforms.
 */
export function llmsTxtProblems(src, root) {
  const problems = [];
  const lines = src.split('\n');
  const h1 = lines.findIndex((l) => l.trim() !== '');
  if (h1 < 0 || !/^# \S/.test(lines[h1])) problems.push('line 1 must be an H1 title ("# Name")');
  const quotes = lines.filter((l) => /^> \S/.test(l));
  if (quotes.length !== 1) problems.push(`expected exactly one one-line blockquote summary, found ${quotes.length}`);
  const sections = [];
  for (const [i, l] of lines.entries()) {
    if (/^## \S/.test(l)) sections.push({ title: l.slice(3), line: i + 1, entries: 0 });
    if (/^#{1,6} /.test(l) && !/^## /.test(l) && !/^# /.test(l)) {
      problems.push(`line ${i + 1}: only H1 and H2 headings are allowed`);
    }
  }
  if (sections.length === 0) problems.push('no H2 sections');
  let current = null;
  for (const [i, l] of lines.entries()) {
    if (/^## /.test(l)) current = sections.find((s) => s.line === i + 1);
    else if (/^- /.test(l) && current) {
      const m = /^- \[([^\]\n]+)\]\(([^)\s]+)\): (\S.*)$/.exec(l);
      if (!m) problems.push(`line ${i + 1}: entry must be "- [title](path): note"`);
      else current.entries++;
    }
  }
  for (const s of sections) {
    if (s.entries === 0) problems.push(`line ${s.line}: section "${s.title}" has no entries`);
  }

  for (const { dest, line } of linkTargets(src, maskCode(src))) {
    if (SCHEME.test(dest) || dest.startsWith('//')) {
      if (!/^https:\/\//.test(dest)) problems.push(`line ${line}: external link must be https: ${dest}`);
      continue;
    }
    const [pathPart, anchor] = dest.split('#', 2);
    if (pathPart === '' && anchor !== undefined) {
      problems.push(`line ${line}: same-file anchors are not allowed in llms.txt: ${dest}`);
      continue;
    }
    // A leading `/` means repo-root relative, as on GitHub.
    const abs = resolve(root, decode(pathPart).replace(/^\/+/, ''));
    const rel = relative(root, abs);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      problems.push(`line ${line}: link escapes the repository: ${dest}`);
      continue;
    }
    if (!existsSync(abs)) {
      problems.push(`line ${line}: missing target: ${dest}`);
      continue;
    }
    if (anchor !== undefined) {
      if (!statSync(abs).isFile() || !/\.(md|markdown)$/i.test(abs)) {
        problems.push(`line ${line}: anchor on a non-Markdown target: ${dest}`);
        continue;
      }
      const slugs = headingSlugs(readFileSync(abs, 'utf8'));
      if (!slugs.has(decode(anchor))) problems.push(`line ${line}: no heading "#${anchor}" in ${pathPart}`);
    }
  }
  return problems;
}

test('llms.txt in the repo root conforms and every relative link resolves', () => {
  const src = readFileSync(join(REPO_ROOT, 'llms.txt'), 'utf8');
  assert.deepEqual(llmsTxtProblems(src, REPO_ROOT), []);
});

test('llms.txt links the README and the main docs', () => {
  const src = readFileSync(join(REPO_ROOT, 'llms.txt'), 'utf8');
  const targets = linkTargets(src).map((l) => l.dest);
  assert.ok(targets.includes('README.md'));
  assert.ok(targets.length >= 10);
});

test('the checker flags a missing target, a bad anchor, and bad structure', () => {
  const root = mkdtempSync(join(tmpdir(), 'llmstxt-'));
  try {
    const files = {
      'docs/a.md': '# A\n\n## Real heading\n',
      'docs/b.md': 'no heading here\n',
    };
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    const good = [
      '# Fixture',
      '',
      '> Summary line.',
      '',
      '## Docs',
      '',
      '- [A](docs/a.md#real-heading): fine.',
      '- [B](docs/b.md): fine.',
      '',
    ].join('\n');
    assert.deepEqual(llmsTxtProblems(good, root), []);

    const bad = good
      .replace('docs/a.md#real-heading', 'docs/a.md#nope')
      .replace('- [B](docs/b.md): fine.', '- [B](docs/gone.md) fine.');
    const problems = llmsTxtProblems(bad, root);
    assert.equal(problems.length, 3, problems.join('\n'));
    assert.ok(problems.some((p) => /no heading "#nope"/.test(p)));
    assert.ok(problems.some((p) => /missing target: docs\/gone\.md/.test(p)));
    assert.ok(problems.some((p) => /entry must be/.test(p)));

    assert.ok(llmsTxtProblems('## No H1\n> s\n- [A](docs/a.md): x\n', root).some((p) => /H1/.test(p)));
    assert.ok(
      llmsTxtProblems('# T\n\n> s\n\n## S\n\n- [Up](../outside.md): x\n', root).some((p) => /escapes/.test(p)),
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});
