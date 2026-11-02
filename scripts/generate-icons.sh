#!/usr/bin/env bash
# =============================================================================
# scripts/generate-icons.sh
# Generate all icon assets for MD Opener from src-tauri/icons/icon.svg.
#
# RECOMMENDED (simplest) approach:
#   1. Export icon.svg to a 1024×1024 PNG named icon-source.png
#      (e.g. with Inkscape, Figma, or the rsvg-convert fallback below).
#   2. Run:  bun run tauri icon src-tauri/icons/icon-source.png
#      Tauri's built-in generator produces every required PNG, .icns and .ico
#      and writes them into src-tauri/icons/ automatically.
#
# This script wraps that flow with sensible fallbacks:
#   - If rsvg-convert is available it rasterizes the SVG for you.
#   - Otherwise it guides you to install it or export manually.
#   - It then delegates to `bun run tauri icon` for all final assets.
#
# Requirements (auto-detected):
#   - Bun (https://bun.sh)
#   - @tauri-apps/cli in devDependencies (bun install first)
#   - rsvg-convert  (optional, for auto SVG→PNG; brew install librsvg)
#
# Usage:
#   chmod +x scripts/generate-icons.sh
#   ./scripts/generate-icons.sh
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ICONS_DIR="$REPO_ROOT/src-tauri/icons"
SVG_SOURCE="$ICONS_DIR/icon.svg"
PNG_SOURCE="$ICONS_DIR/icon-source.png"   # 1024×1024 PNG handed to tauri icon
TAURI_ICON_SIZE=1024

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { echo "  [info]  $*"; }
ok()    { echo "  [ok]    $*"; }
warn()  { echo "  [warn]  $*"; }
die()   { echo "  [error] $*" >&2; exit 1; }

require_cmd() {
  command -v "$1" &>/dev/null || die "'$1' is not installed or not in PATH. $2"
}

# ---------------------------------------------------------------------------
# 1. Verify SVG source exists
# ---------------------------------------------------------------------------
echo ""
echo "=== MD Opener — Icon Generator ==="
echo ""

if [[ ! -f "$SVG_SOURCE" ]]; then
  die "SVG source not found at $SVG_SOURCE. Nothing to do."
fi
info "SVG source:  $SVG_SOURCE"

# ---------------------------------------------------------------------------
# 2. SVG → 1024×1024 PNG
#    Try rsvg-convert first (best quality), then sips (macOS built-in),
#    then fall back to manual export instructions.
# ---------------------------------------------------------------------------
if [[ -f "$PNG_SOURCE" ]]; then
  ok "icon-source.png already exists — skipping rasterisation."
  ok "Delete $PNG_SOURCE to re-rasterise from the SVG."
else
  info "Rasterising icon.svg → icon-source.png (${TAURI_ICON_SIZE}×${TAURI_ICON_SIZE}) …"

  if command -v rsvg-convert &>/dev/null; then
    info "Using rsvg-convert (best quality)."
    rsvg-convert -w $TAURI_ICON_SIZE -h $TAURI_ICON_SIZE \
      --keep-aspect-ratio \
      "$SVG_SOURCE" -o "$PNG_SOURCE"
    ok "Wrote $PNG_SOURCE"

  elif [[ "$(uname)" == "Darwin" ]]; then
    # macOS sips can convert SVG on Ventura / Sonoma via WebKit renderer.
    info "rsvg-convert not found; trying macOS sips …"
    # sips requires the output format flag on older versions
    if sips -s format png "$SVG_SOURCE" --resampleHeightWidth \
        $TAURI_ICON_SIZE $TAURI_ICON_SIZE \
        --out "$PNG_SOURCE" &>/dev/null; then
      ok "Wrote $PNG_SOURCE via sips."
    else
      warn "sips could not convert the SVG (some macOS versions don't support SVG input)."
      echo ""
      echo "  To generate the PNG manually, choose one option:"
      echo "    a) brew install librsvg  then re-run this script"
      echo "    b) Open icon.svg in Figma / Sketch / Inkscape,"
      echo "       export as ${TAURI_ICON_SIZE}×${TAURI_ICON_SIZE} PNG,"
      echo "       save to: $PNG_SOURCE"
      echo "    c) Use qlmanage (Preview quick-look) for a quick render:"
      echo "       qlmanage -t -s $TAURI_ICON_SIZE -o /tmp/ \"$SVG_SOURCE\""
      echo "       cp /tmp/icon.svg.png \"$PNG_SOURCE\""
      echo ""
      die "Please provide $PNG_SOURCE and re-run this script."
    fi

  else
    echo ""
    echo "  No SVG rasteriser found."
    echo "  Options:"
    echo "    • Install Inkscape:     brew install inkscape"
    echo "    • Install librsvg:      brew install librsvg   (provides rsvg-convert)"
    echo "    • Export manually from Figma / Sketch and save as:"
    echo "      $PNG_SOURCE"
    echo ""
    die "Please provide $PNG_SOURCE and re-run this script."
  fi
fi

# ---------------------------------------------------------------------------
# 3. Verify Bun is available
# ---------------------------------------------------------------------------
require_cmd bun "Install Bun from https://bun.sh"

# ---------------------------------------------------------------------------
# 4. Verify @tauri-apps/cli is installed (node_modules)
# ---------------------------------------------------------------------------
if [[ ! -f "$REPO_ROOT/node_modules/.bin/tauri" ]]; then
  info "@tauri-apps/cli not found in node_modules — running bun install …"
  cd "$REPO_ROOT" && bun install --frozen-lockfile --ignore-scripts
fi

# ---------------------------------------------------------------------------
# 5. Delegate everything else to `bun run tauri icon`
#
#    tauri icon <source.png> generates:
#      32x32.png, 128x128.png, 128x128@2x.png,
#      icon.icns  (macOS),  icon.ico  (Windows),
#      Square*Logo.png  (Windows Store),
#      StoreLogo.png, AppIcon.appiconset (iOS), etc.
#    All written to src-tauri/icons/ automatically.
# ---------------------------------------------------------------------------
echo ""
info "Running: bun run tauri icon \"$PNG_SOURCE\""
info "This overwrites all PNG / .icns / .ico files in src-tauri/icons/"
echo ""

cd "$REPO_ROOT"
bun run tauri icon "$PNG_SOURCE"

echo ""
ok "Done! Icon set generated in $ICONS_DIR"
echo ""
echo "  Next steps:"
echo "    1. Inspect the icons in src-tauri/icons/ visually."
echo "    2. Commit the updated icons:"
echo "       git add src-tauri/icons/ && git commit -m 'chore: regenerate app icons'"
echo "    3. Build the app to verify the icon appears correctly:"
echo "       bun run tauri build"
echo ""
