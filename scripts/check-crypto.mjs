#!/usr/bin/env node
// Flags classical-only asymmetric crypto (broken by Shor's algorithm on a large quantum computer)
// in source files that are not on the allowlist. Inventory only: it never judges symmetric
// primitives or hashes. See docs/PQ-READINESS.md. Light on purpose: a regex scan, not a parser.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PATTERNS = [
  ['RSA', /\b(?:RSA-OAEP|RSASSA-PKCS1|RSA-PSS|createSign|createVerify|publicEncrypt|privateDecrypt)\b|\brsa::|\brsa\s*=\s*["{]/],
  ['ECDSA/ECDH', /\b(?:ECDSA|ECDH|createECDH|secp256k1|secp256r1|prime256v1|p256::|p384::|k256::)\b/],
  ['Ed25519/X25519', /\b(?:ed25519[_-]dalek|ed25519|Ed25519|x25519[_-]dalek|X25519|x25519)\b/],
  ['DH', /\b(?:createDiffieHellman|diffieHellman|generateKeyPair(?:Sync)?)\b/],
];
const SKIP_DIRS = new Set(['node_modules', 'target', '.git', 'dist', 'build', 'coverage', '.next', 'docs']);
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs', '.toml']);

export function scan(root, { allow = {}, dirs = ['.'], selfNames = ['check-crypto.mjs', 'check-crypto.test.mjs'] } = {}) {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      const ext = name.slice(name.lastIndexOf('.'));
      if (!EXTS.has(ext) || selfNames.includes(name)) continue;
      const rel = relative(root, p).split(sep).join('/');
      if (/(^|\/)(__tests__|tests?)\//.test(rel) || /\.test\.[a-z]+$/.test(rel)) continue;
      const kinds = new Set();
      for (const [kind, re] of PATTERNS) if (re.test(readFileSync(p, 'utf8'))) kinds.add(kind);
      if (kinds.size) hits.push({ file: rel, kinds: [...kinds].sort(), allowed: rel in allow, reason: allow[rel] });
    }
  };
  for (const d of dirs) walk(resolve(root, d));
  return hits.sort((a, b) => a.file.localeCompare(b.file));
}

export function report(hits) {
  const bad = hits.filter((h) => !h.allowed);
  const lines = [`classical asymmetric crypto: ${hits.length} file(s), ${bad.length} not on the allowlist`];
  for (const h of hits) lines.push(`  ${h.allowed ? 'ok  ' : 'FLAG'} ${h.file} [${h.kinds.join(', ')}]${h.reason ? ` - ${h.reason}` : ''}`);
  return { text: lines.join('\n'), failed: bad.length > 0 };
}

export function main(root, opts) {
  const { text, failed } = report(scan(root, opts));
  console.log(text);
  if (failed) console.error('Add the file to ALLOW in scripts/check-crypto.mjs with a reason, or move to a post-quantum or hybrid scheme (docs/PQ-READINESS.md).');
  return failed ? 1 : 0;
}

const ALLOW = {};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(resolve(fileURLToPath(import.meta.url), '..', '..'), { allow: ALLOW }));
}
