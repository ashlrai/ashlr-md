#!/usr/bin/env bash
# Documented end-user install of one already-downloaded release asset.
# INSTALL.md: apt install of the .deb, NSIS /S, or open the DMG.
set -euo pipefail
if [ -z "${ASSET:-}" ] || [ ! -f "$ASSET" ]; then
  echo "::error::release asset is missing"
  exit 1
fi

case "$(uname -s)" in
  Linux)
    export DEBIAN_FRONTEND=noninteractive
    opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
    sudo apt-get "${opts[@]}" update
    sudo apt-get "${opts[@]}" install -y "$ASSET"
    pkg="$(dpkg-deb -f "$ASSET" Package)"
    bin="$(dpkg -L "$pkg" | grep '/mdopen$' | head -n 1)"
    test -n "$bin"
    "$bin" --version
    ;;
  Darwin)
    plist="$(mktemp)"
    hdiutil attach -nobrowse -readonly -plist "$ASSET" > "$plist"
    mount="$(python3 -c 'import plistlib,sys; p=plistlib.load(open(sys.argv[1],"rb")); print(next(e["mount-point"] for e in p["system-entities"] if "mount-point" in e))' "$plist")"
    app="$(find "$mount" -name 'Ashlr MD.app' -maxdepth 3 -print -quit)"
    test -n "$app"
    bin="$(find "$app/Contents" -name mdopen -type f -print -quit)"
    test -n "$bin"
    "$bin" --version
    hdiutil detach "$mount" || true
    ;;
  MINGW*|MSYS*|CYGWIN*)
    powershell.exe -NoProfile -Command "Start-Process -FilePath '$ASSET' -ArgumentList '/S' -Wait"
    exe="$(cygpath -u "$LOCALAPPDATA")/Ashlr MD/mdopen.exe"
    test -f "$exe"
    "$exe" --version
    ;;
  *)
    echo "::error::no documented installer for $(uname -s)"
    exit 1
    ;;
esac
