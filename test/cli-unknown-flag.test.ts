import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";

// `mdopen` must refuse a flag it does not know: exit non-zero with a plain
// message on stderr, instead of opening something or exiting 0 in silence.
// The flag is passed alone: `--help` anywhere on the line wins over every
// other flag and exits 0, so it is not used here.
const workspace = resolve(__dirname, "../src-tauri");
const target = resolve(workspace, "target");
const executable = resolve(
  target,
  "debug",
  `mdopen${process.platform === "win32" ? ".exe" : ""}`,
);

it("exits non-zero with a plain message for an unknown flag", () => {
  const home = mkdtempSync(resolve(tmpdir(), "mdopen-home-"));
  const result = spawnSync(executable, ["--definitely-not-a-flag"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    timeout: 10_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unknown flag: --definitely-not-a-flag");
  expect(result.stdout).toBe("");
});
