#!/usr/bin/env bash
# validate-dispatch.sh — Shell wrapper for scripts/ci/validate-dispatch.mjs
#
# Usage:
#   DAILYFIX_JOBS="linux-full,macos-full" DAILYFIX_TESTS="login" \
#     scripts/ci/validate-dispatch.sh
#
# Exits 0 on valid inputs (writes GITHUB_OUTPUT or stdout).
# Exits 1 on invalid inputs (writes ::error:: to stderr).
#
# Security R7: inputs pass via env with allowlist regex; never
# interpolated into run: blocks. The .mjs module does the validation.

set -euo pipefail
exec node "$(dirname "$0")/validate-dispatch.mjs"
