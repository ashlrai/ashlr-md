#!/usr/bin/env bash
# =============================================================================
# Ashlr MD — build-from-source installer
#
# Clones (or uses an existing checkout), builds the app and its CLI tools,
# installs them to standard locations, and registers the MCP server with
# Claude Code if the CLI is present.
#
# Usage:
#   # Fresh install (curl-able):
#   bash <(curl -fsSL https://raw.githubusercontent.com/ashlrai/ashlr-md/main/scripts/install.sh)
#
#   # Or run directly from a checkout:
#   bash scripts/install.sh
#
#   # Skip the app build (CLI + MCP only, useful for CI agents):
#   SKIP_APP_BUILD=1 bash scripts/install.sh
#
# Requirements: Rust (rustup), Bun, Xcode CLT (macOS), git
# =============================================================================

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
BOLD=$'\033[1m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
RED=$'\033[0;31m'
RESET=$'\033[0m'

info()    { echo "${BOLD}[ashlr-md]${RESET} $*"; }
success() { echo "${GREEN}${BOLD}[ashlr-md]${RESET}${GREEN} $*${RESET}"; }
warn()    { echo "${YELLOW}${BOLD}[ashlr-md]${RESET}${YELLOW} $* ${RESET}" >&2; }
die()     { echo "${RED}${BOLD}[ashlr-md] ERROR:${RESET}${RED} $*${RESET}" >&2; exit 1; }

# ── Configuration (override via environment) ──────────────────────────────────
REPO_URL="${REPO_URL:-https://github.com/ashlrai/ashlr-md.git}"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"
CLI_BIN_DIR="${CLI_BIN_DIR:-/usr/local/bin}"
SKIP_APP_BUILD="${SKIP_APP_BUILD:-0}"

# ── 1. Preflight checks ───────────────────────────────────────────────────────
info "Checking prerequisites…"

check_cmd() {
  local cmd="$1" hint="$2"
  if ! command -v "$cmd" &>/dev/null; then
    die "$cmd is not installed. $hint"
  fi
}

check_cmd git  "Install Xcode CLT: xcode-select --install"
check_cmd curl "Install curl via Homebrew: brew install curl"
check_cmd cargo "Install Rust: https://rustup.rs"
check_cmd bun  "Install Bun: https://bun.sh (curl -fsSL https://bun.sh/install | bash)"

# macOS-only check: Tauri 2 requires macOS 10.15+
if [[ "$(uname)" == "Darwin" ]]; then
  SW_VER=$(sw_vers -productVersion 2>/dev/null || echo "0.0")
  IFS='.' read -ra VER_PARTS <<< "$SW_VER"
  MAJOR="${VER_PARTS[0]:-0}" MINOR="${VER_PARTS[1]:-0}"
  if (( MAJOR < 10 || (MAJOR == 10 && MINOR < 15) )); then
    die "macOS 10.15 Catalina or later required (you have $SW_VER)"
  fi
  info "macOS $SW_VER — OK"
fi

# ── 2. Resolve repo directory ─────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Detect whether we're already inside a checkout.
if [[ -f "$REPO_ROOT/src-tauri/Cargo.toml" ]]; then
  info "Using existing checkout at $REPO_ROOT"
else
  # Not inside a checkout — clone into ~/ashlr-md (or a custom path).
  CLONE_DIR="${CLONE_DIR:-$HOME/ashlr-md}"
  if [[ -d "$CLONE_DIR/.git" ]]; then
    info "Updating existing clone at $CLONE_DIR…"
    git -C "$CLONE_DIR" pull --ff-only
  else
    info "Cloning $REPO_URL → $CLONE_DIR…"
    git clone "$REPO_URL" "$CLONE_DIR"
  fi
  REPO_ROOT="$CLONE_DIR"
fi

cd "$REPO_ROOT"

# ── 3. Install JS/TS dependencies ─────────────────────────────────────────────
info "Installing JS dependencies (bun install)…"
bun install --frozen-lockfile

# ── 4. Build the sidecar binaries ─────────────────────────────────────────────
info "Building sidecar binaries (mdopen + mdopener-mcp)…"
cargo build --release \
  --manifest-path src-tauri/Cargo.toml \
  -p mdopen \
  -p mdopener-mcp

MCP_BIN="$REPO_ROOT/src-tauri/target/release/mdopener-mcp"
MDOPEN_BIN="$REPO_ROOT/src-tauri/target/release/mdopen"

[[ -f "$MCP_BIN" ]]    || die "mdopener-mcp binary not found at $MCP_BIN"
[[ -f "$MDOPEN_BIN" ]] || die "mdopen binary not found at $MDOPEN_BIN"
success "Sidecar binaries built."

# ── 5. Build + install the .app (unless skipped) ─────────────────────────────
APP_BINARY="$MCP_BIN"   # default: use the target/release binary for MCP reg

if [[ "$SKIP_APP_BUILD" == "1" ]]; then
  warn "SKIP_APP_BUILD=1 — skipping Tauri build and .app installation."
else
  info "Building Ashlr MD.app (bun run tauri build)…"
  info "This takes 2–5 minutes on first run."
  bun run tauri build

  # Locate the freshly built .app bundle.
  APP_PATH="$(find "$REPO_ROOT/src-tauri/target/release/bundle/macos" \
    -name "Ashlr MD.app" -maxdepth 2 | head -1)"
  [[ -n "$APP_PATH" ]] || die ".app bundle not found after tauri build."
  success "Built: $APP_PATH"

  # Copy to /Applications (requires write permission; prompt sudo if needed).
  DEST_APP="$INSTALL_DIR/Ashlr MD.app"
  if [[ -w "$INSTALL_DIR" ]]; then
    info "Copying to $DEST_APP…"
    rm -rf "$DEST_APP"
    cp -R "$APP_PATH" "$DEST_APP"
  else
    info "Copying to $DEST_APP (requires sudo)…"
    sudo rm -rf "$DEST_APP"
    sudo cp -R "$APP_PATH" "$DEST_APP"
  fi
  success "Ashlr MD installed to $DEST_APP"
  APP_BINARY="$DEST_APP/Contents/MacOS/mdopener-mcp"
fi

# ── 6. Symlink mdopen CLI ─────────────────────────────────────────────────────
info "Symlinking mdopen CLI…"
install_cli_to() {
  local dir="$1"
  if [[ -w "$dir" ]] || mkdir -p "$dir" 2>/dev/null; then
    ln -sf "$MDOPEN_BIN" "$dir/mdopen"
    success "mdopen → $dir/mdopen"
    return 0
  fi
  return 1
}

if ! install_cli_to "$CLI_BIN_DIR"; then
  FALLBACK="$HOME/.local/bin"
  warn "$CLI_BIN_DIR is not writable — trying $FALLBACK"
  if install_cli_to "$FALLBACK"; then
    warn "Add $FALLBACK to your PATH if it isn't already:"
    warn "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
  else
    warn "Could not install mdopen CLI — run manually:"
    warn "  sudo cp $MDOPEN_BIN /usr/local/bin/mdopen"
  fi
fi

# ── 7. Register MCP server with Claude Code ───────────────────────────────────
if command -v claude &>/dev/null; then
  info "Registering Ashlr MD MCP server with Claude Code…"
  if claude mcp add --scope user ashlr-md "$APP_BINARY" 2>&1; then
    success "MCP server registered. Restart Claude Code to activate it."
  else
    warn "Registration failed (exit $?). Run manually:"
    warn "  claude mcp add --scope user ashlr-md \"$APP_BINARY\""
  fi
else
  info "Claude Code CLI not found — skipping MCP registration."
  info "Once you install Claude Code, run:"
  info "  claude mcp add --scope user ashlr-md \"$APP_BINARY\""
fi

# ── 8. Next steps ─────────────────────────────────────────────────────────────
echo ""
success "Installation complete."
echo ""
echo "${BOLD}Next steps:${RESET}"
echo "  1. Open any Markdown file:  mdopen ~/path/to/file.md"
echo "  2. Or double-click a .md file in Finder — Ashlr MD is now the default."
if command -v claude &>/dev/null; then
  echo "  3. Restart Claude Code — it will now have access to Ashlr MD tools."
else
  echo "  3. Install Claude Code (https://claude.ai/download) for one-click MCP setup."
fi
echo ""
echo "  MCP tools available to agents:"
echo "    open_file         open a file in the app"
echo "    get_current_content  get the active document's content"
echo "    set_content       replace the active document's content"
echo "    list_recent       list recently opened files"
echo "    export            export to PDF / DOCX / HTML"
echo ""
echo "  Docs: https://github.com/ashlrai/ashlr-md/blob/main/docs/AGENTS.md"
echo ""
