import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("original PR 568: rule:invalid-link-target whitespace href", () => {
  it.each([
    [" ", "\n"],
    ["\t", "\r\n"],
    [" \t ", "\n"],
  ])("replaces only the whitespace-only href %j with TODO and preserves surrounding text with %j line endings", (href, newline) => {
    const prefix = `Intro paragraph.${newline}${newline}Keep  double spacing and a\ttab; read `;
    const suffix = ` — then [guide](./guide.md#links) for details.${newline}Trailing   prose stays.${newline}`;
    const link = `[draft](${href})`;
    const doc = `${prefix}${link}${suffix}`;
    const expected = `${prefix}[draft](TODO)${suffix}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(link);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.startsWith(prefix)).toBe(true);
    expect(fixed.endsWith(suffix)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});
