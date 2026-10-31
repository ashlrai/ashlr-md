import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const guide = readFileSync("docs/mdlint-placeholder-review.md", "utf8");
const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("placeholder review guide", () => {
  it.each([
    ["link", "invalid-link-target"],
    ["image", "missing-alt-text"],
  ])("shows the actual %s autofix and a reviewed replacement", (name, ruleId) => {
    const before = example(`${name} before`);
    const violations = lintDocument(before, { rules });
    expect(violations.map((violation) => violation.ruleId)).toEqual([ruleId]);
    const placeholder = applyAllFixes(before, violations);
    expect(placeholder).toBe(example(`${name} placeholder`));
    // A clean lint result does not mean the placeholder has been reviewed.
    expect(lintDocument(placeholder, { rules })).toEqual([]);
    const reviewed = example(`${name} reviewed`);
    expect(reviewed).not.toContain("TODO");
    expect(lintDocument(reviewed, { rules })).toEqual([]);
  });

  it("shows why an empty image source requires another lint pass", () => {
    const before = "![]()";
    const first = lintDocument(before, { rules });
    expect(first.map((violation) => violation.ruleId)).toEqual(["invalid-link-target"]);
    const placeholder = applyAllFixes(before, first);
    expect(placeholder).toBe("![](TODO)");
    const second = lintDocument(placeholder, { rules });
    expect(second.map((violation) => violation.ruleId)).toEqual(["missing-alt-text"]);
    expect(applyAllFixes(placeholder, second)).toBe("![TODO: describe image](TODO)");
  });
});
