#!/usr/bin/env python3
"""Source-only MCP setup checks; never run the installer or agent CLIs.

Compiles only the dependency-free command formatter and sidecar path lookup.
Installer branch fixtures evaluate only its sidecar-build section, with all build commands mocked and an
isolated, empty PATH. No app, Swift build, or MCP registration is executed.
"""

import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class CommandTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix="md-mcp-command-")
        cls.directory = Path(cls.scratch.name)
        module = ROOT / "src-tauri/src/mcp_command.rs"
        unit = cls.directory / "formatter-tests"
        subprocess.run(["rustc", "--test", str(module), "-o", str(unit)], check=True)
        subprocess.run([str(unit)], check=True)
        wrapper = cls.directory / "formatter.rs"
        wrapper.write_text(
            f"#[path = {json.dumps(str(module))}] mod mcp_command;\n"
            "fn main() { println!(\"{}\", mcp_command::mcp_command(&std::env::args().nth(1).unwrap())); }\n"
        )
        cls.binary = cls.directory / "formatter"
        subprocess.run(["rustc", str(wrapper), "-o", str(cls.binary)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    @unittest.skipIf(os.name == "nt", "POSIX independent tokenizer")
    def test_actual_formatter_round_trips_paths_without_shell_execution(self):
        for path in [
            "/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp",
            "/tmp/O'Brien/文档/mdopener-mcp",
            "/tmp/$HOME/`whoami`/$(id)/mdopener-mcp",
            '/tmp/"double quotes"/mdopener-mcp',
            "/tmp/semi;colon & pipe|/mdopener-mcp",
            "/tmp/back\\slash/line\nbreak/mdopener-mcp",
        ]:
            with self.subTest(path=path):
                command = subprocess.check_output([str(self.binary), path], text=True).removesuffix("\n")
                self.assertEqual(shlex.split(command), ["claude", "mcp", "add", "--scope", "user", "ashlr-md", path])

    def test_runtime_and_ui_fallback_use_same_quoted_user_scope(self):
        agent = (ROOT / "src-tauri/src/agent_setup.rs").read_text()
        self.assertIn("mcp_command::mcp_command(&path)", agent)
        path = "/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp"
        expected = f"claude mcp add --scope user ashlr-md '{path}'"
        self.assertIn(expected, (ROOT / "src/components/settings/sections/McpSection.tsx").read_text())


class SidecarPathTests(unittest.TestCase):
    def test_resolver_unit_tests_cover_declared_windows_resource_names(self):
        # Pure std-only module: fixture files live in a temporary directory and
        # are never executed. Its tests also read the tauri.*.conf.json overlays.
        # Tauri-only entry points are unused in this standalone test binary.
        module = ROOT / "src-tauri/src/sidecar_path.rs"
        with tempfile.TemporaryDirectory(prefix="md-sidecar-path-") as directory:
            unit = Path(directory) / "sidecar-path-tests"
            subprocess.run(["rustc", "--edition", "2021", "-A", "dead_code", "--test", str(module), "-o", str(unit)], check=True)
            subprocess.run([str(unit)], check=True)

    def test_agent_setup_resolves_through_suffix_aware_module(self):
        agent = (ROOT / "src-tauri/src/agent_setup.rs").read_text()
        self.assertIn("sidecar_path::resolve(bin, exe_dir, resource_dir.as_deref())", agent)
        self.assertIn("sidecar_path::unresolved_mcp_placeholder()", agent)
        self.assertNotIn('exe_dir.join(bin)', agent)
        self.assertNotIn('resource_dir.join(bin)', agent)


class InstallerTests(unittest.TestCase):
    def fixture(self, os_name, skip, resources):
        source = (ROOT / "scripts/install.sh").read_text()
        start = source.index('if [[ "$(uname -s)" == "Darwin" && "$SKIP_APP_BUILD" != "1" ]]')
        section = source[start:source.index('\nMCP_BIN=', start)]
        with tempfile.TemporaryDirectory(prefix="md-sidecar-fixture-") as directory:
            target = Path(directory) / "src-tauri/target/release"
            target.mkdir(parents=True)
            for name in resources:
                (target / name).write_text("synthetic fixture; never executable")
            # These functions replace every external command in this small
            # section. The build helper and installer are never executed.
            mocks = """
uname() { printf '%s\\n' "$MOCK_OS"; }
bash() { printf 'MOCK helper: %s\\n' "$*"; }
cargo() { printf 'MOCK cargo: %s\\n' "$*"; }
info() { :; }
die() { printf '%s\\n' "$*" >&2; exit 77; }
"""
            return subprocess.run(
                ["/bin/bash", "--noprofile", "--norc", "-c", "set -euo pipefail\n" + mocks + section],
                cwd=directory,
                env={"PATH": "/nonexistent", "HOME": directory, "MOCK_OS": os_name, "SKIP_APP_BUILD": skip},
                capture_output=True,
                text=True,
            )

    def test_full_macos_requires_afm_with_actionable_guidance(self):
        result = self.fixture("Darwin", "0", [])
        self.assertEqual(result.returncode, 77)
        self.assertIn("Xcode 26 / Swift 6.2+", result.stderr)
        self.assertIn("bash src-tauri/bins/mdopener-afm/build.sh", result.stderr)
        self.assertIn("SKIP_APP_BUILD=1", result.stderr)
        self.assertIn("MOCK helper: scripts/build-sidecars.sh", result.stdout)

    def test_full_macos_requires_setdefault_after_afm(self):
        result = self.fixture("Darwin", "0", ["mdopener-afm"])
        self.assertEqual(result.returncode, 77)
        self.assertIn("bash src-tauri/bins/mdopener-setdefault/build.sh", result.stderr)

    def test_full_macos_uses_existing_helper_when_resources_exist(self):
        result = self.fixture("Darwin", "0", ["mdopener-afm", "mdopener-setdefault"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("MOCK helper: scripts/build-sidecars.sh", result.stdout)
        self.assertNotIn("MOCK cargo:", result.stdout)

    def test_cli_only_and_nonmacos_keep_rust_only_flow(self):
        for os_name, skip in [("Darwin", "1"), ("Linux", "0")]:
            with self.subTest(os_name=os_name, skip=skip):
                result = self.fixture(os_name, skip, [])
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("MOCK cargo: build --release --manifest-path src-tauri/Cargo.toml -p mdopen -p mdopener-mcp", result.stdout)
                self.assertNotIn("MOCK helper:", result.stdout)

    def test_guards_cover_declared_mac_resources_without_stubs(self):
        config = json.loads((ROOT / "src-tauri/tauri.macos.conf.json").read_text())
        self.assertEqual(set(config["bundle"]["resources"]), {
            "target/release/mdopen", "target/release/mdopener-mcp",
            "target/release/mdopener-afm", "target/release/mdopener-setdefault",
        })
        source = (ROOT / "scripts/install.sh").read_text()
        self.assertLess(source.index('[[ -f "src-tauri/target/release/mdopener-afm" ]]'), source.index("bun run tauri build\n"))
        self.assertLess(source.index('[[ -f "src-tauri/target/release/mdopener-setdefault" ]]'), source.index("bun run tauri build\n"))


if __name__ == "__main__":
    unittest.main()
