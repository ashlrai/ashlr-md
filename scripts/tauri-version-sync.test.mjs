import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));

// Tauri reads the app version from tauri.conf.json, which ships in the bundle
// and drives the updater. package.json is what npm and the release scripts
// read. If they drift, a release can ship with the wrong version string, so
// both must hold the same non-empty value.
function checkVersions(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const tauri = JSON.parse(readFileSync(join(dir, 'src-tauri/tauri.conf.json'), 'utf8'));
  const packageVersion = pkg.version;
  const tauriVersion = tauri.version;
  const ok = typeof packageVersion === 'string' && packageVersion !== '' && packageVersion === tauriVersion;
  const message = ok
    ? `ok: ${packageVersion}`
    : `version mismatch: package.json is ${JSON.stringify(packageVersion)} but src-tauri/tauri.conf.json is ${JSON.stringify(tauriVersion)}. Set both to the same version.`;
  return { ok, message };
}

function fixture(pkgVersion, tauriVersion) {
  const dir = mkdtempSync(join(tmpdir(), 'tauriver-'));
  mkdirSync(join(dir, 'src-tauri'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: pkgVersion }));
  writeFileSync(join(dir, 'src-tauri/tauri.conf.json'), JSON.stringify({ productName: 'x', version: tauriVersion }));
  return dir;
}

test("the repo's package.json and tauri.conf.json versions match", () => {
  const r = checkVersions(root);
  assert.equal(r.ok, true, r.message);
});

test('matching versions pass', () => {
  const dir = fixture('1.2.3', '1.2.3');
  try {
    assert.equal(checkVersions(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('mismatched versions fail and name both values', () => {
  const dir = fixture('1.2.3', '1.2.4');
  try {
    const r = checkVersions(dir);
    assert.equal(r.ok, false);
    assert.match(r.message, /"1\.2\.3".*"1\.2\.4"/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a missing version on either side fails, even when both are missing', () => {
  for (const [pkgV, tauriV] of [[undefined, undefined], ['1.0.0', undefined], [undefined, '1.0.0'], ['', '']]) {
    const dir = fixture(pkgV, tauriV);
    try {
      assert.equal(checkVersions(dir).ok, false, `package=${pkgV} tauri=${tauriV}`);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }
});
