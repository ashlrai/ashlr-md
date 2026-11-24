import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { annotation, firstFailure, main } from './suite-failure.mjs';

test('the first failed test keeps file and line', () => {
  const diag = firstFailure({
    testResults: [{
      name: 'test/llms/links.test.ts',
      assertionResults: [{
        status: 'failed',
        fullName: 'llms.txt link validation',
        location: { line: 77, column: 13 },
        failureMessages: ['Error: Link validation failed\n    at test/llms/links.test.ts:77:13'],
      }],
    }],
  });
  assert.equal(diag.file, 'test/llms/links.test.ts');
  assert.equal(diag.line, '77');
  assert.equal(annotation(diag), '::error file=test/llms/links.test.ts,line=77,col=13::llms.txt link validation');
});

test('a missing report is one annotation, not a dump', () => {
  const dir = mkdtempSync(join(tmpdir(), 'suite-fail-'));
  const summary = join(dir, 'summary.md');
  writeFileSync(summary, '');
  let written = '';
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => {
    written += chunk;
    return true;
  };
  try {
    assert.equal(main(['/no/such/report.json'], { GITHUB_STEP_SUMMARY: summary }), 0);
  } finally {
    process.stdout.write = orig;
  }
  assert.match(written, /::error::unit tests failed before a JSON report/);
  assert.equal(readFileSync(summary, 'utf8'), '');
});
