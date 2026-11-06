import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const examples = readFileSync("docs/mdlint-rule-examples.md", "utf8");
const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

function example(name: string): string {
  const sections = examples.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("Markdown lint rule examples", () => {
  it.each([
    ["link", "invalid-link-target"],
    ["image", "missing-alt-text"],
  ])("shows the %s warning and autofix", (name, ruleId) => {
    const before = example(`${name} before`);
    const violations = lintDocument(before, { rules });
    expect(violations.map((violation) => violation.ruleId)).toEqual([ruleId]);
    const after = applyAllFixes(before, violations);
    expect(after).toBe(example(`${name} after`));
    expect(lintDocument(after, { rules })).toEqual([]);
  });
});
