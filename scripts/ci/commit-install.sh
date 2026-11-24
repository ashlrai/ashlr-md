#!/usr/bin/env bash
# Documented build-from-source install (scripts/install.sh) for this checkout.
# SKIP_APP_BUILD=1 is the installer's own CI path: the full macOS app needs
# Xcode 26, and other systems install the CLI and MCP server only.
set -euo pipefail
cd "$(dirname "$0")/../.."
export CLI_BIN_DIR="${RUNNER_TEMP:-/tmp}/ashlr-cli-bin"
mkdir -p "$CLI_BIN_DIR"
export PATH="$CLI_BIN_DIR:$PATH"
export SKIP_APP_BUILD=1
bash scripts/install.sh
if command -v mdopen >/dev/null 2>&1; then
  mdopen --version
elif [ -x "$CLI_BIN_DIR/mdopen.exe" ]; then
  "$CLI_BIN_DIR/mdopen.exe" --version
elif [ -x "$CLI_BIN_DIR/mdopen" ]; then
  "$CLI_BIN_DIR/mdopen" --version
else
  echo "::error::mdopen was not installed onto PATH"
  exit 1
fi
