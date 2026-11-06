import { describe, expect, it } from "vitest";
import { applyAllFixes, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("invalid-link autofix: two invalid links on one line", () => {
  const rules = [ruleInvalidLinkTarget];
  const between = " and (aside) [not a link] — `code()` — ";

  it.each([
    ["\n"],
    ["\r\n"],
  ])("turns both destinations into TODO and keeps the text between them (%j)", (nl) => {
    const doc = `Start [one]() ${between.trim()} [two](#) end.${nl}`;
    const expected = `Start [one](TODO) ${between.trim()} [two](TODO) end.${nl}`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Everything between the two links is byte-identical.
    expect(
      fixed.slice(
        fixed.indexOf("[one](TODO)") + "[one](TODO)".length,
        fixed.indexOf("[two]"),
      ),
    ).toBe(doc.slice(doc.indexOf("[one]()") + "[one]()".length, doc.indexOf("[two]")));
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});
