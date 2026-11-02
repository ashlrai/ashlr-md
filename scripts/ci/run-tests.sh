#!/usr/bin/env bash
# run-tests.sh — Run vitest unit tests with optional test name filter.
#
# Environment variables:
#   DISPATCH_TESTS  — test name filter (passed to --test-name-pattern)
#   COVERAGE        — if set, add coverage flags (lcov + JUnit reports)
#
# This script is the safe execution path for dispatch inputs: the user
# input is never interpolated into a run: block; it arrives here solely
# via the validated env var.
set -euo pipefail

VITEST="./node_modules/.bin/vitest"
ARGS=(run)

if [ -n "${COVERAGE:-}" ]; then
  ARGS+=(--coverage --coverage.reporter=lcov --reporter=default --reporter=junit --outputFile=junit.xml)
else
  ARGS+=(--reporter=default)
fi

if [ -n "${DISPATCH_TESTS:-}" ]; then
  ARGS+=(--test-name-pattern "${DISPATCH_TESTS}")
fi

exec "${VITEST}" "${ARGS[@]}"
