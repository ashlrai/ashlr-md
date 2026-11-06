import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

const rules = [ruleInvalidLinkTarget];

describe("invalid link autofix beside inline code", () => {
  it.each([
    ["`[draft](#)`", "[draft](#)", "[draft](TODO)"],
    ["``[draft](?) and `literal` ``", "[draft](?)", "[draft](TODO)"],
    ["`[draft]()`", "[draft]()", "[draft](TODO)"],
  ])("preserves %s when the same invalid link occurs outside it", (code, link, fixedLink) => {
    for (const codeFirst of [true, false]) {
      const doc = codeFirst ? `${code} ${link}` : `${link} ${code}`;
      const expected = codeFirst ? `${code} ${fixedLink}` : `${fixedLink} ${code}`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      expect(violations[0].range!.from.offset).toBe(
        codeFirst ? doc.lastIndexOf(link) : 0,
      );
      expect(
        doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
      ).toBe(link);
      expect(applyFix(doc, violations[0])).toBe(expected);
      expect(applyAllFixes(doc, violations)).toBe(expected);
      expect(lintDocument(expected, { rules })).toEqual([]);
    }
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes links around a multiline code span with %j line endings", (newline) => {
    const code = [`\`[draft](#)`, "[draft](?)`"].join(newline);
    const doc = `☕ [draft](#) ${code} [draft](?)${newline}`;
    const expected = `☕ [draft](TODO) ${code} [draft](TODO)${newline}`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.map((v) => v.range!.from.offset)).toEqual([
      doc.indexOf("[draft](#)"),
      doc.lastIndexOf("[draft](?)"),
    ]);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    const remaining = lintDocument(expected, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(expected, remaining)).toBe(expected);
  });
});
