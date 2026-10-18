// scripts/phantom-check.sh is metadata only: it may run `phantom --version`
// and nothing else. These tests put a fake `phantom` on PATH that records
// its arguments, so any other call (for example reveal) would be caught.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(__dirname, "../scripts/phantom-check.sh");

function run(pathDir: string) {
  return spawnSync("/bin/bash", [script], {
    env: { PATH: `${pathDir}:/usr/bin:/bin`, HOME: pathDir },
    encoding: "utf8",
  });
}

function fakePhantom(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "phmcheck-"));
  const bin = join(dir, "phantom");
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  return dir;
}

describe("phantom-check.sh", () => {
  it("reports the version and only passes --version", () => {
    const dir = fakePhantom(
      `#!/bin/sh\necho "$@" >> "$0.args"\necho "phantom 9.9.9"\n`,
    );
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("installed (phantom 9.9.9)");
    expect(r.stdout).toContain("phantom exec --");
    expect(readFileSync(join(dir, "phantom.args"), "utf8").trim()).toBe("--version");
  });

  it("says not installed when phantom is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "phmcheck-empty-"));
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("Phantom: not installed (optional)");
  });

  it("does not fail when --version errors", () => {
    const dir = fakePhantom("#!/bin/sh\nexit 3\n");
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("version unavailable");
  });
});
