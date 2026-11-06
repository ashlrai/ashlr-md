import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("original PR 826: rule:invalid-link-target punctuation boundaries", () => {
  it.each([
    ["quotes", '"', '",'],
    ["parentheses", "(", ")."],
    ["em dashes", "—", "—"],
    ["brackets and semicolon", "<", ">;"],
    ["colon and exclamation", ":", "!"],
  ])("replaces an invalid href with TODO and leaves punctuation on both sides unchanged (%s)", (_name, lead, trail) => {
    const doc = `Note${lead}[spec]()${trail} then [ok](./ok.md).\n`;
    const expected = `Note${lead}[spec](TODO)${trail} then [ok](./ok.md).\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[spec]()");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});
