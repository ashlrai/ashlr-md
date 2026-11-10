import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  applyFix,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const guide = readFileSync("docs/mdlint-autofix-surrounding-text.md", "utf8");
const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("surrounding text guide examples", () => {
  it("fixes an empty link between words without changing the surrounding text", () => {
    const before = "Before [draft]() after.\n";
    const violations = lintDocument(before, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    const fixed = applyAllFixes(before, violations);
    expect(fixed).toBe("Before [draft](TODO) after.\n");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["link", "invalid-link-target"],
    ["image", "missing-alt-text"],
  ])("shows the %s fix with surrounding prose intact", (name, ruleId) => {
    const before = example(`${name} before`);
    const after = example(`${name} after`);
    const violations = lintDocument(before, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([ruleId]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(before, violations[0])).toBe(after);
    expect(applyAllFixes(before, violations)).toBe(after);
    expect(lintDocument(after, { rules })).toEqual([]);
  });
});
