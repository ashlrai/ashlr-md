import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLintHistory,
  fixAllViolations,
  getLintHistory,
} from "../components/LinterToast";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
  ruleOrphanedHeading,
} from "./mdlint";

const review = readFileSync("docs/mdlint-autofix-order-review.md", "utf8");
const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

function example(name: string): string {
  const sections = review.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("mixed autofix order review examples", () => {
  beforeEach(() => clearLintHistory());

  it.each(["\n", "\r\n"])("shows adjacent fixes with %j line endings", (newline) => {
    const input = example("adjacent input").replaceAll("\n", newline);
    const output = example("adjacent output").replaceAll("\n", newline);
    const violations = lintDocument(input, { rules });
    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    expect(applyAllFixes(input, violations)).toBe(output);
    expect(lintDocument(output, { rules })).toEqual([]);
  });

  it("shows both passes for overlapping fixes", () => {
    const input = example("overlap input");
    const first = example("overlap first");
    const second = example("overlap second");
    const violations = lintDocument(input, { rules });
    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    expect(applyAllFixes(input, violations)).toBe(first);
    const remaining = lintDocument(first, { rules });
    expect(remaining.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    expect(applyAllFixes(first, remaining)).toBe(second);
    expect(lintDocument(second, { rules })).toEqual([]);
  });

  it("shows the output and remaining warning across two passes", () => {
    const input = example("warning input");
    const output = example("warning output");
    const warningRules = [ruleOrphanedHeading, ...rules];
    expect(applyAllFixes(input, lintDocument(input, { rules: warningRules }))).toBe(
      output,
    );
    const remaining = lintDocument(output, { rules: warningRules });
    expect(remaining.map(({ ruleId }) => ruleId)).toEqual(["orphaned-heading"]);
    expect(remaining[0].fix).toBeNull();
    expect(applyAllFixes(output, remaining)).toBe(output);
  });

  it("shows the Fix all output and history order", () => {
    const input = example("fix-all input");
    const violations = lintDocument(input, { rules });
    expect(fixAllViolations(input, violations)).toBe(example("fix-all output"));
    expect(getLintHistory().map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
  });
});
