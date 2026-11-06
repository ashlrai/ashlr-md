import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixAllViolations } from "../components/LinterToast";
import {
  applyFix,
  BUILTIN_RULES,
  LINTER_DEFAULT_ENABLED_RULES,
  lintDocument,
  ruleInvalidLinkTarget,
} from "./mdlint";

const guide = readFileSync("docs/mdlint-autofix-preservation.md", "utf8");

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("autofix preservation guide", () => {
  it("shows a single link fix preserving its surrounding prose", () => {
    const before = example("link before");
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(before, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    const after = applyFix(before, violations[0]);
    expect(after).toBe(example("link after"));
    expect(lintDocument(after, { rules })).toEqual([]);
  });

  it("shows Fix all preserving both image sources", () => {
    const before = example("combined before");
    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(before, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    const after = fixAllViolations(before, violations);
    expect(after).toBe(example("combined after"));
    expect(lintDocument(after, { rules })).toEqual([]);
  });
});
