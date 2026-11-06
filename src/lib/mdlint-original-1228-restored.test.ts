import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("original 1228: bare link and inline code", () => {
  it("turns a bare [link]() into [link](TODO), keeps all surrounding text, and is idempotent", () => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `# Title${nl}${nl}Lead-in [link]() trailing words.${nl}${nl}\`[link]()\` stays literal.${nl}`;
      const expected = `# Title${nl}${nl}Lead-in [link](TODO) trailing words.${nl}${nl}\`[link]()\` stays literal.${nl}`;
      const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
      expect(violations).toHaveLength(1);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(applyFix(doc, violations[0])).toBe(expected);
      expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
      expect(applyAllFixes(fixed, [])).toBe(fixed);
    }
  });
});
