import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

test('package scripts/... .mjs paths exist', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const scripts = pkg.scripts || {};

  // Extract every scripts/... .mjs path from the raw script values
  const mjsRe = /scripts\/[\w./\-]+\.mjs/g;
  const found = new Set();
  for (const val of Object.values(scripts)) {
    for (const m of String(val).matchAll(mjsRe)) {
      found.add(m[0]);
    }
  }

  const paths = [...found].sort();

  // At least one scripts/... .mjs path must exist
  assert.ok(paths.length > 0, 'expected at least one scripts/... .mjs path from package.json scripts');

  // Each extracted path must exist on disk from repo root
  const missing = [];
  for (const p of paths) {
    const full = path.join(ROOT, p);
    if (!fs.existsSync(full)) missing.push(p);
  }

  assert.equal(missing.length, 0, `Missing files: ${missing.join(', ')}`);
});
