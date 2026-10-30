// Deterministic merge-conflict resolver for high-churn generated files.
//
// Usage: node scripts/resolve-conflicts.mjs [--dry-run]
//
// Run inside the repo while a `git rebase` or `git merge` is stopped on
// conflicts. Written for the lane flow `git rebase main`, where the index
// stages mean: :2: = ours = main's version, :3: = theirs = the PR commit
// being replayed, :1: = merge base. During a plain `git merge` ours is the
// current branch instead; the rules below are symmetric.
//
//   CHANGELOG.md           union-merge both sides (same as merge=union in
//                          .gitattributes; GitHub's server merge ignores the
//                          driver, so this keeps lane-side merges honest too)
//   CLAUDE.md, README.md   take ours (main) and re-apply theirs' hunks on
//                          top; a hunk whose preimage no longer matches
//                          keeps main's version for that region. Always
//                          resolves — never left conflicted.
//   bun.lock, bun.lockb    take ours, re-run `bun install` — never hand-merged.
//                          package.json must come out byte-identical and any
//                          resolved URLs must stay on registry.npmjs.org
//   Cargo.lock             take ours, re-run `cargo metadata` — never
//                          hand-merged. Cargo.toml must come out
//                          byte-identical and package sources must stay on
//                          crates.io
//
// Anything else is left for a human. Resolved paths are staged (`git add`).
// Exit 0 when nothing remains unmerged, 1 otherwise.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const NPM_REGISTRY = 'registry.npmjs.org';
const CRATES_SOURCES = new Set([
  'registry+https://github.com/rust-lang/crates.io-index',
  'sparse+https://index.crates.io/',
]);

const dryRun = process.argv.includes('--dry-run');

function run(cmd, args, { cwd, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, input });
  const text = (b) => (b == null ? '' : Buffer.from(b).toString('utf8'));
  return { status: r.status ?? 1, stdout: text(r.stdout), stderr: text(r.stderr) };
}

function git(args, opts) {
  return run('git', args, opts);
}

function stageBuf(root, path, n) {
  const r = spawnSync('git', ['show', `:${n}:${path}`], { cwd: root });
  return r.status === 0 ? r.stdout : null;
}

function unmerged(root) {
  const r = git(['diff', '--name-only', '-z', '--diff-filter=U'], { cwd: root });
  if (r.status !== 0) throw new Error(`git diff --diff-filter=U failed: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean);
}

function withStages(root, path, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-conflicts-'));
  try {
    const files = {};
    for (const [name, n] of [['ours', 2], ['base', 1], ['theirs', 3]]) {
      const f = join(dir, name);
      const buf = stageBuf(root, path, n);
      writeFileSync(f, buf ?? '');
      files[name] = f;
    }
    return fn(files);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mergeFile(files, extra = []) {
  return git([
    'merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs',
    ...extra, files.ours, files.base, files.theirs,
  ]);
}

function finish(root, path, content) {
  if (!dryRun) {
    writeFileSync(join(root, path), content);
    const r = git(['add', '--', path], { cwd: root });
    if (r.status !== 0) return `staged-failed: ${r.stderr.trim()}`;
  }
  return null;
}

// CHANGELOG.md: union — keep both sides of every conflicting hunk.
function resolveUnion(root, path) {
  return withStages(root, path, (files) => {
    const r = mergeFile(files, ['--union']);
    if (r.status !== 0) return `union merge-file failed: ${r.stderr.trim()}`;
    return finish(root, path, r.stdout) ?? 'union';
  });
}

// Parse a unified diff into hunks: pre is the preimage (context + removed
// lines), post the replacement (context + added lines), start the 1-based
// preimage position recorded in the @@ header.
function parseHunks(patchText) {
  const hunks = [];
  let cur = null;
  for (const line of patchText.split('\n')) {
    if (/^(diff |index |--- |\+\+\+ )/.test(line)) continue;
    const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (m) {
      cur = { start: +m[1], pre: [], post: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur || line.startsWith('\\')) continue;
    if (line.startsWith('-')) cur.pre.push(line.slice(1));
    else if (line.startsWith('+')) cur.post.push(line.slice(1));
    else {
      cur.pre.push(line.slice(1));
      cur.post.push(line.slice(1));
    }
  }
  return hunks;
}

// Re-apply each hunk of the PR's patch onto ours: find where the hunk's
// preimage still appears verbatim in ours (nearest its recorded position)
// and splice in the postimage. Hunks whose preimage no longer exists are
// skipped — main's version stands for that region.
export function reapplyHunks(oursText, patchText) {
  const ours = oursText.split('\n');
  let offset = 0;
  let applied = 0;
  let skipped = 0;
  for (const h of parseHunks(patchText)) {
    if (h.pre.length === 0) {
      ours.splice(Math.min(h.start - 1 + offset, ours.length), 0, ...h.post);
      offset += h.post.length;
      applied++;
      continue;
    }
    const want = h.start - 1 + offset;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i + h.pre.length <= ours.length; i++) {
      let ok = true;
      for (let j = 0; j < h.pre.length; j++)
        if (ours[i + j] !== h.pre[j]) {
          ok = false;
          break;
        }
      if (!ok) continue;
      const d = Math.abs(i - want);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best === -1) {
      skipped++;
      continue;
    }
    ours.splice(best, h.pre.length, ...h.post);
    offset += h.post.length - h.pre.length;
    applied++;
  }
  return { text: ours.join('\n'), applied, skipped };
}

// CLAUDE.md / README.md: take ours, re-apply theirs' hunks. Try git apply
// first (strict context match); when a hunk's recorded position shifted —
// e.g. both sides appended at EOF — re-apply hunk-by-hunk and keep main's
// version for any hunk whose preimage is gone.
function resolveDoc(root, path) {
  const ours = stageBuf(root, path, 2);
  if (ours === null) return 'ours side deleted — needs a human';
  const patch = git(['diff', ':1:' + path, ':3:' + path], { cwd: root });
  if (patch.status !== 0) return `patch build failed: ${patch.stderr.trim()}`;
  if (dryRun) return 'would take ours + re-apply PR hunks';
  writeFileSync(join(root, path), ours);
  if (patch.stdout === '') return finish(root, path, ours) ?? 'ours (no PR hunk)';
  const applied = git(['apply', '--whitespace=nowarn'], { cwd: root, input: patch.stdout });
  if (applied.status === 0)
    return finish(root, path, readFileSync(join(root, path))) ?? 'ours + PR hunks (applied)';
  const r = reapplyHunks(ours.toString('utf8'), patch.stdout);
  const label =
    r.skipped === 0
      ? `main's version + PR hunks (${r.applied} re-applied)`
      : `main's version + ${r.applied}/${r.applied + r.skipped} PR hunks re-applied`;
  return finish(root, path, r.text) ?? label;
}

// Lockfiles: never hand-merged. Take ours, then let the package manager
// reconcile against the (already resolved) manifest; verify the manifest
// stayed byte-identical and no non-registry source slipped in.
function lockfileFlow(root, path, manifestName, verifyCmd, regenCmd, sourcesOk) {
  const dir = dirname(path);
  const manifest = dir === '.' ? manifestName : `${dir}/${manifestName}`;
  const manifestPath = join(root, manifest);
  if (unmerged(root).includes(manifest)) return `resolve ${manifest} first`;
  const before = existsSync(manifestPath) ? readFileSync(manifestPath) : null;
  const ours = stageBuf(root, path, 2);
  if (ours === null) return 'ours side deleted — needs a human';
  if (dryRun) return `would regen via ${regenCmd.join(' ')}`;
  writeFileSync(join(root, path), ours);
  const cwd = join(root, dir);
  let r = run(verifyCmd[0], verifyCmd.slice(1), { cwd });
  if (r.status !== 0) {
    r = run(regenCmd[0], regenCmd.slice(1), { cwd });
    if (r.status === 0) r = run(verifyCmd[0], verifyCmd.slice(1), { cwd });
  }
  const fail = (why) => {
    writeFileSync(join(root, path), ours);
    return `${why} — needs a human`;
  };
  if (r.status !== 0) return fail(`${regenCmd[0]} regen failed`);
  const after = existsSync(manifestPath) ? readFileSync(manifestPath) : null;
  if (Buffer.compare(before ?? Buffer.alloc(0), after ?? Buffer.alloc(0)) !== 0)
    return fail(`${manifestName} changed during regen`);
  const bad = sourcesOk(readFileSync(join(root, path), 'utf8'));
  if (bad) return fail(bad);
  const add = git(['add', '--', path], { cwd: root });
  return add.status === 0 ? 'regenerated with package manager' : `staged-failed: ${add.stderr.trim()}`;
}

function bunSourcesOk(text) {
  for (const m of text.matchAll(/https?:\/\/[^\s"')\]]+/g)) {
    try {
      if (new URL(m[0]).host !== NPM_REGISTRY) return `non-registry URL ${m[0]}`;
    } catch {
      return `unparseable URL ${m[0]}`;
    }
  }
  return null;
}

function cargoSourcesOk(text) {
  for (const m of text.matchAll(/^source = "([^"]+)"/gm)) {
    if (!CRATES_SOURCES.has(m[1])) return `non-crates.io source ${m[1]}`;
  }
  return null;
}

function classify(path) {
  const base = basename(path);
  if (base === 'CHANGELOG.md') return resolveUnion;
  if (base === 'CLAUDE.md' || base === 'README.md') return resolveDoc;
  if (base === 'bun.lock' || base === 'bun.lockb')
    return (root, p) =>
      lockfileFlow(
        root,
        p,
        'package.json',
        ['bun', 'install', '--frozen-lockfile'],
        ['bun', 'install'],
        bunSourcesOk,
      );
  if (base === 'Cargo.lock')
    return (root, p) =>
      lockfileFlow(
        root,
        p,
        'Cargo.toml',
        ['cargo', 'metadata', '--locked', '--format-version', '1', '--quiet'],
        ['cargo', 'metadata', '--format-version', '1', '--quiet'],
        cargoSourcesOk,
      );
  return null;
}

export function cli() {
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    console.error(`not inside a git worktree: ${top.stderr.trim()}`);
    return 1;
  }
  const root = top.stdout.trim();
  const paths = unmerged(root);
  if (paths.length === 0) {
    console.log('no unmerged paths');
    return 0;
  }
  let bad = 0;
  for (const path of paths) {
    const fn = classify(path);
    if (!fn) {
      console.log(`skipped    ${path} (no conflict driver)`);
      bad++;
      continue;
    }
    const outcome = fn(root, path);
    if (outcome.includes('needs a human') || outcome.includes('failed') || outcome.endsWith('first')) {
      console.log(`unresolved ${path} (${outcome})`);
      bad++;
    } else {
      console.log(`${dryRun ? 'would resolve' : 'resolved'}   ${path} (${outcome})`);
    }
  }
  if (bad) console.log(`${bad} path(s) still need a human — finish them, then re-run or continue`);
  return bad ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(cli());
