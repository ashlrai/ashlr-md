import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyAllFixes, lintDocument, ruleMissingAltText } from "./mdlint";

const guide = readFileSync("docs/mdlint-empty-alt-behavior.md", "utf8");
const rules = [ruleMissingAltText];

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("empty image alt text guide", () => {
  it("shows the warnings and their actual replacements", () => {
    const before = example("before");
    const violations = lintDocument(before, { rules });
    expect(violations.map(({ ruleId, severity }) => [ruleId, severity])).toEqual([
      ["missing-alt-text", "warning"],
      ["missing-alt-text", "warning"],
    ]);
    const after = applyAllFixes(before, violations);
    expect(after).toBe(example("after"));
    expect(lintDocument(after, { rules })).toEqual([]);
  });

  it.each([
    "![]()",
    "![  ]()",
    "![description](image.png)",
    "![][image]",
    "`![](image.png)`",
  ])("does not flag %s", (doc) => {
    expect(lintDocument(doc, { rules })).toEqual([]);
  });
});
