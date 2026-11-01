import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyFix, lintDocument, ruleMissingAltText } from "./mdlint";

const guide = readFileSync("docs/mdlint-image-fix-scope.md", "utf8");

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("image alt-text fix scope", () => {
  it("documents the warning and the actual single-image fix", () => {
    const before = example("before");
    const violations = lintDocument(before, { rules: [ruleMissingAltText] });
    expect(violations).toHaveLength(1);
    const violation = violations[0];
    expect([violation.ruleId, violation.severity, violation.message]).toEqual([
      "missing-alt-text",
      "warning",
      "Image is missing alt text: chart.png?view=full",
    ]);
    expect(before.slice(violation.range!.from.offset, violation.range!.to.offset)).toBe(
      "![](chart.png?view=full)",
    );
    const after = applyFix(before, violation);
    expect(after).toBe(example("after"));
    expect(lintDocument(after, { rules: [ruleMissingAltText] })).toEqual([]);
  });
});
