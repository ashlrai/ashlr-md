#!/usr/bin/env node
// Turn the first Vitest JSON failure into one annotation and a one-line summary.
import { appendFileSync, readFileSync } from 'node:fs';

export function firstFailure(report) {
  const files = report?.testResults ?? [];
  for (const file of files) {
    for (const test of file.assertionResults ?? []) {
      if (test.status !== 'failed') continue;
      const blob = (test.failureMessages ?? []).join('\n');
      const located = blob.match(/((?:[A-Za-z]:)?[^:\n()]+?\.(?:ts|tsx|js|mjs)):(\d+):(\d+)/);
      return {
        file: test.location?.file ?? file.name ?? located?.[1] ?? '',
        line: String(test.location?.line ?? located?.[2] ?? ''),
        col: String(test.location?.column ?? located?.[3] ?? ''),
        message: test.fullName ?? test.title ?? 'failed test',
      };
    }
  }
  return null;
}

export function annotation(diag) {
  const message = String(diag.message).replace(/\s+/g, ' ').slice(0, 400);
  const parts = [];
  if (diag.file) parts.push(`file=${diag.file}`);
  if (diag.line) parts.push(`line=${diag.line}`);
  if (diag.col) parts.push(`col=${diag.col}`);
  return `::error ${parts.join(',')}::${message}`;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const path = argv[0];
  let report = null;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    report = null;
  }
  const diag = report ? firstFailure(report) : null;
  if (!diag) {
    process.stdout.write('::error::unit tests failed before a JSON report was written\n');
    return 0;
  }
  process.stdout.write(`${annotation(diag)}\n`);
  const line = `${diag.file}${diag.line ? `:${diag.line}` : ''} ${diag.message}`.trim();
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### First failure\n\n${line}\n`);
  } else {
    process.stdout.write(`first failure: ${line}\n`);
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('suite-failure.mjs')) {
  process.exit(main());
}
