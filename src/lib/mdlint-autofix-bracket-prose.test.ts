import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  applyFix,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

describe("autofix with bracketed prose", () => {
  it.each([
    "[sic]",
    "[TODO]",
    "[1]",
  ])("leaves ordinary prose containing %s unchanged", (bracketed) => {
    const doc = `A note ${bracketed}, followed by ordinary prose.\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });

  it.each([
    "\n",
    "\r\n",
  ])("preserves bracketed prose while fixing links and images with %j line endings", (newline) => {
    const doc = [
      "The quote [sic] precedes [draft]().",
      "Keep [TODO] beside ![](chart.png) and cite [1] after [notes](#).",
    ].join(newline);
    const expected = [
      "The quote [sic] precedes [draft](TODO).",
      "Keep [TODO] beside ![TODO: describe image](chart.png) and cite [1] after [notes](TODO).",
    ].join(newline);
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
      "invalid-link-target",
    ]);
    expect(applyFix(doc, violations[0])).toBe(
      doc.replace("[draft]()", "[draft](TODO)"),
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });
});
