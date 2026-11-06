import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

const rules = [ruleInvalidLinkTarget];

describe("invalid link autofix preserves its label", () => {
  const labels = [
    "  padded\tlabel  ",
    "Café ☕ — **draft** & _notes_",
    "A label longer than thirty characters keeps every word, including the end",
    "Version 2.1; path \\draft & notes",
  ];

  for (const label of labels) {
    it.each([
      "",
      " \t ",
      "#",
      "?",
    ])("retains %j as the href replacement for a nonempty label", (href) => {
      const link = `[${label}](${href})`;
      const doc = `📚 Before ${link}, see [reference](./guide.md).\r\n`;
      const expected = `📚 Before [${label}](TODO), see [reference](./guide.md).\r\n`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      expect(violations[0].fix).not.toBeNull();
      expect(
        doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
      ).toBe(link);
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      const remaining = lintDocument(fixed, { rules });
      expect(remaining).toEqual([]);
      expect(applyAllFixes(fixed, remaining)).toBe(expected);
    });
  }
});
