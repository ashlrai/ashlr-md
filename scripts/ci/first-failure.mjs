#!/usr/bin/env node
// Run the OS fast checks and stop at the first failure. The log gets one
// ::error annotation with file:line, not the full compiler or test dump.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function annotation(diag) {
  const message = String(diag.message ?? 'failed').replace(/\s+/g, ' ').slice(0, 500);
  const parts = [];
  if (diag.file) parts.push(`file=${diag.file}`);
  if (diag.line) parts.push(`line=${diag.line}`);
  if (diag.col) parts.push(`col=${diag.col}`);
  const loc = parts.length ? ` ${parts.join(',')}` : '';
  return `::error${loc}::${message}`;
}

export function firstTsc(text) {
  const match = String(text).match(/^(.+?)\((\d+),(\d+)\):\s+error\s+(.+)$/m);
  if (!match) return null;
  return { file: match[1], line: match[2], col: match[3], message: match[4] };
}

export function firstBiome(text) {
  const match = String(text).match(/^(.+?\.(?:ts|tsx|js|mjs|json)):(\d+):(\d+)\s+(.+)$/m);
  if (!match) return null;
  return { file: match[1], line: match[2], col: match[3], message: match[4] };
}

export function firstVitest(report) {
  const files = report?.testResults ?? [];
  for (const file of files) {
    for (const test of file.assertionResults ?? []) {
      if (test.status !== 'failed') continue;
      const blob = (test.failureMessages ?? []).join('\n');
      const located = blob.match(/((?:[A-Za-z]:)?[^:\n()]+?\.(?:ts|tsx|js|mjs)):(\d+):(\d+)/);
      return {
        file: test.location?.file ?? file.name ?? located?.[1],
        line: test.location?.line ?? located?.[2],
        col: test.location?.column ?? located?.[3],
        message: test.fullName ?? test.title ?? 'failed test',
      };
    }
  }
  return null;
}

function run(args) {
  return spawnSync('bunx', args, { encoding: 'utf8' });
}

function die(diag, fallback) {
  process.stdout.write(`${annotation(diag ?? { message: fallback })}\n`);
  return 1;
}

export function main(env = process.env) {
  const tsc = run(['tsc', '--noEmit', '--pretty', 'false']);
  if (tsc.error) return die(null, `typecheck could not start: ${tsc.error.message}`);
  if (tsc.status !== 0) return die(firstTsc(`${tsc.stdout}\n${tsc.stderr}`), 'typecheck failed');

  const biome = run(['biome', 'check', 'src', '--max-diagnostics=1']);
  if (biome.error) return die(null, `lint could not start: ${biome.error.message}`);
  if (biome.status !== 0) return die(firstBiome(`${biome.stdout}\n${biome.stderr}`), 'lint failed');

  const dir = mkdtempSync(join(tmpdir(), 'os-vitest-'));
  const output = join(dir, 'results.json');
  const args = ['vitest', 'run', '--project', 'unit', '--bail=1', '--reporter=json', `--outputFile=${output}`];
  const base = env.OS_TEST_BASE ?? '';
  if (base) args.push('--changed', base);
  const vitest = run(args);
  if (vitest.error) return die(null, `unit tests could not start: ${vitest.error.message}`);
  if (vitest.status === 0) return 0;
  let report = null;
  if (existsSync(output)) {
    try {
      report = JSON.parse(readFileSync(output, 'utf8'));
    } catch {
      report = null;
    }
  }
  return die(report ? firstVitest(report) : null, 'unit tests failed');
}

if (process.argv[1] && process.argv[1].endsWith('first-failure.mjs')) {
  process.exit(main());
}
