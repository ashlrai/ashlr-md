#!/usr/bin/env node
// validate-dispatch — Security gate for workflow_dispatch inputs.
//
// Enforces Security R7 (ci-seconds-review-criteria.md):
//   • only_jobs and only_tests pass via env with an allowlist regex
//   • they are never interpolated into run: blocks
//
// Exits 0 with GITHUB_OUTPUT on success; exits 1 with ::error:: on invalid input.
// When imported, the exported functions return objects instead of exiting.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { appendFileSync } from 'node:fs';

/**
 * Job keys allowed in the `only_jobs` dispatch input.
 * Mirrors the job IDs declared in .github/workflows/ci.yml.
 */
export const VALID_JOBS = new Set([
  'fast',
  'secret-scan',
  'secret-shape',
  'linux-full',
  'macos-full',
  'codecov',
  'fixup-queue',
]);

// The allowlist as it appears in error messages: sorted once, by code point
// order is not wanted — localeCompare reads naturally for these keys.
const VALID_JOBS_LABEL = [...VALID_JOBS].sort((a, b) => a.localeCompare(b)).join(', ');

// only_jobs: comma-separated job keys from the allowlist.
// Each key: lowercase letters, digits, hyphens. No shell-active chars.
const ONLY_JOBS_RE = /^[a-z][a-z0-9-]*(,[a-z][a-z0-9-]*)*$/;

// only_tests: test name pattern for vitest --test-name-pattern (-t).
// Allowed: letters, digits, spaces, commas, dots, slashes, hyphens, underscores,
// parens, plus, asterisk, question mark, square brackets, curly braces, caret.
// Disallowed (shell-active): $, `, ;, &, >, <, !, \, ", '.
// Commas are safe here — they appear in regex quantifiers {n,m} and are not
// shell-active (no word-splitting or globbing in quoted arguments).
const ONLY_TESTS_RE = /^[a-zA-Z0-9 .,\/\-\_()+*?[\]{}^]*$/;

/**
 * Validate the `only_jobs` dispatch input.
 * @param {string|undefined} onlyJobs - comma-separated job keys or empty
 * @returns {{ ok: boolean, error?: string, jobs?: string[] }}
 */
export function validateJobs(onlyJobs) {
  if (onlyJobs === undefined || onlyJobs === '') {
    return { ok: true, jobs: [] };
  }
  if (!ONLY_JOBS_RE.test(onlyJobs)) {
    return {
      ok: false,
      error: `only_jobs must match allowlist pattern (comma-separated keys from: ${VALID_JOBS_LABEL})`,
    };
  }
  const jobs = onlyJobs.split(',').map((s) => s.trim());
  for (const job of jobs) {
    if (!VALID_JOBS.has(job)) {
      return {
        ok: false,
        error: `only_jobs contains unknown job "${job}". Allowed: ${VALID_JOBS_LABEL}`,
      };
    }
  }
  return { ok: true, jobs: [...new Set(jobs)] };
}

/**
 * Validate the `only_tests` dispatch input.
 * @param {string|undefined} onlyTests - test name pattern or empty
 * @returns {{ ok: boolean, error?: string, filter?: string }}
 */
export function validateTests(onlyTests) {
  if (onlyTests === undefined || onlyTests === '') {
    return { ok: true, filter: '' };
  }
  if (!ONLY_TESTS_RE.test(onlyTests)) {
    const bad = [...onlyTests].filter((c) => !/[a-zA-Z0-9 .,\/\-\_()+*?[\]{}^]/.test(c));
    return {
      ok: false,
      error: `only_tests contains disallowed characters: "${bad.join('')}". Only letters, digits, spaces, commas, ., /, -, _, (), *, ?, [], {}, ^ permitted.`,
    };
  }
  return { ok: true, filter: onlyTests };
}

/**
 * Build vitest CLI arguments for the test filter.
 * @param {string} filter - validated test filter string
 * @returns {string[]} argv to append to vitest run
 */
export function buildVitestArgs(filter) {
  if (!filter || filter === '') return [];
  return ['--test-name-pattern', filter];
}

/**
 * Validate both dispatch inputs.
 * @param {object} [opts]
 * @param {string} [opts.onlyJobs] - override env.DAILYFIX_JOBS
 * @param {string} [opts.onlyTests] - override env.DAILYFIX_TESTS
 * @param {function} [opts.writeLine] - callback for GITHUB_OUTPUT lines
 * @returns {{ ok: boolean, error?: string, jobs?: string[], filter?: string }}
 */
export function validate(opts = {}) {
  const onlyJobs = opts.onlyJobs ?? process.env.DAILYFIX_JOBS ?? '';
  const onlyTests = opts.onlyTests ?? process.env.DAILYFIX_TESTS ?? '';

  const jr = validateJobs(onlyJobs);
  if (!jr.ok) return jr;
  const tr = validateTests(onlyTests);
  if (!tr.ok) return tr;

  const result = { ok: true, jobs: jr.jobs, filter: tr.filter };
  if (opts.writeLine) {
    opts.writeLine(`dispatch_jobs=${JSON.stringify(result.jobs)}`);
    opts.writeLine(`dispatch_tests=${result.filter}`);
    opts.writeLine(`dispatch_vitest_args=${buildVitestArgs(result.filter).join(' ')}`);
  }
  return result;
}

/**
 * CLI entry point.
 * @returns {number} exit code
 */
export function main() {
  const gho = process.env.GITHUB_OUTPUT;
  const writeLine = gho
    ? (line) => {
        process.stdout.write(`${line}\n`);
        appendFileSync(gho, `${line}\n`);
      }
    : null;

  try {
    const result = validate({ writeLine });
    if (!result.ok) {
      process.stderr.write(`::error::dispatch validation: ${result.error}\n`);
      return 1;
    }
    process.stderr.write(
      `validate-dispatch: ok jobs=${JSON.stringify(result.jobs)} tests="${result.filter}"\n`,
    );
    if (!gho) {
      for (const line of formatOutput(result)) {
        process.stdout.write(`${line}\n`);
      }
    }
    return 0;
  } catch (err) {
    process.stderr.write(`::error::validate-dispatch: ${err.message}\n`);
    return 1;
  }
}

function formatOutput(result) {
  const lines = [];
  lines.push(`dispatch_jobs=${JSON.stringify(result.jobs)}`);
  lines.push(`dispatch_tests=${result.filter}`);
  lines.push(`dispatch_vitest_args=${buildVitestArgs(result.filter).join(' ')}`);
  return lines;
}

// When run directly, execute CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
