import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("invalid link autofix in mixed prose", () => {
  it.each([
    ["", "\n"],
    [" \t ", "\n"],
    ["#", "\r\n"],
    ["?", "\r\n"],
  ])("replaces destination %j while preserving surrounding text with %j", (href, newline) => {
    const doc = [
      "A café note: keep this opening sentence.",
      `Read [guide](./guide.md), then see ("[guide](${href})")—yes, that one; continue!`,
      "Afterward, keep the ordinary prose, punctuation & spaces.  ",
      "",
    ].join(newline);
    const expected = [
      "A café note: keep this opening sentence.",
      'Read [guide](./guide.md), then see ("[guide](TODO)")—yes, that one; continue!',
      "Afterward, keep the ordinary prose, punctuation & spaces.  ",
      "",
    ].join(newline);
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });
});
