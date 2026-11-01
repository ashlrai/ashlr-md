import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

describe("placeholder autofixes on an empty document", () => {
  it.each([
    [ruleInvalidLinkTarget, "[draft]()", "[draft](TODO)"],
    [ruleMissingAltText, "![](chart.png)", "![TODO: describe image](chart.png)"],
  ])("does not create a %s placeholder without a match", (rule, example, expected) => {
    const violations = lintDocument("", { rules: [rule] });
    expect(violations).toEqual([]);
    expect(applyAllFixes("", violations)).toBe("");

    // Verify the selected rule is active and does create its placeholder for a match.
    const exampleViolations = lintDocument(example, { rules: [rule] });
    expect(exampleViolations).toHaveLength(1);
    expect(applyAllFixes(example, exampleViolations)).toBe(expected);
  });

  it("leaves an empty document unchanged with all built-in rules", () => {
    const violations = lintDocument("");
    expect(violations).toEqual([]);
    expect(applyAllFixes("", violations)).toBe("");
  });
});
