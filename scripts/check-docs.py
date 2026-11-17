#!/usr/bin/env python3
"""Source-only documentation contracts. Run from any directory with Python 3."""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# A long flag such as --json; not a dash inside a word, and not a bare `--` separator.
FLAG = re.compile(r'(?<![\w-])--[a-z][a-z-]*')


def tool_names(source):
    registry = source.split('pub fn tool_registry()', 1)[1].split('\n///', 1)[0]
    names = re.findall(r'^\s+name: "([a-z_]+)",', registry, re.M)
    if not names:
        raise ValueError('No tools found in tool_registry()')
    return names


def tool_rows(guide):
    section = guide.split('## MCP tool reference', 1)[1].split('## Resources reference', 1)[0]
    return re.findall(r'^\| `([a-z_]+)` \|', section, re.M)


def help_command_keys(help_text):
    """Command keys from the mdopener-mcp HELP usage lines.

    "mdopener-mcp doctor --fix [--apply]" becomes "doctor --fix", the bare
    "mdopener-mcp" line (serve on stdio) becomes "serve".
    """
    keys = []
    for line in help_text.splitlines():
        if not line.startswith('    mdopener-mcp'):
            continue
        command = re.split(r' {2,}', line.strip())[0]
        keys.append(command_key(command))
    return keys


def command_key(command):
    command = command.replace('`', '').strip()
    command = re.sub(r'^mdopener-mcp\s*', '', command)
    command = command.split('[', 1)[0].strip()
    return command or 'serve'


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

    def test_readme_flags_match_help(self):
        # Long flags from both CLIs' HELP text must equal the flags in the README's
        # "Commands and flags" section: no undocumented flag, no flag that does not exist.
        # The register example after HELP's "Register it" line is not a flag of ours.
        flags = set()
        for path in ('src-tauri/bins/mdopen/src/main.rs', 'src-tauri/bins/mdopener-mcp/src/main.rs'):
            source = (ROOT / path).read_text(encoding="utf-8")
            help_text = source.split('const HELP: &str = "', 1)[1].split('";\n', 1)[0]
            help_text = re.split(r'\nRegister it with', help_text, maxsplit=1)[0]
            flags.update(FLAG.findall(help_text))
        readme = (ROOT / 'README.md').read_text(encoding="utf-8")
        section = readme.split('## Commands and flags', 1)[1].split('\n## ', 1)[0]
        self.assertGreaterEqual(len(flags), 10)
        self.assertEqual(set(FLAG.findall(section)), flags)

    def test_readme_lists_every_cli_command(self):
        # Every mdopener-mcp command in HELP must have a row in the README's
        # "Commands and flags" table, and the table must not list one HELP lacks.
        main = (ROOT / 'src-tauri/bins/mdopener-mcp/src/main.rs').read_text(encoding="utf-8")
        help_text = main.split('const HELP: &str = "', 1)[1].split('\n";', 1)[0]
        source = help_command_keys(help_text)
        self.assertIn('serve', source)
        self.assertIn('doctor --fix', source)
        readme = (ROOT / 'README.md').read_text(encoding="utf-8")
        section = readme.split('## Commands and flags', 1)[1].split('\n## ', 1)[0]
        table = section.split('**`mdopener-mcp`**', 1)[1].split('Other arguments', 1)[0]
        rows = re.findall(r'^\| (`[^|]+?) \|', table, re.M)
        documented = []
        for cell in rows:
            for span in re.findall(r'`([^`]+)`', cell):
                for part in span.split(', '):
                    documented.append(command_key(part))
        self.assertCountEqual(documented, source)

    def test_readme_lists_every_mcp_tool(self):
        # Each tool in tool_registry() must appear in the README's "MCP tools"
        # table in the same order, and the table must not name a removed tool.
        names = tool_names(self.server)
        readme = (ROOT / 'README.md').read_text(encoding="utf-8")
        section = readme.split('## MCP tools', 1)[1].split('\n## ', 1)[0]
        self.assertEqual(re.findall(r'^\| `([a-z_]+)` \|', section, re.M), names)

    def test_drift_check_detects_missing_and_extra_entries(self):
        names = tool_names(self.server)
        readme = (ROOT / 'README.md').read_text(encoding="utf-8")
        section = readme.split('## MCP tools', 1)[1].split('\n## ', 1)[0]
        rows = re.findall(r'^\| `[a-z_]+` \|.*$', section, re.M)
        for changed in (rows[:-1], rows + ['| `obsolete_tool` | Gone |']):
            with self.subTest(rows=len(changed)):
                found = re.findall(r'^\| `([a-z_]+)` \|', '\n'.join(changed), re.M)
                self.assertNotEqual(found, names)

    def test_get_started_has_five_steps_or_fewer(self):
        readme = (ROOT / 'README.md').read_text(encoding="utf-8")
        section = readme.split('## Get started', 1)[1].split('\n## ', 1)[0]
        steps = re.findall(r'^\d+\. \*\*', section, re.M)
        self.assertGreaterEqual(len(steps), 1)
        self.assertLessEqual(len(steps), 5)
        self.assertIn('You should see', section)

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
