#!/usr/bin/env bash
# ci-local: run what the merge queue will run for your change, before pushing.
# Usage: scripts/ci-local.sh [base-ref]   (default origin/main)
# Mirrors the Classify changes rules in .github/workflows/ci.yml. JS gates and
# Rust checks run in parallel; target < 2 min on a warm machine.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
base="${1:-origin/main}"
files="$( { git diff --name-only "$base"...HEAD; git diff --name-only; git diff --name-only --cached; } | sort -u)"
not_rust='^(src/|landing/|samples/|integrations/|index\.html$|biome\.json$|vite\.config\.ts$|vitest\.config\.ts$|tsconfig(\.node)?\.json$|package\.json$|bun\.lockb?$|[^/]*\.md$|docs/)'
js_in='^(src/|index\.html$|biome\.json$|vite\.config\.ts$|vitest\.config\.ts$|tsconfig(\.node)?\.json$|package\.json$|bun\.lockb?$|\.github/workflows/|scripts/)'
rust=false; js=false
if printf '%s\n' "$files" | grep -v '^docs/AGENTS\.md$' | grep -Ev "$not_rust" | grep -q .; then rust=true; fi
if printf '%s\n' "$files" | grep -qx 'docs/AGENTS.md'; then rust=true; fi
if printf '%s\n' "$files" | grep -Eq "$js_in"; then js=true; fi
echo "ci-local: js=$js rust=$rust (vs $base)"
pids=()
( bun run typecheck && bunx biome check src && bun run check:crypto \
  && if [ "$js" = true ]; then bunx vitest run --changed "$base"; fi ) & pids+=($!)
if [ "$rust" = true ]; then
<<<<<<< HEAD
  ( cargo clippy --workspace --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings \
    && cargo test --workspace --manifest-path src-tauri/Cargo.toml ) & pids+=($!)
=======
  ( cargo clippy --workspace --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings ) & pids+=($!)
>>>>>>> origin/main
fi
rc=0; for p in "${pids[@]}"; do wait "$p" || rc=1; done
[ $rc -eq 0 ] && echo "ci-local: PASS" || echo "ci-local: FAIL"
exit $rc
