/**
 * Keeps docs/mdlint-autofix-fixture-index.md in step with
 * mdlint-autofix.test.ts: every indexed name must exist there, and each
 * section's count must match the `it`/`it.each` calls in its describe block.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const testSource = read("./mdlint-autofix.test.ts");
const indexDoc = read("../../docs/mdlint-autofix-fixture-index.md");

/** Count `it`/`it.each` calls directly inside a top-level describe block. */
function countCalls(describeName: string): number {
  const start = testSource.indexOf(`describe("${describeName}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = testSource.indexOf("\ndescribe(", start + 1);
  const body = testSource.slice(start, next === -1 ? undefined : next);
  return (body.match(/^ {2}it(?:\.each)?\(/gm) ?? []).length;
}

function sections(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const part of indexDoc.split(/^## /m).slice(1)) {
    const [heading, ...rest] = part.split("\n");
    const names = rest
      .map((line) =>
        line.match(/^- (?:\[table\] )?"(.*)"$/)?.[1]?.replace(/`([^`]+)`/g, "$1"),
      )
      .filter((name): name is string => name !== undefined);
    result.set(heading.replace(/ \(\d+\)$/, ""), names);
  }
  return result;
}

describe("mdlint autofix fixture index", () => {
  const byHeading = sections();

  it.each([
    ["Link fixtures", "rule:invalid-link-target"],
    ["Image fixtures", "rule:missing-alt-text"],
    ["Mixed-rule fixtures", "chained violations and multi-line fixes"],
  ])("%s lists every it/it.each call of its describe block", (heading, block) => {
    expect(byHeading.get(heading)).toHaveLength(countCalls(block));
  });

  it("only indexes names that exist in mdlint-autofix.test.ts", () => {
    const missing = [...byHeading.values()]
      .flat()
      .filter(
        (name) =>
          !testSource.includes(`"${name}"`) && !testSource.includes(`\`${name}\``),
      );
    expect(missing).toEqual([]);
  });

  it("has no duplicate names within the index", () => {
    const all = [...byHeading.values()].flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("states the heading counts that match its lists", () => {
    for (const [heading, names] of byHeading) {
      if (names.length === 0) continue;
      expect(indexDoc).toContain(`## ${heading} (${names.length})`);
    }
  });
});
