import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffLines, splitLines } from "../editor/lineDiff";
import { parseTable, serializeTable } from "./tableEditor";

describe("Sonar Q8-16 regressions", () => {
  it("select exits successfully with affected output or fail-open full output", () => {
    const dir = mkdtempSync(join(tmpdir(), "sonar-q8-16-"));
    const files = join(dir, "files.txt");
    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../scripts/ci/select.mjs",
    );
    try {
      writeFileSync(files, "src/a.ts\nsrc-tauri/bins/mdopen/src/main.rs\n");
      for (const [path, expected] of [
        [files, "mode=affected\njs=true\njs_base=\nrust=true\nrust_args=-p mdopen\n"],
        [
          join(dir, "missing.txt"),
          "mode=full\njs=true\njs_base=\nrust=true\nrust_args=--workspace\n",
        ],
      ]) {
        const result = spawnSync(
          process.execPath,
          [script, "--event", "pull_request", "--files-file", path],
          { encoding: "utf8" },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(expected);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each<[string, string[]]>([
    ["", []],
    ["a\r\n\r\nb\rc\nend", ["a\r\n", "\r\n", "b\r", "c\n", "end"]],
    ["\r\r\n\n\r", ["\r", "\r\n", "\n", "\r"]],
    ["😀\r\nlast\r", ["😀\r\n", "last\r"]],
  ])("splitLines preserves every break in %j", (text, lines) => {
    expect(splitLines(text)).toEqual(lines);
    expect(splitLines(text).join("")).toBe(text);
  });

  it("diffLines keeps mixed endings and detects CRLF-only edits", () => {
    expect(diffLines(splitLines("a\r\nb\rc"), splitLines("a\nb\rc"))).toEqual([
      { kind: "delete", lines: ["a\r\n"] },
      { kind: "insert", lines: ["a\n"] },
      { kind: "equal", lines: ["b\r", "c"] },
    ]);
  });

  it.each([
    0, 1, 2, 3, 4, 5,
  ])("tableEditor preserves pipe escaping after %i backslashes", (count) => {
    const cell = `${"\\".repeat(count)}|a||b\r\nc\rd\nend\\`;
    const escaped = `${"\\".repeat(count % 2 ? count : count + 1)}|a\\|\\|b<br>c<br>d<br>end\\`;
    const markdown = serializeTable({
      headers: [cell],
      alignments: ["none"],
      rows: [[cell]],
    });
    expect(markdown).toBe(`| ${escaped} |\n| --- |\n| ${escaped} |`);
    expect(parseTable(markdown).rows).toEqual([[escaped]]);
    expect(serializeTable(parseTable(markdown))).toBe(markdown);
  });

  it("serializes a long unmatched backslash run without repeated regex scans", () => {
    const cell = `${"\\".repeat(100_000)}x`;
    const started = performance.now();
    expect(serializeTable({ headers: [cell], alignments: ["none"], rows: [] })).toBe(
      `| ${cell} |\n| --- |`,
    );
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
