import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { beforeAll, expect, it } from "vitest";

const workspace = resolve(__dirname, "../src-tauri");
const target = resolve(workspace, "target");
const executable = resolve(
  target,
  "debug",
  `mdopen${process.platform === "win32" ? ".exe" : ""}`,
);

beforeAll(() => {
  execFileSync("cargo", ["build", "--locked", "--target-dir", target, "-p", "mdopen"], {
    cwd: workspace,
    stdio: "pipe",
    timeout: 300_000,
  });
}, 300_000);

it("prints usage without a stack trace when called with no arguments", () => {
  const result = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("USAGE:");
  expect(result.stdout).toBe("");
  expect(result.stdout + result.stderr).not.toMatch(/stack backtrace:|\bpanicked at\b|\n\s+at\s+\S+/i);
});
