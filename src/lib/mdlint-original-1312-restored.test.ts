import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("original 1312: invalid link target preservation", () => {
  // biome-ignore format: preserve the complete original test block for provenance.
  it.each(["\n", "\r\n"])(
    "sets both destinations to TODO and keeps the text between them, whatever the invalid kind (%j)",
    (nl) => {
      const between = " — *emph*, `code` (parens) [not a link] & ";
      const doc = `Lead [a](#)${between}[b *bold*]( \t )${between}[c]() tail.${nl}Next line.${nl}`;
      const expected = `Lead [a](TODO)${between}[b *bold*](TODO)${between}[c](TODO) tail.${nl}Next line.${nl}`;
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(3);
      expect(applyAllFixes(doc, violations)).toBe(expected);
      // Applying one at a time (re-linting between) reaches the same result.
      let stepwise = doc;
      for (let v = lintDocument(stepwise, { rules }); v.length; v = lintDocument(stepwise, { rules })) {
        stepwise = applyFix(stepwise, v[0]);
      }
      expect(stepwise).toBe(expected);
    },
  );
});
