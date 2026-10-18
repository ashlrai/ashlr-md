import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, report } from './check-crypto.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'pqcheck-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

test('hashes, HMAC and symmetric AEAD are not flagged', () => {
  const root = fixture({ 'src/a.ts': "createHash('sha256'); createHmac('sha256', k); chacha20poly1305", 'src/b.rs': 'use sha2::Sha256;' });
  assert.deepEqual(scan(root), []);
  rmSync(root, { recursive: true });
});

test('classical asymmetric use is flagged and fails the report', () => {
  const root = fixture({
    'src/sign.ts': "crypto.subtle.generateKey({ name: 'ECDSA' })",
    'src/key.rs': 'use ed25519_dalek::SigningKey;',
    'src/dh.ts': 'generateKeyPairSync("x25519")',
    'src/rsa.rs': 'use rsa::RsaPrivateKey;',
  });
  const hits = scan(root);
  assert.deepEqual(hits.map((h) => h.file), ['src/dh.ts', 'src/key.rs', 'src/rsa.rs', 'src/sign.ts']);
  assert.equal(report(hits).failed, true);
  rmSync(root, { recursive: true });
});

test('allowlisted files pass, with their reason shown', () => {
  const root = fixture({ 'src/key.rs': 'use ed25519_dalek::SigningKey;' });
  const r = report(scan(root, { allow: { 'src/key.rs': 'registry signatures' } }));
  assert.equal(r.failed, false);
  assert.match(r.text, /ok   src\/key.rs .*registry signatures/);
  rmSync(root, { recursive: true });
});

test('tests, docs and vendored dirs are skipped, and id_rsa paths are not RSA use', () => {
  const root = fixture({
    'src/__tests__/x.test.ts': "ed25519",
    'docs/n.ts': 'X25519',
    'node_modules/m/index.js': 'ECDSA',
    'src/paths.ts': "join(home, '.ssh', 'id_rsa')",
  });
  assert.deepEqual(scan(root), []);
  rmSync(root, { recursive: true });
});
