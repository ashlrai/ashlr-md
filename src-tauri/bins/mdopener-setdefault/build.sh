#!/usr/bin/env bash
# build.sh — build the mdopener-setdefault Swift helper and copy it into place.
#
# Run this from the repo root OR from src-tauri/bins/mdopener-setdefault/.
# Requires macOS 12+ SDK (Xcode 14 / Swift 5.9 or later).
# No Xcode 26 needed — this only uses AppKit, Foundation, UniformTypeIdentifiers.
#
# Usage:
#   cd src-tauri/bins/mdopener-setdefault
#   ./build.sh
#
# The compiled binary is placed at:
#   src-tauri/target/release/mdopener-setdefault
# which is where default_handler.rs looks for it in dev mode.
#
# For tauri build (production), list the binary in tauri.conf.json
# `bundle.externalBin` or include it as a resource — see the INTEGRATION
# section in default_handler.rs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TARGET_DIR="$REPO_ROOT/src-tauri/target/release"

echo "[mdopener-setdefault] Building Swift helper..."
echo "  Package: $SCRIPT_DIR"
echo "  Output:  $TARGET_DIR/mdopener-setdefault"

cd "$SCRIPT_DIR"
swift build -c release 2>&1

BUILT_BIN="$SCRIPT_DIR/.build/release/mdopener-setdefault"
if [ ! -f "$BUILT_BIN" ]; then
    echo "[mdopener-setdefault] ERROR: expected binary not found at $BUILT_BIN" >&2
    exit 1
fi

mkdir -p "$TARGET_DIR"
cp "$BUILT_BIN" "$TARGET_DIR/mdopener-setdefault"
echo "[mdopener-setdefault] Done -> $TARGET_DIR/mdopener-setdefault"
