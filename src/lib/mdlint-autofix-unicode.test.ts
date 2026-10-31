import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

const rules = [ruleInvalidLinkTarget];

describe("invalid link autofix with Unicode text", () => {
  it.each([
    ["", "\n"],
    ["#", "\r\n"],
    ["?", "\n"],
    [" \t ", "\r\n"],
  ])("preserves Unicode around destination %j with %j line endings", (href, eol) => {
    const prefix = "😀 👩🏽‍💻 cafe\u0301 日本語 مرحبا ";
    const suffix = " שלום 🌍 e\u0301!";
    const link = `[文書🔗](${href})`;
    const doc = [
      "`🙈 [ignored](#)`",
      `${prefix}${link}${suffix}`,
      "終わり 🚀",
      "",
    ].join(eol);
    const expected = [
      "`🙈 [ignored](#)`",
      `${prefix}[文書🔗](TODO)${suffix}`,
      "終わり 🚀",
      "",
    ].join(eol);
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].range).toEqual({
      from: { offset: doc.indexOf(link), line: 2, col: prefix.length },
      to: {
        offset: doc.indexOf(link) + link.length,
        line: 2,
        col: prefix.length + link.length,
      },
    });
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("fixes multiple links without disturbing Unicode between them", () => {
    const doc = "🌸 [一](#) 👨‍👩‍👧‍👦 e\u0301 [二](?) 🐈";
    const expected = "🌸 [一](TODO) 👨‍👩‍👧‍👦 e\u0301 [二](TODO) 🐈";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(
      violations.map((v) => doc.slice(v.range!.from.offset, v.range!.to.offset)),
    ).toEqual(["[一](#)", "[二](?)"]);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });
});
