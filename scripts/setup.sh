#!/usr/bin/env bash
# One-command dev setup for macOS and Linux.
# Safe to run again: existing rustup, Bun, and node_modules are reused.
# Non-interactive. Does not build the desktop app (see scripts/install.sh).

set -euo pipefail

BOLD=$'\033[1m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
RED=$'\033[0;31m'
RESET=$'\033[0m'

info()    { echo "${BOLD}[ashlr-md]${RESET} $*"; }
success() { echo "${GREEN}${BOLD}[ashlr-md]${RESET}${GREEN} $*${RESET}"; }
warn()    { echo "${YELLOW}${BOLD}[ashlr-md]${RESET}${YELLOW} $* ${RESET}" >&2; }
die()     { echo "${RED}${BOLD}[ashlr-md] ERROR:${RESET}${RED} $*${RESET}" >&2; exit 1; }

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "scripts/setup.sh supports macOS and Linux. On Windows run: pwsh -File scripts/setup.ps1" ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/rustc-version.sh
source "$REPO_ROOT/scripts/rustc-version.sh"

if ! command -v curl >/dev/null 2>&1; then
  die "curl is not installed."
fi
if ! command -v git >/dev/null 2>&1; then
  die "git is not installed."
fi

if ! command -v rustup >/dev/null 2>&1; then
  if [[ -x "${HOME}/.cargo/bin/rustup" ]]; then
    export PATH="${HOME}/.cargo/bin:${PATH}"
  else
    info "Installing rustup (non-interactive)…"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none
    # shellcheck disable=SC1091
    source "${HOME}/.cargo/env"
  fi
fi

require_rustc "$REPO_ROOT"

if ! command -v bun >/dev/null 2>&1; then
  if [[ -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ]]; then
    export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:${PATH}"
  else
    info "Installing Bun (non-interactive)…"
    curl --proto '=https' --tlsv1.2 -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="${BUN_INSTALL}/bin:${PATH}"
  fi
fi
command -v bun >/dev/null 2>&1 || die "Bun was not found after install. Add ${HOME}/.bun/bin to PATH and run bash scripts/setup.sh again."

info "Installing JS dependencies (bun install)…"
bun install --frozen-lockfile --ignore-scripts

info "Smoke test…"
have=$(rustc_release)
version_ge "$have" "$CRATE_RUST_FLOOR" || die "smoke: rustc ${have} is below ${CRATE_RUST_FLOOR}."
test -d node_modules || die "smoke: node_modules is missing after bun install."
cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 --no-deps >/dev/null
success "Setup complete. rustc ${have}. Smoke checks passed."
echo "Next: bash scripts/install.sh   or   SKIP_APP_BUILD=1 bash scripts/install.sh"
echo "Discord: https://discord.gg/jBQrSU6XeD (The Dev Shack)"
