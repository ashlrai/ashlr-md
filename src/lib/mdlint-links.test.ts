import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

const rules = [ruleInvalidLinkTarget];

// The rule docs say the autofix replaces an invalid href with `TODO`.
describe("invalid-link-target: whitespace-only destination", () => {
  it.each([
    ["spaces", "[docs](   )", "[docs](TODO)"],
    ["a tab", "[docs](\t)", "[docs](TODO)"],
    ["mixed space and tab", "[docs]( \t )", "[docs](TODO)"],
    ["a line break", "[docs](\n)", "[docs](TODO)"],
    ["a non-breaking space", "[docs](\u00a0)", "[docs](TODO)"],
  ])("flags %s and fixes it to the TODO destination", (_name, link, fixed) => {
    const doc = `See ${link} now.\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].severity).toBe("warning");
    expect(violations[0].fix).toBeTypeOf("function");

    const expected = `See ${fixed} now.\n`;
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    // Once fixed, the document is clean.
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("does not flag a destination that has real content around whitespace", () => {
    expect(lintDocument("[ok]( ./a.md )\n", { rules })).toEqual([]);
  });
});
