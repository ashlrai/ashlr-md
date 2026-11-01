import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Examples, installed/runtime files, and paths belonging to Phantom, not this tree.
const examples = new Set(['PLAN.md', 'notes.md', 'file.md', 'image.png', 'docs/LOCAL-INFERENCE.md',
  '.obsidian/', 'feat/ashlr-md-opener', 'sessions/', 'reviews/', '<file>.json', '<file>.bak-<UTC stamp>']);
const external = /^(?:~\/|\/|%LOCALAPPDATA%|https?:|mdopener:)/;
const commands = /\b(?:bun|npm|pnpm|yarn|node|python3|bash|cargo|cd|claude|codex|mdopen|mdopener-mcp|phantom|phm|ollama|omlx|chmod|xcode-select)\b(?:[ \t]+[^\n`;&|]+)?/g;

// Inventory rather than execute documentation. Never probe user configuration or binaries.
export function checkReadme(root, markdown = readFileSync(resolve(root, 'README.md'), 'utf8')) {
  const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {};
  const entries = [];
  const errors = [];
  let cwd = root;
  let fenced = false;
  for (const [index, line] of markdown.split('\n').entries()) {
    if (/^```/.test(line)) { fenced = !fenced; cwd = root; continue; }
    const spans = fenced ? [line.replace(/\s+#.*$/, '')] : [...line.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    for (const span of spans) {
      for (const match of span.matchAll(commands)) {
        const command = match[0].trim();
        entries.push({ line: index + 1, kind: 'command', value: command });
      }
      for (const match of span.matchAll(/\b(?:bun|npm|pnpm|yarn)\s+run\s+([\w:.-]+)/g)) {
        const value = match[1];
        entries.push({ line: index + 1, kind: 'script', value });
        if (!Object.hasOwn(scripts, value)) errors.push(`README.md:${index + 1}: unknown package script ${value}`);
      }
      const cd = span.match(/^cd\s+([^\s]+)\s*(?:&&|$)/);
      if (cd) {
        entries.push({ line: index + 1, kind: 'path', value: cd[1] });
        cwd = resolve(cwd, cd[1]);
        if (!existsSync(cwd)) errors.push(`README.md:${index + 1}: missing repository path ${cd[1]}`);
      }
      // Quoted paths can contain spaces; ordinary tokens cover command arguments and inline paths.
      const tokens = external.test(span) ? [span] : [...span.matchAll(/"([^"]+)"|'([^']+)'|([^\s,;()|]+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
      for (let value of tokens) {
        value = value.replace(/[.:]$/, '');
        if (cd && value === cd[1]) continue;
        if ((external.test(value) && !value.includes('://')) || examples.has(value)) {
          entries.push({ line: index + 1, kind: 'example/runtime/other-repo', value });
          continue;
        }
        if (external.test(value) || value.includes('://') || value.startsWith('#') ||
            /[<>\[\]]/.test(value)) continue;
        if (!/^(?:\.?\.?\/|[\w.-]+\/).*|^[\w-]+\.(?:md|json|toml|mjs|py|sh)$/.test(value)) continue;
        const target = resolve(cwd, value);
        entries.push({ line: index + 1, kind: 'path', value });
        if (!existsSync(target)) errors.push(`README.md:${index + 1}: missing repository path ${value}`);
      }
    }
    // Markdown links and HTML image sources are rooted at README, including encoded names.
    for (const match of line.matchAll(/\]\(([^\s)]+)\)|\bsrc="([^"]+)"/g)) {
      const value = match[1] ?? match[2];
      if (external.test(value) || value.startsWith('#')) continue;
      const path = decodeURIComponent(value.split('#')[0]);
      entries.push({ line: index + 1, kind: 'path', value: path });
      if (!existsSync(resolve(root, path))) errors.push(`README.md:${index + 1}: missing repository path ${path}`);
    }
  }
  return { entries, errors: [...new Set(errors)] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { entries, errors } = checkReadme(root);
  console.log(`${entries.length} README command, script and repository-path entries checked; ${errors.length} unmatched.`);
  if (process.argv.includes('--list')) for (const entry of entries) console.log(`${entry.line}: ${entry.kind}: ${entry.value}`);
  for (const error of errors) console.error(error);
  process.exitCode = errors.length ? 1 : 0;
}
