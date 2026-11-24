#!/usr/bin/env bash
# Aggregate one OS. Skipped jobs (the path gate, or a push that does not run
# the leg) pass. Failure and cancellation fail the gate.
set -euo pipefail
if [ -z "${NEEDS:-}" ]; then
  echo "::error::OS gate has no needs context"
  exit 1
fi
bad="$(printf '%s' "$NEEDS" | jq -r 'to_entries[] | select(.value.result != "success" and .value.result != "skipped") | "\(.key)=\(.value.result)"')"
if [ -n "$bad" ]; then
  echo "::error::${bad//$'\n'/ }"
  exit 1
fi
echo "OS gate passed"
