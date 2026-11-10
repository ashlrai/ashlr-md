import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("invalid link beside a valid link", () => {
  it.each([
    ["[same](./guide.md)[same]()", "[same](./guide.md)[same](TODO)"],
    ["[same]()[same](./guide.md)", "[same](TODO)[same](./guide.md)"],
  ])("reports and fixes only the empty destination in %s", (doc, expected) => {
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: "invalid-link-target",
      message: "Invalid link target: [same](empty)",
      severity: "warning",
    });
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe("[same]()");
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });
});
