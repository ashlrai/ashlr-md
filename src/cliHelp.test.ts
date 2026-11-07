import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspace = resolve(__dirname, "../src-tauri");
const target = resolve(workspace, "target");
const executable = (name: string) =>
  resolve(target, "debug", `${name}${process.platform === "win32" ? ".exe" : ""}`);

describe("CLI help", () => {
  it.each([
    ["mdopen", []],
    ["mdopener-mcp", []],
    ["mdopener-mcp", ["doctor"]],
    ["mdopener-mcp", ["setup"]],
  ])("%s %s --help prints help", (binary, args) => {
    const result = spawnSync(executable(binary), [...args, "--help"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });
});
