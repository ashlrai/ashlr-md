#!/usr/bin/env bash
# build-sidecars.sh — Build sidecar binaries before `tauri build`.
#
# On macOS: builds 2 Rust sidecars + 2 Swift sidecars.
# On Linux: builds only the 2 Rust sidecars (no Swift).
#
# Run from the repository root.
# Usage:
#   bash scripts/build-sidecars.sh
#
# The compiled binaries are placed in src-tauri/target/release/ which is
# where tauri.conf.json `bundle.resources` expects to find them.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[build-sidecars] Building Rust sidecars (mdopen + mdopener-mcp)..."
cargo build --release \
  --manifest-path "$REPO_ROOT/src-tauri/Cargo.toml" \
  -p mdopen \
  -p mdopener-mcp

if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "[build-sidecars] macOS detected — building Swift sidecars (best-effort)..."

  # mdopener-afm needs the macOS 26 SDK (Xcode 26) for the FoundationModels
  # framework, so on an older Xcode (e.g. GitHub runners today) it can't compile.
  # mdopener-setdefault now builds on any Xcode 15+ — it picks the right
  # NSWorkspace API label at compile time via `#if compiler(>=6.2)`, so it ships
  # in every release and one-click set-default works out of the box.
  # The afm build stays best-effort and DOESN'T fail the whole release: when it
  # is absent the Rust resolver degrades gracefully (Apple on-device AI falls
  # back to Ollama/cloud). CI reconciles bundle.resources to whatever actually
  # built (see release.yml).
  if bash "$REPO_ROOT/src-tauri/bins/mdopener-afm/build.sh"; then
    echo "[build-sidecars] ✓ mdopener-afm built."
  else
    echo "[build-sidecars] ⚠ mdopener-afm did NOT build (needs Xcode 26 / macOS 26 SDK) — continuing without on-device Apple AI."
  fi

  if bash "$REPO_ROOT/src-tauri/bins/mdopener-setdefault/build.sh"; then
    echo "[build-sidecars] ✓ mdopener-setdefault built."
  else
    echo "[build-sidecars] ⚠ mdopener-setdefault did NOT build — continuing without one-click set-default (this is unexpected on Xcode 15+; check the build log)."
  fi
else
  echo "[build-sidecars] Non-macOS detected — skipping Swift sidecars."
  echo "[build-sidecars] 2 Rust sidecars built successfully."
fi
