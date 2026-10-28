import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reapplyHunks } from './resolve-conflicts.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts', 'resolve-conflicts.mjs');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-conflicts-test-'));
  const home = mkdtempSync(join(tmpdir(), 'resolve-conflicts-home-'));
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_EDITOR: 'true',
  };
  const git = (args, opts = {}) =>
    spawnSync('git', args, { cwd: dir, env, encoding: 'utf8', ...opts });
  const must = (r, what) => {
    assert.equal(r.status, 0, `${what}: ${r.stderr || r.stdout}`);
    return r;
  };
  const write = (rel, body) => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  const read = (rel) => readFileSync(join(dir, rel), 'utf8');
  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  };
  return { dir, env, git, must, write, read, cleanup };
}

function initRepo(fx) {
  fx.must(fx.git(['init', '-b', 'main', '-q']), 'git init');
}

// Commit a base on main, then diverge: edits on main and on a `pr` branch.
function diverge(fx, mainEdit, prEdit) {
  fx.must(fx.git(['add', '-A']), 'stage base');
  fx.must(fx.git(['commit', '-qm', 'base']), 'commit base');
  fx.must(fx.git(['checkout', '-qb', 'pr']), 'branch pr');
  prEdit();
  fx.must(fx.git(['add', '-A']), 'stage pr');
  fx.must(fx.git(['commit', '-qm', 'pr']), 'commit pr');
  fx.must(fx.git(['checkout', '-q', 'main']), 'back to main');
  mainEdit();
  fx.must(fx.git(['add', '-A']), 'stage main');
  fx.must(fx.git(['commit', '-qm', 'main']), 'commit main');
  fx.must(fx.git(['checkout', '-q', 'pr']), 'back to pr');
}

const CHANGELOG_BASE = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0]\n- seed\n';

test('reapplyHunks lands applicable hunks and keeps ours where preimage is gone', () => {
  const ours = 'a\nb\nmain-c\nd\ne\nf\n';
  const patch = [
    'diff --git a/f.md b/f.md',
    'index 0000000..1111111 100644',
    '--- a/f.md',
    '+++ b/f.md',
    '@@ -1,4 +1,4 @@ a',
    ' b',
    '-c',
    '+pr-c',
    ' d',
    '@@ -4,3 +4,4 @@ d',
    ' e',
    ' f',
    '+pr-tail',
    '',
  ].join('\n');
  // hunk 1 preimage 'c' was rewritten by main → skipped; hunk 2 lands.
  const r = reapplyHunks(ours, patch);
  assert.deepEqual({ applied: r.applied, skipped: r.skipped }, { applied: 1, skipped: 1 });
  assert.equal(r.text, 'a\nb\nmain-c\nd\ne\nf\npr-tail\n');
});

test('.gitattributes scopes merge=union to CHANGELOG paths only', () => {
  const attr = readFileSync(join(REPO, '.gitattributes'), 'utf8');
  const lines = attr.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.ok(lines.length > 0, 'expected at least one attribute line');
  for (const line of lines)
    assert.match(line, /^CHANGELOG\.md\s+merge=union$/, `unexpected attribute: ${line}`);
});

test('rebase resolves a CHANGELOG.md conflict via merge=union, no helper needed', () => {
  const fx = fixture();
  try {
    initRepo(fx);
    copyFileSync(join(REPO, '.gitattributes'), join(fx.dir, '.gitattributes'));
    fx.write('CHANGELOG.md', CHANGELOG_BASE);
    fx.write('integrations/vscode/CHANGELOG.md', CHANGELOG_BASE);
    diverge(
      fx,
      () => {
        fx.write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- main entry\n\n## [0.1.0]\n- seed\n');
        fx.write('integrations/vscode/CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- main nested\n\n## [0.1.0]\n- seed\n');
      },
      () => {
        fx.write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- pr entry\n\n## [0.1.0]\n- seed\n');
        fx.write('integrations/vscode/CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- pr nested\n\n## [0.1.0]\n- seed\n');
      },
    );
    const rebase = fx.git(['rebase', 'main']);
    assert.equal(rebase.status, 0, `rebase should not stop: ${rebase.stdout}${rebase.stderr}`);
    const log = fx.git(['log', '--format=%s', '-3']);
    assert.deepEqual(log.stdout.trim().split('\n'), ['pr', 'main', 'base']);
    for (const rel of ['CHANGELOG.md', 'integrations/vscode/CHANGELOG.md']) {
      const body = fx.read(rel);
      assert.match(body, /- main (entry|nested)/, `${rel} lost main's hunk`);
      assert.match(body, /- pr (entry|nested)/, `${rel} lost the PR hunk`);
      assert.doesNotMatch(body, /^(<{7}|={7}|>{7})/m, `${rel} still has markers`);
      assert.equal(fx.git(['status', '--porcelain', '--', rel]).stdout, '');
    }
  } finally {
    fx.cleanup();
  }
});

test('helper resolves CHANGELOG union and docs via ours + re-applied PR hunks', () => {
  const fx = fixture();
  try {
    initRepo(fx);
    // No .gitattributes here: exercises the script's own union path.
    fx.write('CHANGELOG.md', CHANGELOG_BASE);
    fx.write('README.md', '# App\n\nintro\n\n## Usage\n\nrun it\n');
    fx.write('CLAUDE.md', '# Rules\n\nbe brief\n');
    diverge(
      fx,
      () => {
        fx.write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- main entry\n\n## [0.1.0]\n- seed\n');
        // main appends a section at EOF; the PR appends a different one.
        fx.write('README.md', '# App\n\nintro\n\n## Usage\n\nrun it\n\n## From main\n\nmain docs\n');
        fx.write('CLAUDE.md', '# Rules\n\nbe brief\n\n## From main\n\nmain rules\n');
      },
      () => {
        fx.write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- pr entry\n\n## [0.1.0]\n- seed\n');
        fx.write('README.md', '# App\n\nintro\n\n## Usage\n\nrun it\n\n## From the PR\n\npr docs\n');
        fx.write('CLAUDE.md', '# Rules\n\nbe brief\n\n## From the PR\n\npr rules\n');
      },
    );
    const rebase = fx.git(['rebase', 'main']);
    assert.notEqual(rebase.status, 0, 'rebase should stop without a union driver');
    assert.match(fx.git(['status', '--porcelain']).stdout, /UU README\.md|UU CHANGELOG\.md/);
    const help = spawnSync('node', [SCRIPT], { cwd: fx.dir, env: fx.env, encoding: 'utf8' });
    assert.equal(help.status, 0, `helper failed: ${help.stdout}${help.stderr}`);
    assert.match(help.stdout, /resolved\s+CHANGELOG\.md \(union\)/);
    fx.must(fx.git(['rebase', '--continue']), 'rebase --continue');
    const cl = fx.read('CHANGELOG.md');
    assert.match(cl, /- main entry/);
    assert.match(cl, /- pr entry/);
    for (const [rel, mainSec, prSec] of [
      ['README.md', '## From main', '## From the PR'],
      ['CLAUDE.md', '## From main', '## From the PR'],
    ]) {
      const body = fx.read(rel);
      assert.match(body, new RegExp(mainSec), `${rel} lost main's version`);
      assert.match(body, new RegExp(prSec), `${rel} lost the PR hunk`);
      assert.doesNotMatch(body, /^(<{7}|={7}|>{7})/m, `${rel} still has markers`);
    }
  } finally {
    fx.cleanup();
  }
});

test('conflicting doc hunks keep main version; unknown files stay for a human', () => {
  const fx = fixture();
  try {
    initRepo(fx);
    fx.write('README.md', '# App\n\nold tagline\n\n## Usage\n\nrun it\n');
    fx.write('src.ts', 'export const x = 1;\n');
    diverge(
      fx,
      () => {
        // both sides rewrite the same line differently → real conflict;
        // the PR hunk's preimage is gone, so main's version stands
        fx.write('README.md', '# App\n\nmain tagline\n\n## Usage\n\nrun it\n');
        fx.write('src.ts', 'export const x = 2;\n');
      },
      () => {
        fx.write('README.md', '# App\n\npr tagline\n\n## Usage\n\nrun it\n');
        fx.write('src.ts', 'export const x = 3;\n');
      },
    );
    assert.notEqual(fx.git(['rebase', 'main']).status, 0);
    const help = spawnSync('node', [SCRIPT], { cwd: fx.dir, env: fx.env, encoding: 'utf8' });
    assert.equal(help.status, 1, `expected src.ts left over: ${help.stdout}`);
    assert.match(help.stdout, /resolved\s+README\.md \(main's version \+ 0\/1 PR hunks/);
    assert.match(help.stdout, /skipped\s+src\.ts/);
    const body = fx.read('README.md');
    assert.match(body, /main tagline/, "main's version must stand");
    assert.doesNotMatch(body, /pr tagline/);
    assert.doesNotMatch(body, /^(<{7}|={7}|>{7})/m, 'no markers left behind');
    assert.doesNotMatch(fx.git(['status', '--porcelain']).stdout, /UU README\.md/);
    assert.match(fx.git(['status', '--porcelain']).stdout, /UU src\.ts/);
    fx.must(fx.git(['rebase', '--abort']), 'cleanup rebase');
  } finally {
    fx.cleanup();
  }
});

test('helper regenerates a conflicted bun.lock via bun, package.json untouched', () => {
  const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  if (bun.status !== 0) return; // no bun on this machine — CI has it
  const fx = fixture();
  try {
    initRepo(fx);
    fx.write('.gitignore', 'node_modules/\n');
    fx.write('vendor/lp/package.json', '{\n  "name": "lp",\n  "version": "1.0.0"\n}\n');
    fx.write(
      'package.json',
      '{\n  "name": "lockfix",\n  "version": "0.0.0",\n  "dependencies": {"lp": "file:vendor/lp"}\n}\n',
    );
    // Produce a real lockfile against a file: dep (offline), then fork it so
    // ours/theirs carry stale specs --frozen-lockfile must reject, forcing
    // the regen path for real.
    fx.must(spawnSync('bun', ['install'], { cwd: fx.dir, env: fx.env, encoding: 'utf8' }), 'bun install fixture');
    const lock = fx.read('bun.lock');
    diverge(
      fx,
      () => fx.write('bun.lock', lock.replaceAll('file:vendor/lp', 'file:vendor/stale')),
      () => fx.write('bun.lock', lock.replaceAll('file:vendor/lp', 'file:vendor/theirs')),
    );
    assert.notEqual(fx.git(['rebase', 'main']).status, 0);
    const before = fx.read('package.json');
    const help = spawnSync('node', [SCRIPT], { cwd: fx.dir, env: fx.env, encoding: 'utf8' });
    assert.equal(help.status, 0, `helper failed: ${help.stdout}${help.stderr}`);
    assert.match(help.stdout, /resolved\s+bun\.lock \(regenerated/);
    assert.equal(fx.read('package.json'), before, 'regen must not touch the manifest');
    assert.match(fx.read('bun.lock'), /file:vendor\/lp/, 'regen fixed the stale spec');
    for (const m of fx.read('bun.lock').matchAll(/https?:\/\/[^\s"')\]]+/g))
      assert.equal(new URL(m[0]).host, 'registry.npmjs.org');
    // invariant: resolved lockfile must satisfy the manifest as-is
    fx.must(
      spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: fx.dir, env: fx.env, encoding: 'utf8' }),
      'lockfile consistent with package.json',
    );
    fx.must(fx.git(['rebase', '--continue']), 'rebase --continue');
  } finally {
    fx.cleanup();
  }
});

test('helper regenerates a conflicted Cargo.lock via cargo, Cargo.toml untouched', () => {
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  if (cargo.status !== 0) return;
  const fx = fixture();
  try {
    initRepo(fx);
    fx.write(
      'src-tauri/Cargo.toml',
      '[package]\nname = "lockfix"\nversion = "0.0.0"\nedition = "2021"\n',
    );
    fx.write('src-tauri/src/lib.rs', '');
    const lock = (name) =>
      `# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 3\n\n[[package]]\nname = "${name}"\nversion = "0.0.0"\n`;
    fx.write('src-tauri/Cargo.lock', lock('lockfix'));
    // ours carries a stale package name so --locked rejects it and the
    // regen path runs for real (no deps → no network).
    diverge(
      fx,
      () => fx.write('src-tauri/Cargo.lock', lock('lockfix-stale')),
      () => fx.write('src-tauri/Cargo.lock', lock('lockfix-pr')),
    );
    assert.notEqual(fx.git(['rebase', 'main']).status, 0);
    const before = fx.read('src-tauri/Cargo.toml');
    const help = spawnSync('node', [SCRIPT], {
      cwd: fx.dir,
      env: { ...fx.env, CARGO_TERM_COLOR: 'never' },
      encoding: 'utf8',
    });
    assert.equal(help.status, 0, `helper failed: ${help.stdout}${help.stderr}`);
    assert.match(help.stdout, /resolved\s+src-tauri\/Cargo\.lock \(regenerated/);
    assert.equal(fx.read('src-tauri/Cargo.toml'), before, 'regen must not touch the manifest');
    assert.match(fx.read('src-tauri/Cargo.lock'), /name = "lockfix"/, 'regen fixed the stale entry');
    for (const m of fx.read('src-tauri/Cargo.lock').matchAll(/^source = "([^"]+)"/gm))
      assert.match(m[1], /crates\.io/);
    fx.must(fx.git(['rebase', '--continue']), 'rebase --continue');
  } finally {
    fx.cleanup();
  }
});
