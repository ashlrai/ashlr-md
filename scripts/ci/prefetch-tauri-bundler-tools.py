#!/usr/bin/env python3
"""Seed the tool cache read by @tauri-apps/cli before `tauri build`.

tauri-bundler (pinned with CLI_VERSION) downloads WiX, NSIS and the AppImage
helpers with one ureq request and no retry. A GitHub HTTP 504 aborts Windows
MSI and Linux AppImage bundling after the app has already compiled. Paths and
checksums match crates/tauri-bundler at that CLI tag. macOS DMGs do not use
these downloads.
"""

from __future__ import annotations

import hashlib
import io
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

# Keep this equal to the resolved @tauri-apps/cli in bun.lock.
CLI_VERSION = "2.11.2"

WIX_URL = "https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip"
WIX_SHA256 = "6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31"
WIX_REQUIRED = (
    "candle.exe",
    "candle.exe.config",
    "darice.cub",
    "light.exe",
    "light.exe.config",
    "wconsole.dll",
    "winterop.dll",
    "wix.dll",
    "WixUIExtension.dll",
    "WixUtilExtension.dll",
)

NSIS_URL = "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip"
NSIS_SHA1 = "ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d"
NSIS_ROOT = "nsis-3.11"
NSIS_DLL_URL = (
    "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/"
    "nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll"
)
NSIS_DLL_SHA1 = "75197fee3c6a814fe035788d1c34ead39349b860"
NSIS_DLL_REL = Path("Plugins/x86-unicode/additional/nsis_tauri_utils.dll")
NSIS_REQUIRED = (
    "makensis.exe",
    "Bin/makensis.exe",
    "Stubs/lzma-x86-unicode",
    "Stubs/lzma_solid-x86-unicode",
    "Include/MUI2.nsh",
    "Include/FileFunc.nsh",
    "Include/x64.nsh",
    "Include/nsDialogs.nsh",
    "Include/WinMessages.nsh",
    "Include/Win/COM.nsh",
    "Include/Win/Propkey.nsh",
    "Include/Win/RestartManager.nsh",
)

MAX_BYTES = 80 * 1024 * 1024
MAX_UNCOMPRESSED = 200 * 1024 * 1024
ATTEMPTS = 5
EXECUTABLE = 0o770


class FetchError(Exception):
    pass


class HttpsRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not str(newurl).startswith("https://"):
            raise FetchError("refusing non-https redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def default_opener():
    return urllib.request.build_opener(HttpsRedirect)


def download(url, opener, attempts=ATTEMPTS, sleep=time.sleep):
    if not url.startswith("https://"):
        raise FetchError("refusing non-https URL")
    last = None
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "ashlr-md-bundler-prefetch"})
            with opener.open(request, timeout=180) as response:
                status = getattr(response, "status", 200)
                if status != 200:
                    raise FetchError(f"http status: {status}")
                data = response.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise FetchError("download exceeds size cap")
            if not data:
                raise FetchError("empty download")
            return data
        except FetchError:
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
            if attempt == attempts:
                break
            sleep(min(2 ** (attempt - 1), 8))
    raise FetchError(f"download failed: {last}")


def digest(data, algorithm):
    hasher = hashlib.new(algorithm)
    hasher.update(data)
    return hasher.hexdigest()


def require_hash(data, algorithm, expected):
    got = digest(data, algorithm)
    if got != expected.lower():
        raise FetchError(f"{algorithm} mismatch")


def safe_extract(data, dest):
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        if sum(info.file_size for info in infos) > MAX_UNCOMPRESSED:
            raise FetchError("zip exceeds uncompressed size cap")
        for info in infos:
            name = info.filename.replace("\\", "/")
            parts = Path(name).parts
            if not name or name.startswith("/") or ".." in parts or any(":" in part for part in parts):
                raise FetchError("unsafe zip entry")
            target = dest.joinpath(*parts)
            if info.is_dir() or name.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            payload = archive.read(info)
            if len(payload) != info.file_size:
                raise FetchError("zip entry size mismatch")
            target.write_bytes(payload)


def tools_dir(os_name, env, home):
    if os_name == "macOS":
        return None
    if os_name == "Windows":
        local = env.get("LOCALAPPDATA")
        if not local:
            raise FetchError("LOCALAPPDATA is unset")
        return Path(local) / "tauri"
    if os_name == "Linux":
        base = env.get("XDG_CACHE_HOME") or str(Path(home) / ".cache")
        return Path(base) / "tauri"
    raise FetchError(f"unsupported OS {os_name}")


def linux_arch(target):
    arch = target.split("-", 1)[0]
    if arch not in {"x86_64", "aarch64", "i686"}:
        raise FetchError(f"unsupported linux target {target}")
    return arch


def linux_tools(arch):
    deploy_arch = "i386" if arch == "i686" else arch
    return (
        (
            f"https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-{arch}",
            f"AppRun-{arch}",
            "elf",
            True,
        ),
        (
            "https://github.com/tauri-apps/binary-releases/releases/download/"
            f"linuxdeploy/linuxdeploy-{deploy_arch}.AppImage",
            f"linuxdeploy-{deploy_arch}.AppImage",
            "elf",
            True,
        ),
        (
            "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh",
            "linuxdeploy-plugin-gtk.sh",
            "script",
            True,
        ),
        (
            "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/master/linuxdeploy-plugin-gstreamer.sh",
            "linuxdeploy-plugin-gstreamer.sh",
            "script",
            True,
        ),
        (
            "https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/"
            f"continuous/linuxdeploy-plugin-appimage-{arch}.AppImage",
            "linuxdeploy-plugin-appimage.AppImage",
            "elf",
            False,
        ),
    )


def looks_like(kind, data):
    if kind == "elf":
        return data.startswith(b"\x7fELF")
    if kind == "script":
        return data.startswith(b"#!")
    raise FetchError(f"unknown tool kind {kind}")


def prefix(path, size):
    with path.open("rb") as handle:
        return handle.read(size)


def install_bytes(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".partial")
    temporary.write_bytes(data)
    if mode is not None:
        temporary.chmod(mode)
    temporary.replace(path)


def present(directory, names):
    return all((directory / name).is_file() for name in names)


def remove_tree(path):
    if path.exists():
        shutil.rmtree(path)


def prefetch_windows(root, opener, sleep):
    written = []
    wix = root / "WixTools314"
    if not present(wix, WIX_REQUIRED):
        data = download(WIX_URL, opener, sleep=sleep)
        require_hash(data, "sha256", WIX_SHA256)
        remove_tree(wix)
        safe_extract(data, wix)
        if not present(wix, WIX_REQUIRED):
            raise FetchError("wix archive is missing required tools")
        written.append(wix)
    nsis = root / "NSIS"
    if not present(nsis, NSIS_REQUIRED):
        data = download(NSIS_URL, opener, sleep=sleep)
        require_hash(data, "sha1", NSIS_SHA1)
        staging = root / ".nsis-staging"
        remove_tree(staging)
        safe_extract(data, staging)
        source = staging / NSIS_ROOT
        if not source.is_dir():
            raise FetchError("nsis archive is missing nsis-3.11")
        remove_tree(nsis)
        source.replace(nsis)
        remove_tree(staging)
        if not present(nsis, NSIS_REQUIRED):
            raise FetchError("nsis archive is missing required tools")
        written.append(nsis)
    dll_path = nsis / NSIS_DLL_REL
    if not dll_path.is_file() or digest(dll_path.read_bytes(), "sha1") != NSIS_DLL_SHA1:
        data = download(NSIS_DLL_URL, opener, sleep=sleep)
        require_hash(data, "sha1", NSIS_DLL_SHA1)
        install_bytes(dll_path, data, None)
        written.append(dll_path)
    if not present(nsis, NSIS_REQUIRED) or not dll_path.is_file():
        raise FetchError("windows bundler cache is incomplete")
    return written


def prefetch_linux(root, target, opener, sleep):
    arch = linux_arch(target)
    root.mkdir(parents=True, exist_ok=True)
    written = []
    for url, name, kind, required in linux_tools(arch):
        dest = root / name
        marker = 4 if kind == "elf" else 2
        if dest.is_file() and looks_like(kind, prefix(dest, marker)):
            dest.chmod(EXECUTABLE)
            continue
        try:
            data = download(url, opener, sleep=sleep)
        except FetchError:
            if required:
                raise
            continue
        if not looks_like(kind, data):
            if required:
                raise FetchError(f"{name} failed validation")
            continue
        install_bytes(dest, data, EXECUTABLE)
        written.append(dest)
    return written


def prefetch(os_name, target, env, home, opener, sleep=time.sleep):
    root = tools_dir(os_name, env, home)
    if root is None:
        return []
    if os_name == "Windows":
        return prefetch_windows(root, opener, sleep)
    if os_name == "Linux":
        return prefetch_linux(root, target, opener, sleep)
    raise FetchError(f"unsupported OS {os_name}")


def main():
    os_name = os.environ.get("PREFETCH_OS") or {"linux": "Linux", "win32": "Windows", "darwin": "macOS"}.get(sys.platform, "")
    target = os.environ.get("PREFETCH_TARGET", "")
    written = prefetch(os_name, target, os.environ, Path.home(), default_opener())
    if os_name == "macOS":
        print("prefetch skipped on macOS")
    else:
        print(f"prefetch ready ({len(written)} updated)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except FetchError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        raise SystemExit(1)
