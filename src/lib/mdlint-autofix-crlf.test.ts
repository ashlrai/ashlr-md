import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("invalid link autofix in CRLF documents", () => {
  it.each([
    "",
    "\r\n",
  ])("preserves prose and line endings with final ending %j", (ending) => {
    const doc =
      "Opening café paragraph.\r\n\r\n" +
      "Before [draft]() after; keep [guide](./guide.md).\r\n" +
      "Closing prose with ☕." +
      ending;
    const expected =
      "Opening café paragraph.\r\n\r\n" +
      "Before [draft](TODO) after; keep [guide](./guide.md).\r\n" +
      "Closing prose with ☕." +
      ending;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].range).toEqual({
      from: { offset: doc.indexOf("[draft]"), line: 3, col: 7 },
      to: { offset: doc.indexOf("[draft]") + "[draft]()".length, line: 3, col: 16 },
    });
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/\r\n/g)).toHaveLength(ending ? 4 : 3);
    expect(fixed.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });
});
