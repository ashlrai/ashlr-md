import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotation, firstBiome, firstTsc, firstVitest } from './first-failure.mjs';

test('tsc annotation keeps the first file:line and drops the rest', () => {
  const text = [
    'src/a.ts(4,2): error TS2322: Type \'number\' is not assignable to type \'string\'.',
    'src/b.ts(9,1): error TS2304: Cannot find name \'nope\'.',
  ].join('\n');
  const diag = firstTsc(text);
  assert.deepEqual(diag, {
    file: 'src/a.ts',
    line: '4',
    col: '2',
    message: 'TS2322: Type \'number\' is not assignable to type \'string\'.',
  });
  assert.equal(annotation(diag), '::error file=src/a.ts,line=4,col=2::TS2322: Type \'number\' is not assignable to type \'string\'.');
});

test('biome annotation keeps the first diagnostic', () => {
  const text = 'src/lib/path.ts:12:5 lint/style/useConst  Fix it.\nmore\n';
  assert.equal(firstBiome(text).line, '12');
  assert.match(annotation(firstBiome(text)), /file=src\/lib\/path\.ts,line=12,col=5/);
});

test('vitest annotation uses the first failed test location', () => {
  const report = {
    testResults: [{
      name: 'src/ok.test.ts',
      assertionResults: [{ status: 'passed', title: 'ok' }],
    }, {
      name: 'src/path.test.ts',
      assertionResults: [{
        status: 'failed',
        fullName: 'paths join on windows',
        location: { line: 18, column: 3 },
        failureMessages: ['Error: expected\n    at src/path.test.ts:18:3'],
      }, {
        status: 'failed',
        fullName: 'later',
        location: { line: 40, column: 1 },
      }],
    }],
  };
  const diag = firstVitest(report);
  assert.equal(diag.file, 'src/path.test.ts');
  assert.equal(diag.line, 18);
  assert.equal(diag.message, 'paths join on windows');
  assert.match(annotation(diag), /::error file=src\/path\.test\.ts,line=18,col=3::paths join on windows/);
});
