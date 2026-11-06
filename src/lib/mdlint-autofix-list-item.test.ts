import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

const rules = [ruleInvalidLinkTarget];

describe("invalid link autofix in list items", () => {
  it.each([
    ["-", ""],
    ["*", "#"],
    ["+", "?"],
    ["1.", " "],
    ["12)", "#"],
    ["  -", "?"],
    ["- [x]", ""],
  ])("preserves the %j marker when fixing destination %j", (marker, destination) => {
    const doc = `Before\n${marker} Read [draft](${destination}) today.\nAfter\n`;
    const expected = `Before\n${marker} Read [draft](TODO) today.\nAfter\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`[draft](${destination})`);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes multiple list items without changing their markers or valid links", () => {
    const doc =
      "- [first](#) and [reference](./guide.md)\r\n  2. [second](?)\r\n- [ ] [third]()";
    const expected =
      "- [first](TODO) and [reference](./guide.md)\r\n  2. [second](TODO)\r\n- [ ] [third](TODO)";
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });
});
