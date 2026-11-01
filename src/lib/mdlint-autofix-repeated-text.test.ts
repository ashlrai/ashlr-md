import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("invalid link autofix with repeated prose", () => {
  it.each([
    ["\n", ""],
    ["\n", "\n"],
    ["\r\n", ""],
    ["\r\n", "\r\n"],
  ])("preserves every repetition with separator %j and ending %j", (newline, ending) => {
    const prose = "Café ☕ — the same words appear here.";
    const link = "[draft](#)";
    const fixedLink = "[draft](TODO)";
    const doc = [prose, `${prose} ${link} ${prose}`, prose].join(newline) + ending;
    const expected =
      [prose, `${prose} ${fixedLink} ${prose}`, prose].join(newline) + ending;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    const range = violations[0].range!;
    expect(doc.slice(range.from.offset, range.to.offset)).toBe(link);
    expect(range.from.offset).toBe(doc.indexOf(link));
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.split(prose)).toHaveLength(5);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });
});
