#!/usr/bin/env python3
"""Merge the ashlr-md MCP server into Cursor's user mcp.json.

Finds mdopener-mcp on PATH. Creates ~/.cursor/mcp.json when it is missing.
Leaves the file untouched when it is not a JSON object, when mcpServers is
not an object, or when ashlr-md already points at a different program that
still exists.
"""

from __future__ import annotations

import json
import shutil
import sys
from collections.abc import Callable
from pathlib import Path

Which = Callable[[str], str | None]


def connect(home: Path, which: Which = shutil.which) -> str:
    command = which("mdopener-mcp")
    if not command:
        raise SystemExit(
            "mdopener-mcp is not on PATH. From a checkout run: "
            "SKIP_APP_BUILD=1 bash scripts/install.sh"
        )
    path = home / ".cursor" / "mcp.json"
    cfg: object = {}
    if path.exists():
        raw = path.read_text(encoding="utf-8")
        try:
            cfg = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise SystemExit(
                f"{path} is not JSON ({exc}). Fix the file, then run this script again."
            ) from exc
    if not isinstance(cfg, dict):
        raise SystemExit(f"{path} must be a JSON object. Nothing was written.")
    servers = cfg.get("mcpServers", {})
    if not isinstance(servers, dict):
        raise SystemExit(f"{path} key mcpServers must be a JSON object. Nothing was written.")
    existing = servers.get("ashlr-md")
    if isinstance(existing, dict):
        old = existing.get("command")
        if isinstance(old, str) and old and old != command and Path(old).exists():
            raise SystemExit(
                f"ashlr-md already runs {old}, which exists. "
                "Remove that entry, then run this script again. Nothing was written."
            )
    servers["ashlr-md"] = {"command": command, "args": []}
    cfg["mcpServers"] = servers
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    return str(path)


def main() -> None:
    print(connect(Path.home()))


if __name__ == "__main__":
    sys.exit(main())
