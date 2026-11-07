import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import buildTestCli from "../scripts/ci/build-test-cli";
import projects from "../vitest.workspace";

vi.mock("node:child_process", () => {
  const execFileSync = vi.fn();
  return { execFileSync, default: { execFileSync } };
});

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
});

describe("CLI test build lifecycle", () => {
  it("builds both current binaries once with a locked dependency graph", () => {
    buildTestCli();
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync).toHaveBeenCalledWith(
      "cargo",
      [
        "build",
        "--locked",
        "--target-dir",
        resolve(__dirname, "../src-tauri/target"),
        "-p",
        "mdopen",
        "-p",
        "mdopener-mcp",
      ],
      {
        cwd: resolve(__dirname, "../src-tauri"),
        stdio: "pipe",
        timeout: 300_000,
      },
    );
  });

  it("fails setup on a compiler error instead of testing stale binaries", () => {
    const failure = new Error("compiler failed");
    vi.mocked(execFileSync).mockImplementation(() => {
      throw failure;
    });
    expect(buildTestCli).toThrow(failure);
  });

  it("assigns CLI tests to one setup and leaves frontend-only runs Rust-free", () => {
    const [unit, cli] = projects as {
      test: { include?: string[]; exclude?: string[]; globalSetup?: string[] };
    }[];
    expect(unit.test.globalSetup).toBeUndefined();
    expect(cli.test.globalSetup).toEqual(["./scripts/ci/build-test-cli.ts"]);
    expect(cli.test.include).toHaveLength(4);
    for (const file of cli.test.include ?? []) {
      expect(unit.test.exclude).toContain(file);
    }
  });
});
