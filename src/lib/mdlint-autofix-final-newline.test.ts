import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("invalid link autofix and final newlines", () => {
  it.each([
    ["LF without a final newline", "\n", false],
    ["LF with a final newline", "\n", true],
    ["CRLF without a final newline", "\r\n", false],
    ["CRLF with a final newline", "\r\n", true],
  ])("preserves %s", (_name, newline, finalNewline) => {
    for (const linkOnLastLine of [false, true]) {
      const lines = linkOnLastLine
        ? ["Intro: café", "Read [draft]()"]
        : ["Read [draft]()", "Closing: café"];
      const ending = finalNewline ? newline : "";
      const doc = lines.join(newline) + ending;
      const expected = doc.replace("[draft]()", "[draft](TODO)");
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed.endsWith("\n")).toBe(finalNewline);
      const remaining = lintDocument(fixed, { rules });
      expect(remaining).toEqual([]);
      expect(applyAllFixes(fixed, remaining)).toBe(expected);
    }
  });
});
