#!/usr/bin/env python3
import importlib.util
import io
import os
import stat
import subprocess
import tempfile
import unittest
import urllib.error
import zipfile
from email.message import Message
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "prefetch_tauri_bundler_tools",
    ROOT / "scripts/ci/prefetch-tauri-bundler-tools.py",
)
prefetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prefetch)


class Response:
    def __init__(self, data, status=200):
        self.data = data
        self.status = status

    def read(self, _limit=-1):
        return self.data

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class Opener:
    def __init__(self, script):
        self.script = list(script)
        self.urls = []

    def open(self, request, timeout=None):
        self.urls.append(request.full_url)
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def http_status(url, status):
    return urllib.error.HTTPError(url, status, "status", Message(), None)


def zip_bytes(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


def wix_zip():
    return zip_bytes({name: b"tool-" + name.encode() for name in prefetch.WIX_REQUIRED})


def nsis_zip():
    files = {f"{prefetch.NSIS_ROOT}/{name}": b"nsis-" + name.encode() for name in prefetch.NSIS_REQUIRED}
    return zip_bytes(files)


class PrefetchTests(unittest.TestCase):
    def test_cli_pin_matches_the_lockfile(self):
        lock = (ROOT / "bun.lock").read_text()
        self.assertIn(f'"@tauri-apps/cli@{prefetch.CLI_VERSION}"', lock)

    def test_refuses_non_https_before_any_request(self):
        opener = Opener([])
        with self.assertRaises(prefetch.FetchError):
            prefetch.download("http://example.test/tool", opener)
        self.assertEqual(opener.urls, [])

    def test_retries_gateway_timeout_then_checks_the_hash(self):
        payload = b"signed-bytes"
        opener = Opener([
            http_status("https://example.test/a", 504),
            http_status("https://example.test/a", 504),
            Response(payload),
        ])
        sleeps = []
        data = prefetch.download(
            "https://example.test/a",
            opener,
            sleep=lambda seconds: sleeps.append(seconds),
        )
        self.assertEqual(data, payload)
        self.assertEqual(sleeps, [1, 2])
        prefetch.require_hash(payload, "sha256", prefetch.digest(payload, "sha256"))
        with self.assertRaises(prefetch.FetchError):
            prefetch.require_hash(payload, "sha256", "0" * 64)

    def test_hash_mismatch_does_not_leave_a_wix_tool(self):
        opener = Opener([Response(wix_zip())])
        with tempfile.TemporaryDirectory() as directory:
            env = {"LOCALAPPDATA": directory}
            with self.assertRaises(prefetch.FetchError):
                prefetch.prefetch("Windows", "", env, Path(directory), opener, sleep=lambda _s: None)
            self.assertFalse((Path(directory) / "tauri" / "WixTools314" / "candle.exe").exists())

    def test_windows_cache_matches_the_bundler_layout(self):
        dll = b"dll-bytes"
        wix = wix_zip()
        nsis = nsis_zip()
        opener = Opener([Response(wix), Response(nsis), Response(dll)])
        real_wix = prefetch.WIX_SHA256
        real_nsis = prefetch.NSIS_SHA1
        real_dll = prefetch.NSIS_DLL_SHA1
        prefetch.WIX_SHA256 = prefetch.digest(wix, "sha256")
        prefetch.NSIS_SHA1 = prefetch.digest(nsis, "sha1")
        prefetch.NSIS_DLL_SHA1 = prefetch.digest(dll, "sha1")
        try:
            with tempfile.TemporaryDirectory() as directory:
                written = prefetch.prefetch("Windows", "", {"LOCALAPPDATA": directory}, Path(directory), opener, sleep=lambda _s: None)
                root = Path(directory) / "tauri"
                self.assertTrue((root / "WixTools314" / "candle.exe").is_file())
                self.assertTrue((root / "NSIS" / "Bin" / "makensis.exe").is_file())
                dll_path = root / "NSIS" / prefetch.NSIS_DLL_REL
                self.assertEqual(dll_path.read_bytes(), dll)
                self.assertTrue(written)
                again = prefetch.prefetch("Windows", "", {"LOCALAPPDATA": directory}, Path(directory), Opener([]), sleep=lambda _s: None)
                self.assertEqual(again, [])
        finally:
            prefetch.WIX_SHA256 = real_wix
            prefetch.NSIS_SHA1 = real_nsis
            prefetch.NSIS_DLL_SHA1 = real_dll

    def test_zip_slip_is_rejected(self):
        payload = zip_bytes({"../candle.exe": b"nope"})
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(prefetch.FetchError):
                prefetch.safe_extract(payload, Path(directory) / "out")
            self.assertFalse((Path(directory) / "candle.exe").exists())

    def test_linux_retries_required_tools_and_skips_optional_failure(self):
        elf = b"\x7fELF" + b"app"
        script = b"#!/bin/sh\ntrue\n"
        opener = Opener([
            http_status("https://example.test/apprun", 504),
            Response(elf),
            Response(elf),
            Response(script),
            Response(script),
            http_status("https://example.test/plugin", 504),
            http_status("https://example.test/plugin", 504),
            http_status("https://example.test/plugin", 504),
            http_status("https://example.test/plugin", 504),
            http_status("https://example.test/plugin", 504),
        ])
        with tempfile.TemporaryDirectory() as directory:
            env = {"XDG_CACHE_HOME": directory}
            prefetch.prefetch("Linux", "x86_64-unknown-linux-gnu", env, Path("/unused"), opener, sleep=lambda _s: None)
            root = Path(directory) / "tauri"
            apprun = root / "AppRun-x86_64"
            self.assertEqual(apprun.read_bytes(), elf)
            self.assertEqual(stat.S_IMODE(apprun.stat().st_mode), 0o770)
            self.assertTrue((root / "linuxdeploy-x86_64.AppImage").is_file())
            self.assertTrue((root / "linuxdeploy-plugin-gtk.sh").read_bytes().startswith(b"#!"))
            self.assertFalse((root / "linuxdeploy-plugin-appimage.AppImage").exists())

    def test_linux_refuses_an_html_error_body(self):
        opener = Opener([Response(b"<html>504</html>")])
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(prefetch.FetchError):
                prefetch.prefetch(
                    "Linux",
                    "x86_64-unknown-linux-gnu",
                    {"XDG_CACHE_HOME": directory},
                    Path("/unused"),
                    opener,
                    sleep=lambda _s: None,
                )
            self.assertFalse((Path(directory) / "tauri" / "AppRun-x86_64").exists())

    def test_macos_does_not_download(self):
        opener = Opener([])
        self.assertEqual(prefetch.prefetch("macOS", "aarch64-apple-darwin", {}, Path("/unused"), opener), [])
        self.assertEqual(opener.urls, [])

    def test_release_workflow_keeps_signing_and_does_not_publish(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        build = workflow.split("- name: Build Tauri app", 1)[1].split("\n      - name:", 1)[0]
        self.assertIn('TAURI_BUNDLER_DMG_IGNORE_CI: "false"', build)
        self.assertIn('retryAttempts: "2"', build)
        self.assertNotIn("tagName", build)
        self.assertIn("TAURI_SIGNING_PRIVATE_KEY", build)
        self.assertIn("APPLE_SIGNING_IDENTITY", build)
        self.assertIn("- name: Prefetch Tauri bundler tools", workflow)
        self.assertIn("secrets.TAURI_SIGNING_PRIVATE_KEY", workflow)
        prefetch_step = subprocess.check_output(
            [
                "node",
                "--input-type=module",
                "-e",
                "import { extractRuns } from './scripts/ci/workflow-bash.mjs';"
                "import { readFileSync } from 'node:fs';"
                "const steps = extractRuns(readFileSync('.github/workflows/release.yml','utf8'));"
                "const step = steps.find((item) => item.name === 'Prefetch Tauri bundler tools');"
                "if (!step) process.exit(2); process.stdout.write(step.run);",
            ],
            cwd=ROOT,
            text=True,
        )
        self.assertIn("prefetch-tauri-bundler-tools.py", prefetch_step)
        self.assertIn("^[0-9a-f]{40}$", prefetch_step)

    def test_prefetch_step_uses_the_checkout_or_the_workflow_revision(self):
        step = subprocess.check_output(
            [
                "node",
                "--input-type=module",
                "-e",
                "import { extractRuns } from './scripts/ci/workflow-bash.mjs';"
                "import { readFileSync } from 'node:fs';"
                "const steps = extractRuns(readFileSync('.github/workflows/release.yml','utf8'));"
                "process.stdout.write(steps.find((item) => item.name === 'Prefetch Tauri bundler tools').run);",
            ],
            cwd=ROOT,
            text=True,
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = root / "runner"
            runner.mkdir()
            bin_dir = root / "bin"
            bin_dir.mkdir()
            (bin_dir / "gh").write_text("#!/bin/sh\necho gh-called >> \"$TRACE\"\nexit 9\n")
            (bin_dir / "gh").chmod(0o755)
            local = root / "work"
            script = local / "scripts/ci/prefetch-tauri-bundler-tools.py"
            script.parent.mkdir(parents=True)
            script.write_text("print('local-script')\n")
            env = os.environ.copy()
            env.update({
                "PATH": f"{bin_dir}{os.pathsep}{env.get('PATH', '')}",
                "TRACE": str(root / "trace"),
                "RUNNER_TEMP": str(runner),
                "WORKFLOW_SHA": "a" * 40,
                "GITHUB_REPOSITORY": "ashlrai/ashlr-md",
                "PREFETCH_OS": "macOS",
            })
            local_run = subprocess.run(["bash", "-c", step], cwd=local, env=env, text=True, capture_output=True)
            self.assertEqual(local_run.returncode, 0, local_run.stderr)
            self.assertIn("local-script", local_run.stdout)
            self.assertFalse((root / "trace").exists())

            missing = root / "missing"
            missing.mkdir()
            (bin_dir / "gh").write_text(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$TRACE\"\nprintf '%s\\n' 'print(\"fetched-script\")'\n"
            )
            fetched = subprocess.run(["bash", "-c", step], cwd=missing, env=env, text=True, capture_output=True)
            self.assertEqual(fetched.returncode, 0, fetched.stderr)
            self.assertIn("fetched-script", fetched.stdout)
            self.assertIn("prefetch-tauri-bundler-tools.py?ref=" + "a" * 40, (root / "trace").read_text())

            env["WORKFLOW_SHA"] = "not-a-commit"
            rejected = subprocess.run(["bash", "-c", step], cwd=missing, env=env, text=True, capture_output=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("workflow sha", rejected.stdout + rejected.stderr)


if __name__ == "__main__":
    unittest.main()
