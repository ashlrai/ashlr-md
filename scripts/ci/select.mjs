#!/usr/bin/env node
// Affected-scope selector for the CI Linux shards. Emits GITHUB_OUTPUT-style
// key=value lines: mode, js, js_base, rust, rust_args. The ci.yml `select` job
// appends stdout to $GITHUB_OUTPUT; the `linux-shard` matrix consumes it.
//
// Fail-open to the full suite, never to an empty one: any event that is not a
// pull_request, any .github/** change, an empty or unavailable diff and any
// selection error all select everything (merge_group and the daily run always
// get the same test count as before). Path classification mirrors the rules
// scripts/ci-local.sh used to inline; keep ci-local.sh calling this script so
// the two never drift.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Workspace members of src-tauri/Cargo.toml, in declaration order.
export const CRATES = ['md-opener', 'mdopen', 'mdopener-mcp'];
// Workspace-level cargo inputs: touching either can change every crate's build.
const SHARED_RUST = new Set(['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']);

// Paths that never need the Rust shards (ported verbatim from ci-local.sh).
const NOT_RUST = /^(src\/|landing\/|samples\/|integrations\/|index\.html$|biome\.json$|vite\.config\.ts$|vitest\.config\.ts$|tsconfig(\.node)?\.json$|package\.json$|bun\.lockb?$|[^/]*\.md$|docs\/)/;
// Paths that need the JS shard (also verbatim; .github/ forces full anyway).
const JS_IN = /^(src\/|index\.html$|biome\.json$|vite\.config\.ts$|vitest\.config\.ts$|tsconfig(\.node)?\.json$|package\.json$|bun\.lockb?$|\.github\/workflows\/|scripts\/)/;

const FULL = { mode: 'full', js: true, rust: true, rustArgs: '--workspace' };

// files: changed paths relative to the repo root, or null when the diff could
// not be computed. Returns the shard plan; rustArgs is a ready-made cargo
// package selector ('--workspace' or '-p <crate> ...'). An explicitly empty
// list means "nothing to test" — every shard is selected off.
export function plan(event, files) {
  if (event !== 'pull_request' || !files) return { ...FULL };
  if (files.some((f) => f === '.github' || f.startsWith('.github/'))) return { ...FULL };
  const crates = new Set();
  for (const f of files) {
    if (f !== 'docs/AGENTS.md' && NOT_RUST.test(f)) continue;
    if (SHARED_RUST.has(f) || !f.startsWith('src-tauri/')) {
      // Unknown or workspace-wide inputs: every crate may be affected.
      for (const c of CRATES) crates.add(c);
    } else {
      const bin = /^src-tauri\/bins\/([^/]+)\//.exec(f);
      crates.add(bin && CRATES.includes(bin[1]) ? bin[1] : 'md-opener');
    }
  }
  const rustArgs = crates.size === CRATES.length ? '--workspace' : [...crates].sort().map((c) => `-p ${c}`).join(' ');
  return { mode: 'affected', js: files.some((f) => JS_IN.test(f)), rust: crates.size > 0, rustArgs };
}

function changedFiles(base, head) {
  const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
  const mergeBase = git(['merge-base', base, head]).trim();
  const files = git(['diff', '--name-only', mergeBase, head]).split('\n').filter(Boolean);
  return { files, mergeBase };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
    else args[key] = true;
  }
  return args;
}

function emit({ mode, js, rust, rustArgs, jsBase = '' }) {
  process.stdout.write(`mode=${mode}\njs=${js}\njs_base=${js ? jsBase : ''}\nrust=${rust}\nrust_args=${rustArgs}\n`);
}

export function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const args = parseArgs(argv);
    const event = args.event ?? env.CI_EVENT ?? '';
    let files = null;
    let mergeBase = '';
    if (args.filesFile) {
      // Escape hatch for ci-local.sh and tests: newline-separated paths.
      const raw = args.filesFile === '-' ? readFileSync(0, 'utf8') : readFileSync(args.filesFile, 'utf8');
      files = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    } else if (event === 'pull_request') {
      const base = args.base ?? env.CI_BASE;
      const head = args.head ?? env.CI_HEAD;
      if (base && head) ({ files, mergeBase } = changedFiles(base, head));
      // A real pull_request always has a non-empty diff; an empty one means the
      // shas or clone were not what we expected — treat as a selection error.
      if (files && files.length === 0) files = null;
    }
    const p = plan(event, files);
    emit({ ...p, jsBase: mergeBase });
    process.stderr.write(`select: mode=${p.mode} js=${p.js} rust=${p.rust} rust_args=${p.rustArgs} files=${files?.length ?? 'n/a'}\n`);
    return 0;
  } catch (err) {
    // Selection errors fall back to the full suite and never fail the job.
    process.stderr.write(`select: error, falling back to full suite: ${err.message}\n`);
    emit({ ...FULL });
    return 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
