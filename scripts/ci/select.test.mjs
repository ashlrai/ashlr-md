import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { plan, CRATES, main } from './select.mjs';

const SCRIPT = fileURLToPath(new URL('./select.mjs', import.meta.url));

const full = { mode: 'full', js: true, rust: true, rustArgs: '--workspace' };

test('every non-pull_request event selects the full suite', () => {
  for (const event of ['merge_group', 'schedule', 'workflow_dispatch', 'push', '']) {
    assert.deepEqual(plan(event, ['src/x.ts']), full, event);
  }
});

test('unavailable diff falls back to the full suite', () => {
  assert.deepEqual(plan('pull_request', null), full);
  assert.deepEqual(plan('pull_request', undefined), full);
});

test('explicitly empty file list selects nothing (ci-local clean tree)', () => {
  assert.deepEqual(plan('pull_request', []), { mode: 'affected', js: false, rust: false, rustArgs: '' });
});

test('any .github change selects the full suite', () => {
  for (const f of ['.github/workflows/ci.yml', '.github/tests/secret-shape/scrub.pl', '.github']) {
    assert.deepEqual(plan('pull_request', [f, 'src/x.ts']), full, f);
  }
});

test('js-only changes run only the js shard', () => {
  for (const files of [
    ['src/components/App.tsx'],
    ['src/mcp/handlers.test.ts'],
    ['index.html'],
    ['package.json'],
    ['bun.lock'],
    ['tsconfig.json', 'src/a.ts'],
    ['vitest.config.ts'],
    ['biome.json'],
  ]) {
    assert.deepEqual(plan('pull_request', files), { mode: 'affected', js: true, rust: false, rustArgs: '' }, JSON.stringify(files));
  }
});

test('docs, landing, samples and root markdown select nothing', () => {
  assert.deepEqual(
    plan('pull_request', ['docs/VISION.md', 'landing/index.html', 'samples/showcase.md', 'README.md', 'CHANGELOG.md']),
    { mode: 'affected', js: false, rust: false, rustArgs: '' },
  );
});

test('docs/AGENTS.md selects the whole rust workspace', () => {
  assert.deepEqual(plan('pull_request', ['docs/AGENTS.md']), { mode: 'affected', js: false, rust: true, rustArgs: '--workspace' });
});

test('per-crate rust selection maps changed paths to workspace packages', () => {
  const cases = [
    [['src-tauri/bins/mdopen/src/main.rs'], '-p mdopen'],
    [['src-tauri/bins/mdopener-mcp/tests/stdio.rs'], '-p mdopener-mcp'],
    [['src-tauri/src/lib.rs'], '-p md-opener'],
    [['src-tauri/tests/no_proxy.rs'], '-p md-opener'],
    [['src-tauri/tauri.conf.json'], '-p md-opener'],
    [['src-tauri/bins/mdopener-afm/src/main.rs'], '-p md-opener'], // non-member bin is bundled by the root package
    [['src-tauri/bins/mdopen/src/main.rs', 'src-tauri/bins/mdopener-mcp/src/main.rs'], '-p mdopen -p mdopener-mcp'],
    // Workspace-level inputs can affect every crate.
    [['src-tauri/Cargo.toml'], '--workspace'],
    [['src-tauri/Cargo.lock'], '--workspace'],
    [['src-tauri/bins/mdopen/src/main.rs', 'src-tauri/Cargo.lock'], '--workspace'],
  ];
  for (const [files, rustArgs] of cases) {
    assert.deepEqual(plan('pull_request', files), { mode: 'affected', js: false, rust: true, rustArgs }, JSON.stringify(files));
  }
});

test('unclassified paths select the whole rust workspace, not nothing', () => {
  for (const f of ['server.json', 'packaging/macos/entitlements.plist', 'scripts/build-sidecars.sh', 'renovate.json']) {
    const p = plan('pull_request', [f]);
    assert.equal(p.rust, true, f);
    assert.equal(p.rustArgs, '--workspace', f);
  }
  // scripts/ also feeds the JS shard, matching ci-local.sh's old rules.
  assert.equal(plan('pull_request', ['scripts/x.sh']).js, true);
});

test('mixed diffs combine js and rust scopes', () => {
  const p = plan('pull_request', ['src/a.ts', 'src-tauri/bins/mdopen/src/main.rs', 'docs/VISION.md']);
  assert.deepEqual(p, { mode: 'affected', js: true, rust: true, rustArgs: '-p mdopen' });
});

test('plan is deterministic and covers every workspace crate', () => {
  const all = ['src-tauri/src/lib.rs', 'src-tauri/bins/mdopen/src/main.rs', 'src-tauri/bins/mdopener-mcp/src/main.rs'];
  const a = plan('pull_request', all);
  const b = plan('pull_request', [...all].reverse());
  assert.deepEqual(a, b);
  assert.equal(a.rustArgs, '--workspace');
  // Sanity: the selector can only name real workspace members.
  for (const c of ['md-opener', 'mdopen', 'mdopener-mcp']) assert.ok(CRATES.includes(c), c);
});

function runSelect(args, { input } = {}) {
  return execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'] });
}

test('main emits GITHUB_OUTPUT lines from --files-file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-select-'));
  const list = join(dir, 'files.txt');
  writeFileSync(list, 'src/a.ts\nsrc-tauri/bins/mdopen/src/main.rs\n\n');
  const out = runSelect(['--event', 'pull_request', '--files-file', list]);
  assert.deepEqual(out.trim().split('\n').sort(), [
    'js=true',
    'js_base=',
    'mode=affected',
    'rust=true',
    'rust_args=-p mdopen',
  ]);
  rmSync(dir, { recursive: true });
});

test('stdin file list and unreadable inputs behave (error -> full, exit 0)', () => {
  const out = runSelect(['--event', 'pull_request', '--files-file', '-'], { input: 'docs/x.md\n' });
  assert.match(out, /mode=affected/);
  assert.match(out, /rust=false/);
  const missing = runSelect(['--event', 'pull_request', '--files-file', '/nonexistent/nope.txt']);
  assert.match(missing, /mode=full/);
});

test('missing base/head on pull_request falls back to full via plan', () => {
  // With no --files-file and no usable shas the script must not invoke git at
  // all: call main() directly so no repo is required.
  const writes = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => (writes.push(s), true);
  process.stderr.write = () => true;
  try {
    assert.equal(main(['--event', 'pull_request'], {}), 0);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  assert.match(writes.join(''), /mode=full/);
});
