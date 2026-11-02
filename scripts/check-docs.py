#!/usr/bin/env python3
"""Source-only documentation contracts. Run from any directory with Python 3."""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def tool_names(source):
    registry = source.split('pub fn tool_registry()', 1)[1].split('\n///', 1)[0]
    names = re.findall(r'^\s+name: "([a-z_]+)",', registry, re.M)
    if not names:
        raise ValueError('No tools found in tool_registry()')
    return names


def tool_rows(guide):
    section = guide.split('## MCP tool reference', 1)[1].split('## Resources reference', 1)[0]
    return re.findall(r'^\| `([a-z_]+)` \|', section, re.M)


class DocumentationContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.guide = (ROOT / 'docs/AGENTS.md').read_text(encoding="utf-8")
        cls.server = (ROOT / 'src-tauri/bins/mdopener-mcp/src/lib.rs').read_text(encoding="utf-8")

    def test_tool_catalog_and_order(self):
        names = tool_names(self.server)
        self.assertEqual(tool_rows(self.guide), names)
        self.assertIn(f'exposes **{len(names)}** tools', self.guide)

    def test_detects_missing_extra_duplicate_and_reordered_tools(self):
        rows = re.findall(r'^\| `[a-z_]+` \|.*$', self.guide, re.M)[:len(tool_names(self.server))]
        table = '\n'.join(rows)
        for changed in (rows[:-1], rows + [rows[0]], rows[::-1],
                        [row.replace('`open_file`', '`obsolete_tool`') for row in rows]):
            with self.subTest(table=changed):
                mutated = self.guide.replace(table, '\n'.join(changed))
                self.assertNotEqual(tool_rows(mutated), tool_names(self.server))

    def test_cli_usage_matches_help(self):
        main = (ROOT / 'src-tauri/bins/mdopener-mcp/src/main.rs').read_text(encoding="utf-8")
        help_text = main.split('const HELP: &str = "', 1)[1].split('\nOther arguments', 1)[0]
        commands = []
        for line in help_text.splitlines():
            if line.startswith('    mdopener-mcp '):
                command = re.split(r' {2,}', line.strip())[0]
                if command != 'mdopener-mcp':
                    commands.append(command)
        self.assertGreaterEqual(len(commands), 6)
        section = self.guide.split('## The `mdopener-mcp` CLI', 1)[1].split('### Frontend', 1)[0]
        documented = re.findall(r'^(mdopener-mcp .+)$', section, re.M)
        self.assertCountEqual(documented, commands)

    def test_frontend_event_inventory(self):
        actual = []
        for path in sorted((ROOT / 'src/mcp/handlers').glob('*.ts')):
            actual += [(event, path.name) for event in re.findall(
                r'return listen<[^>]+>\("(mcp://[^\"]+)"', path.read_text(encoding="utf-8"))]
        self.assertGreater(len(actual), 0)
        documented = re.findall(r'^\| `(mcp://[^`]+)` \| `([^`]+)` \|', self.guide, re.M)
        self.assertCountEqual(documented, actual)
        bridge = (ROOT / 'src/mcp/bridge.ts').read_text(encoding="utf-8").split(' * ## Architecture', 1)[0]
        self.assertCountEqual(re.findall(r'^ \*     - `(mcp://[^`]+)`', bridge, re.M),
                              [event for event, _ in actual])

    def test_one_click_setup_matches_buttons(self):
        ui = (ROOT / 'src/components/settings/sections/McpSection.tsx').read_text(encoding="utf-8")
        buttons = re.findall(r'^\s+(Connect to [^<\n]+)\n\s*</button>', ui, re.M)
        self.assertGreater(len(buttons), 0)
        readme = (ROOT / 'README.md').read_text(encoding="utf-8")
        section = readme.split('## One-click agent setup', 1)[1].split('## Download', 1)[0]
        self.assertCountEqual(re.findall(r'\*\*(Connect to [^*]+)\*\*', section), buttons)
        for button in buttons:
            self.assertIn(f'**{button}**', self.guide)

    def test_readme_quality_commands_exist(self):
        scripts = json.loads((ROOT / 'package.json').read_text(encoding="utf-8"))['scripts']
        readme = (ROOT / 'README.md').read_text(encoding="utf-8")
        for command in re.findall(r'^bun run ([a-z:-]+)\b', readme, re.M):
            with self.subTest(command=command):
                self.assertIn(command, scripts)


if __name__ == '__main__':
    unittest.main()
