#!/usr/bin/env python3
"""Source-only MCP setup checks; never run the installer or agent CLIs.

Compiles only the dependency-free command formatters, sidecar path lookup and
agent CLI PATH search.
Installer branch fixtures evaluate only its sidecar-build section, with all build commands mocked and an
isolated, empty PATH, and its mdopen-link section, with `ln` mocked and HOME in a temp dir. No app, Swift build, or MCP registration is executed.
"""

import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


def run_rust_tests(module, binary):
    subprocess.run([
        "rustc", "--edition", "2021", "-A", "dead_code", "--test",
        str(module), "-o", str(binary),
    ], check=True)
    subprocess.run([str(binary)], check=True)


class CommandTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix="md-mcp-command-")
        cls.addClassCleanup(cls.scratch.cleanup)
        cls.directory = Path(cls.scratch.name)
        module = ROOT / "src-tauri/src/mcp_command.rs"
        unit = cls.directory / "formatter-tests"
        run_rust_tests(module, unit)
        wrapper = cls.directory / "formatter.rs"
        wrapper.write_text(
            f"#[path = {json.dumps(str(module))}] mod mcp_command;\n"
            "fn main() {\n"
            "    let args: Vec<String> = std::env::args().collect();\n"
            "    if args[1] == \"--hook\" { println!(\"{}\", mcp_command::hook_command(&args[2])); }\n"
            "    else { println!(\"{}\", mcp_command::mcp_command(&args[1])); }\n"
            "}\n"
        )
        cls.binary = cls.directory / "formatter"
        subprocess.run(["rustc", str(wrapper), "-o", str(cls.binary)], check=True)

    @unittest.skipIf(os.name == "nt", "POSIX independent tokenizer")
    def test_actual_formatter_round_trips_paths_without_shell_execution(self):
        # Hostile path components hang off the per-test TemporaryDirectory
        # (mode 0700) — never a hard-coded publicly writable dir.
        base = str(self.directory)
        for path in [
            "/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp",
            f"{base}/O'Brien/文档/mdopener-mcp",
            f"{base}/$HOME/`whoami`/$(id)/mdopener-mcp",
            f'{base}/"double quotes"/mdopener-mcp',
            f"{base}/semi;colon & pipe|/mdopener-mcp",
            f"{base}/back\\slash/line\nbreak/mdopener-mcp",
        ]:
            with self.subTest(path=path):
                command = subprocess.check_output([str(self.binary), path], text=True).removesuffix("\n")
                self.assertEqual(shlex.split(command), ["claude", "mcp", "add", "--scope", "user", "ashlr-md", path])

    @unittest.skipIf(os.name == "nt", "POSIX independent tokenizer")
    def test_actual_hook_command_round_trips_paths_without_shell_execution(self):
        base = str(self.directory)
        for path in [
            "/Applications/Ashlr MD.app/Contents/Resources/mdopen",
            f"{base}/O'Brien/$HOME/`whoami`/$(id)/mdopen",
            "C:\\Users\\me\\AppData\\Local\\Ashlr MD\\mdopen.exe",
        ]:
            with self.subTest(path=path):
                command = subprocess.check_output([str(self.binary), "--hook", path], text=True).removesuffix("\n")
                self.assertEqual(shlex.split(command), [path, "--hook"])

    def test_hook_installer_writes_the_quoted_command(self):
        agent = (ROOT / "src-tauri/src/agent_setup.rs").read_text()
        self.assertIn("mcp_command::hook_command(mdopen)", agent)
        self.assertNotIn('format!("{mdopen} --hook")', agent)

    def test_runtime_and_ui_fallback_use_same_quoted_user_scope(self):
        agent = (ROOT / "src-tauri/src/agent_setup.rs").read_text()
        self.assertIn("mcp_command::mcp_command(&path)", agent)
        path = "/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp"
        expected = f"claude mcp add --scope user ashlr-md '{path}'"
        self.assertIn(expected, (ROOT / "src/components/settings/sections/McpSection.tsx").read_text())


class AgentCliPathTests(unittest.TestCase):
    def test_path_search_unit_tests_cover_pathext_and_execute_bits(self):
        # Pure std-only module: fixtures are synthetic files that are never run.
        module = ROOT / "src-tauri/src/path_search.rs"
        with tempfile.TemporaryDirectory(prefix="md-path-search-") as directory:
            unit = Path(directory) / "path-search-tests"
            run_rust_tests(module, unit)

    def test_detection_and_connect_no_longer_shell_out_to_which(self):
        agent = (ROOT / "src-tauri/src/agent_setup.rs").read_text()
        self.assertNotIn('Command::new("which")', agent)
        self.assertIn('Command::new(agent_cli_program(program))', agent)
        for name in ("CLAUDE", "CODEX"):
            self.assertIn(f'run_agent_cli({name}_CLI.program, args)', agent)
            self.assertRegex(agent, rf'const {name}_CLI: AgentCli = AgentCli \{{[^}}]*program: "{name.lower()}"')

    def test_cli_install_uses_the_suffix_aware_lookup(self):
        source = (ROOT / "src-tauri/src/cli_install.rs").read_text()
        self.assertIn('resolve_sidecar_binary(&app, "mdopen")', source)
        self.assertIn('sidecar_file_name("mdopen")', source)
        self.assertNotIn('resource_dir.join("mdopen")', source)
        self.assertNotIn('dir.join("mdopen")', source)


class SidecarPathTests(unittest.TestCase):
    def test_resolver_unit_tests_cover_declared_windows_resource_names(self):
        # Pure std-only module: fixture files live in a temporary directory and
        # are never executed. Its tests also read the tauri.*.conf.json overlays.
        # Tauri-only entry points are unused in this standalone test binary.
        module = ROOT / "src-tauri/src/sidecar_path.rs"
        with tempfile.TemporaryDirectory(prefix="md-sidecar-path-") as directory:
            unit = Path(directory) / "sidecar-path-tests"
            run_rust_tests(module, unit)

    def test_agent_setup_resolves_through_suffix_aware_module(self):
        agent = (ROOT / "src-tauri/src/agent_setup.rs").read_text()
        self.assertRegex(agent, r"sidecar_path::resolve\(\s*bin,\s*exe_dir,\s*resource_dir.as_deref\(\),?\s*\)")
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


class AppInstallTests(unittest.TestCase):
    """Evaluates only the installer's app build/install section, with `bun`,
    `find`, `head`, `rm`, `cp` and `uname` mocked; nothing is built or copied."""

    def run_section(self, os_name, skip):
        source = (ROOT / "scripts/install.sh").read_text()
        start = source.index('APP_BINARY="$MCP_BIN"')
        section = source[start:source.index("# ── 6.", start)]
        with tempfile.TemporaryDirectory(prefix="md-app-install-") as directory:
            mocks = """
uname() { printf '%s\\n' "$MOCK_OS"; }
bun() { printf 'MOCK bun: %s\\n' "$*"; }
find() { printf '%s\\n' "$REPO_ROOT/src-tauri/target/release/bundle/macos/Ashlr MD.app"; }
head() { local line; IFS= read -r line && printf '%s\\n' "$line"; }
rm() { :; }
cp() { printf 'MOCK cp: %s\\n' "$*"; }
info() { :; }
success() { :; }
warn() { printf 'WARN %s\\n' "$*"; }
die() { printf '%s\\n' "$*" >&2; exit 77; }
"""
            tail = '\nprintf "APP_BINARY=%s\\n" "$APP_BINARY"\n'
            return subprocess.run(
                ["/bin/bash", "--noprofile", "--norc", "-c", "set -euo pipefail\n" + mocks + section + tail],
                cwd=directory,
                env={"PATH": "/nonexistent", "HOME": directory, "MOCK_OS": os_name,
                     "SKIP_APP_BUILD": skip, "MCP_BIN": "/repo/mdopener-mcp",
                     "REPO_ROOT": "/repo", "INSTALL_DIR": directory},
                capture_output=True,
                text=True,
            )

    def test_non_macos_installs_cli_and_mcp_only_without_building_the_app(self):
        result = self.run_section("Linux", "0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("MOCK bun:", result.stdout)
        self.assertIn("macOS-only", result.stdout)
        self.assertIn("releases/latest", result.stdout)
        self.assertIn("APP_BINARY=/repo/mdopener-mcp", result.stdout)

    def test_macos_builds_and_registers_the_installed_app(self):
        result = self.run_section("Darwin", "0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("MOCK bun: run tauri build", result.stdout)
        self.assertIn("Ashlr MD.app/Contents/Resources/mdopener-mcp", result.stdout)


class CliLinkTests(unittest.TestCase):
    """Evaluates only the installer's mdopen-link section; `ln` is mocked to
    refuse the first directory, as a root-owned /usr/local/bin does."""

    def run_section(self, blocked):
        source = (ROOT / "scripts/install.sh").read_text()
        start = source.index("install_cli_to() {")
        section = source[start:source.index("# ── 7.", start)]
        with tempfile.TemporaryDirectory(prefix="md-cli-link-") as directory:
            cli = Path(directory) / "cli-bin"
            cli.mkdir()
            mocks = """
success() { printf 'OK %s\\n' "$*"; }
warn() { printf 'WARN %s\\n' "$*"; }
ln() {
  if [[ -n "$BLOCKED" && "$3" == "$BLOCKED"/* ]]; then
    echo "ln: $3: Permission denied" >&2; return 1
  fi
  printf 'LINK %s\\n' "$3"
}
"""
            env = {"PATH": "/usr/bin:/bin", "HOME": directory, "CLI_BIN_DIR": str(cli),
                   "MDOPEN_BIN": "/synthetic/mdopen", "BLOCKED": str(cli) if blocked else ""}
            result = subprocess.run(
                ["/bin/bash", "--noprofile", "--norc", "-c", "set -euo pipefail\n" + mocks + section],
                cwd=directory, env=env, capture_output=True, text=True,
            )
            return result, cli, Path(directory) / ".local/bin"

    def test_unwritable_existing_dir_falls_back_to_local_bin(self):
        result, cli, local = self.run_section(blocked=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(f"OK mdopen → {cli}/mdopen", result.stdout)
        self.assertIn(f"LINK {local}/mdopen", result.stdout)
        self.assertIn(f"OK mdopen → {local}/mdopen", result.stdout)

    def test_writable_dir_is_used_without_fallback(self):
        result, cli, local = self.run_section(blocked=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"OK mdopen → {cli}/mdopen", result.stdout)
        self.assertNotIn(str(local), result.stdout)


if __name__ == "__main__":
    unittest.main()
