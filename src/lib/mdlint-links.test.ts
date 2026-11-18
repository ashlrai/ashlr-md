import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("empty link destinations", () => {
  it("identifies the link and fixes it without changing surrounding text", () => {
    const doc = "Introduction\nSee [draft]() beside [guide](guide.md).\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: "invalid-link-target",
      message: "Invalid link target: [draft](empty)",
      severity: "warning",
      range: {
        from: { offset: 17, line: 2, col: 4 },
        to: { offset: 26, line: 2, col: 13 },
      },
    });
    expect(violations[0].fix).toBeTypeOf("function");
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toBe("Introduction\nSee [draft](TODO) beside [guide](guide.md).\n");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("reports every empty or whitespace-only destination and preserves adjacent prose (%j)", (newline) => {
    const links = ["[draft]()", "[draft](   )", "[draft](\t)", "[draft]( \t )"];
    const lines = [
      "Introduction: café ☕.",
      `Read ${links[0]}, then ${links[1]} beside [draft](guide.md);`,
      `keep ${links[2]} and (${links[3]}) for later.`,
      "Conclusion stays here.",
      "",
    ];
    const doc = lines.join(newline);
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(links.length);
    for (const [index, violation] of violations.entries()) {
      const link = links[index];
      const offset = doc.indexOf(link);
      expect(violation).toMatchObject({
        ruleId: "invalid-link-target",
        severity: "warning",
        range: {
          from: { offset },
          to: { offset: offset + link.length },
        },
      });
      expect(violation.fix).toBeTypeOf("function");
      expect(applyFix(doc, violation)).toBe(doc.replace(link, "[draft](TODO)"));
    }

    const expected = [
      "Introduction: café ☕.",
      "Read [draft](TODO), then [draft](TODO) beside [draft](guide.md);",
      "keep [draft](TODO) and ([draft](TODO)) for later.",
      "Conclusion stays here.",
      "",
    ].join(newline);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});
