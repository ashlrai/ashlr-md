#!/usr/bin/env bash
# Metadata-only check for the optional Phantom CLI.
# Prints whether `phantom` is on PATH and its version. It runs only
# `phantom --version`. It never runs reveal, never reads the vault or .env
# files, and never captures secret values.
set -u

if ! command -v phantom >/dev/null 2>&1; then
  echo "Phantom: not installed (optional)"
  exit 0
fi

ver="$(phantom --version 2>/dev/null | head -n 1)"
if [ -n "$ver" ]; then
  echo "Phantom: installed ($ver). Run tools with: phantom exec -- <cmd>"
else
  echo "Phantom: found on PATH, version unavailable"
fi
exit 0
