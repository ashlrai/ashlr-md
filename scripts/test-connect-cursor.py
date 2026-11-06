#!/usr/bin/env python3
"""Tests for scripts/connect-cursor.py. No network and no real home directory."""

from __future__ import annotations

import json
import stat
import tempfile
import unittest
from pathlib import Path

from importlib.machinery import SourceFileLoader


ROOT = Path(__file__).resolve().parents[1]
connect_cursor = SourceFileLoader(
    "connect_cursor", str(ROOT / "scripts" / "connect-cursor.py")
).load_module()


class ConnectCursorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="md-cursor-")
        self.home = Path(self.tmp.name)
        self.bin = self.home / "bin" / "mdopener-mcp"
        self.bin.parent.mkdir()
        self.bin.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        self.bin.chmod(self.bin.stat().st_mode | stat.S_IEXEC)
        self.which = lambda name: str(self.bin) if name == "mdopener-mcp" else None

    def tearDown(self):
        self.tmp.cleanup()

    def cfg_path(self):
        return self.home / ".cursor" / "mcp.json"

    def test_creates_config_when_missing(self):
        written = connect_cursor.connect(self.home, self.which)
        self.assertEqual(written, str(self.cfg_path()))
        data = json.loads(self.cfg_path().read_text(encoding="utf-8"))
        self.assertEqual(data["mcpServers"]["ashlr-md"]["command"], str(self.bin))
        self.assertEqual(data["mcpServers"]["ashlr-md"]["args"], [])

    def test_keeps_other_servers(self):
        self.cfg_path().parent.mkdir()
        self.cfg_path().write_text(
            json.dumps({"mcpServers": {"other": {"command": "other"}}}) + "\n",
            encoding="utf-8",
        )
        connect_cursor.connect(self.home, self.which)
        data = json.loads(self.cfg_path().read_text(encoding="utf-8"))
        self.assertEqual(data["mcpServers"]["other"]["command"], "other")
        self.assertEqual(data["mcpServers"]["ashlr-md"]["command"], str(self.bin))

    def test_invalid_json_is_left_unchanged(self):
        self.cfg_path().parent.mkdir()
        original = "{ not json\n"
        self.cfg_path().write_text(original, encoding="utf-8")
        with self.assertRaises(SystemExit):
            connect_cursor.connect(self.home, self.which)
        self.assertEqual(self.cfg_path().read_text(encoding="utf-8"), original)

    def test_existing_other_binary_is_left_in_place(self):
        other = self.home / "bin" / "custom-mcp"
        other.write_text("#!/bin/sh\n", encoding="utf-8")
        self.cfg_path().parent.mkdir()
        original = json.dumps({"mcpServers": {"ashlr-md": {"command": str(other)}}}) + "\n"
        self.cfg_path().write_text(original, encoding="utf-8")
        with self.assertRaises(SystemExit):
            connect_cursor.connect(self.home, self.which)
        self.assertEqual(self.cfg_path().read_text(encoding="utf-8"), original)

    def test_missing_old_binary_is_replaced(self):
        self.cfg_path().parent.mkdir()
        self.cfg_path().write_text(
            json.dumps({"mcpServers": {"ashlr-md": {"command": "/missing/mdopener-mcp"}}}) + "\n",
            encoding="utf-8",
        )
        connect_cursor.connect(self.home, self.which)
        data = json.loads(self.cfg_path().read_text(encoding="utf-8"))
        self.assertEqual(data["mcpServers"]["ashlr-md"]["command"], str(self.bin))

    def test_missing_cli_writes_nothing(self):
        with self.assertRaises(SystemExit):
            connect_cursor.connect(self.home, lambda _name: None)
        self.assertFalse(self.cfg_path().exists())


if __name__ == "__main__":
    unittest.main()
