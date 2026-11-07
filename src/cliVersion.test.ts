import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("prints the package version from the CLI", () => {
  const workspace = resolve(__dirname, "../src-tauri");
  const target = resolve(workspace, "target");
  const executable = resolve(
    target,
    "debug",
    `mdopen${process.platform === "win32" ? ".exe" : ""}`,
  );
  const { version } = JSON.parse(
    readFileSync(resolve(__dirname, "../package.json"), "utf8"),
  );

  const output = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(output).toContain(version);
});
