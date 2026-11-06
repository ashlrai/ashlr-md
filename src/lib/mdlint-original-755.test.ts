import { describe, expect, it } from "vitest";
import { applyAllFixes, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("original PR 755: multi-line invalid link fixes", () => {
  it("replaces each invalid href across multiple lines with TODO while leaving all other lines untouched", () => {
    const doc =
      "---\ntitle: Multi-link document\n---\n\n" +
      "Start with [alpha]() which is empty.\n" +
      "Also [valid](./keep.md) stays.\n" +
      "```\n" +
      "[code](#) in a fence is untouched\n" +
      "```\n\n" +
      "Later paragraph mentions [beta](   ) with spaces only.\n" +
      "And [ok](https://example.com) is fine too.\n\n" +
      "## Section\n\n" +
      "Final note: [gamma](#) is lone hash and [delta](?) is lone question.\n" +
      "This line has no links at all.\n";
    const expected =
      "---\ntitle: Multi-link document\n---\n\n" +
      "Start with [alpha](TODO) which is empty.\n" +
      "Also [valid](./keep.md) stays.\n" +
      "```\n" +
      "[code](#) in a fence is untouched\n" +
      "```\n\n" +
      "Later paragraph mentions [beta](TODO) with spaces only.\n" +
      "And [ok](https://example.com) is fine too.\n\n" +
      "## Section\n\n" +
      "Final note: [gamma](TODO) is lone hash and [delta](TODO) is lone question.\n" +
      "This line has no links at all.\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    // Four invalid links across different lines; code-fenced link is excluded.
    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((v) => v.fix !== null)).toBe(true);
    expect(violations.map((v) => v.range!.from.line)).toEqual([5, 11, 16, 16]);

    // applyAllFixes replaces every invalid href and nothing else.
    expect(applyAllFixes(doc, violations)).toBe(expected);
    // Order-independent: reverse order produces the same result.
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);

    // Unrelated lines are byte-identical.
    expect(expected).toContain("[valid](./keep.md)");
    expect(expected).toContain("[ok](https://example.com)");
    expect(expected).toContain("[code](#) in a fence is untouched");
    expect(expected).toContain("This line has no links at all.");
    // Valid link and code block lines are unchanged.
    expect(expected.split("\n")[5]).toBe(doc.split("\n")[5]);
    expect(expected.split("\n")[12]).toBe(doc.split("\n")[12]);
    expect(expected.split("\n")[17]).toBe(doc.split("\n")[17]);

    // The fixed document is clean.
    expect(lintDocument(expected, { rules })).toEqual([]);
  });
});
