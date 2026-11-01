import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyAllFixes, lintDocument, ruleMissingAltText } from "./mdlint";

const guide = readFileSync("docs/mdlint-placeholder-accessibility.md", "utf8");
const rules = [ruleMissingAltText];

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("image placeholder accessibility guide", () => {
  it("shows the generated placeholder and why a clean lint result needs review", () => {
    const before = example("before");
    const violations = lintDocument(before, { rules });
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const placeholder = applyAllFixes(before, violations);
    expect(placeholder).toBe(example("placeholder"));
    expect(lintDocument(placeholder, { rules })).toEqual([]);
    expect(guide).toContain("A clean lint result is not an accessibility review.");
  });

  it("shows a reviewed replacement without changing the image source", () => {
    const reviewed = example("reviewed");
    expect(reviewed).toBe(
      example("placeholder").replace(
        "TODO: describe image",
        "Revenue rose from $1 million in January to $2 million in June",
      ),
    );
    expect(lintDocument(reviewed, { rules })).toEqual([]);
  });

  it("warns again when a reviewer deliberately leaves a decorative image empty", () => {
    expect(guide).toContain("![](ornament.png)");
    expect(lintDocument("![](ornament.png)", { rules })).toHaveLength(1);
  });
});
