import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const reference = readFileSync("docs/mdlint-fix-output-reference.md", "utf8");
const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

function example(name: string): string {
  const sections = reference.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("Markdown lint fix output reference", () => {
  it.each([
    ["link", ["invalid-link-target", "invalid-link-target"]],
    ["image", ["missing-alt-text"]],
  ])("shows the actual %s output", (name, expectedRules) => {
    const input = example(`${name} input`);
    const violations = lintDocument(input, { rules });
    expect(violations.map((v) => v.ruleId)).toEqual(expectedRules);
    const output = applyAllFixes(input, violations);
    expect(output).toBe(example(`${name} output`));
    expect(lintDocument(output, { rules })).toEqual([]);
  });

  it("shows both passes for overlapping warnings", () => {
    const input = example("overlap input");
    const violations = lintDocument(input, { rules });
    expect(violations.map((v) => v.ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    const first = applyAllFixes(input, violations);
    expect(first).toBe(example("overlap first"));
    const remaining = lintDocument(first, { rules });
    expect(remaining.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const second = applyAllFixes(first, remaining);
    expect(second).toBe(example("overlap second"));
    expect(lintDocument(second, { rules })).toEqual([]);
  });
});
