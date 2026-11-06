import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

const rules = [ruleInvalidLinkTarget];

describe("invalid link autofix with two links on separate lines", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("replaces each href with TODO and leaves other text alone (%s)", (_name, eol) => {
    const doc = [
      "# Café ☕ links",
      "Intro [first]() text.",
      "",
      "Middle [keep](./guide.md) stays.",
      "Tail [second](#) end.  ",
      "",
    ].join(eol);
    const expected = [
      "# Café ☕ links",
      "Intro [first](TODO) text.",
      "",
      "Middle [keep](./guide.md) stays.",
      "Tail [second](TODO) end.  ",
      "",
    ].join(eol);
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.map((v) => v.range!.from.line)).toEqual([2, 5]);
    expect(
      violations.map((v) => doc.slice(v.range!.from.offset, v.range!.to.offset)),
    ).toEqual(["[first]()", "[second](#)"]);
    expect(applyFix(doc, violations[0])).toBe(
      doc.replace("[first]()", "[first](TODO)"),
    );
    expect(applyFix(doc, violations[1])).toBe(
      doc.replace("[second](#)", "[second](TODO)"),
    );
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("fixes identical invalid links on separate lines independently", () => {
    const doc = "[same](?)\n[same](?)\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(applyFix(doc, violations[1])).toBe("[same](?)\n[same](TODO)\n");
    expect(applyAllFixes(doc, violations)).toBe("[same](TODO)\n[same](TODO)\n");
  });
});
