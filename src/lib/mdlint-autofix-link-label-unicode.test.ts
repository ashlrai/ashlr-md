import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("invalid link autofix preserves Unicode labels", () => {
  it.each([
    ["日本語の文書", ""],
    ["مرحبا بالعالم", "#"],
    ["cafe\u0301 and café", "?"],
    ["👩🏽‍💻 family 👨‍👩‍👧‍👦", " \t "],
    ["**重要** — 🧭 and a label longer than thirty characters", "#"],
  ])("preserves label %j when replacing destination %j", (label, href) => {
    const link = `[${label}](${href})`;
    const doc = `🌍 Before ${link}; after [valid](./guide.md).\r\n`;
    const expected = `🌍 Before [${label}](TODO); after [valid](./guide.md).\r\n`;
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe(link);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    const remaining = lintDocument(expected, { rules: [ruleInvalidLinkTarget] });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(expected, remaining)).toBe(expected);
  });
});
