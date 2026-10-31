import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("invalid link autofix line preservation", () => {
  it.each([
    ["LF", "\n", ""],
    ["LF with final newline", "\n", "\n"],
    ["CRLF", "\r\n", ""],
    ["CRLF with final newline", "\r\n", "\r\n"],
  ])("preserves paragraph boundaries and line breaks with %s", (_name, newline, ending) => {
    const doc =
      [
        "First paragraph: café.",
        "Its second line stays here.",
        "",
        "Read [draft]() before continuing.",
        "",
        "Last paragraph: ☕.",
        "Its second line stays here too.",
      ].join(newline) + ending;
    const expected =
      [
        "First paragraph: café.",
        "Its second line stays here.",
        "",
        "Read [draft](TODO) before continuing.",
        "",
        "Last paragraph: ☕.",
        "Its second line stays here too.",
      ].join(newline) + ending;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe("[draft]()");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });
});
