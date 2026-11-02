import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const inventory = readFileSync("docs/mdlint-placeholder-inventory.md", "utf8");
const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

function example(name: string): string {
  const sections = inventory.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("placeholder inventory", () => {
  it("shows the placeholders produced by Fix all", () => {
    const before = example("before");
    const violations = lintDocument(before, { rules });
    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "missing-alt-text",
    ]);
    const after = applyAllFixes(before, violations);
    expect(after).toBe(example("after"));
    expect(lintDocument(after, { rules })).toEqual([]);
  });

  it("shows both passes for overlapping image and destination fixes", () => {
    const before = example("overlap before");
    const violations = lintDocument(before, { rules });
    expect(violations.map((v) => v.ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    const first = applyAllFixes(before, violations);
    expect(first).toBe(example("overlap first"));
    const remaining = lintDocument(first, { rules });
    expect(remaining.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const second = applyAllFixes(first, remaining);
    expect(second).toBe(example("overlap second"));
    expect(lintDocument(second, { rules })).toEqual([]);
  });

  it.each([
    ["![]()", ["invalid-link-target"]],
    ["![]( )", ["invalid-link-target", "missing-alt-text"]],
    ["[label]( # )", []],
    ["[label]( ? )", []],
  ])("documents rule boundaries for %s", (doc, expected) => {
    expect(
      lintDocument(doc, { rules })
        .map((v) => v.ruleId)
        .sort(),
    ).toEqual(expected);
  });
});
