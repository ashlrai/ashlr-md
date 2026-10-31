import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

const rules = [ruleInvalidLinkTarget];

describe("invalid link autofix with two links on one line", () => {
  it.each([
    ["", "#"],
    ["?", "   "],
    ["\t", ""],
    ["#", "?"],
  ])("fixes hrefs %j and %j without changing the surrounding text", (first, second) => {
    const doc = `Before café ☕ [first](${first}), then [second](${second}) after.\r\n`;
    const expected = "Before café ☕ [first](TODO), then [second](TODO) after.\r\n";
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(
      violations.map((violation) =>
        doc.slice(violation.range!.from.offset, violation.range!.to.offset),
      ),
    ).toEqual([`[first](${first})`, `[second](${second})`]);
    expect(applyFix(doc, violations[0])).toBe(
      `Before café ☕ [first](TODO), then [second](${second}) after.\r\n`,
    );
    expect(applyFix(doc, violations[1])).toBe(
      `Before café ☕ [first](${first}), then [second](TODO) after.\r\n`,
    );
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    const remaining = lintDocument(expected, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(expected, remaining)).toBe(expected);
  });

  it("fixes both identical links while preserving a valid link between them", () => {
    const doc = "[same](#) / [keep](./guide.md) / [same](#)";
    const expected = "[same](TODO) / [keep](./guide.md) / [same](TODO)";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations[0].range!.from.offset).toBe(0);
    expect(violations[1].range!.from.offset).toBe(doc.lastIndexOf("[same](#)"));
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });
});
