import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

const rules = [ruleInvalidLinkTarget];

describe("invalid link autofix with neighboring punctuation", () => {
  it.each([
    ["(", ")"],
    ["(", ")."],
    ["(", "),"],
    ['"', '"'],
    ['"', '".'],
    ["'", "'"],
    ["'", "',"],
    ["«", "»"],
    ["“", "”"],
    ["‘", "’"],
    ["‹", "›"],
    ["¿", "?"],
    ["¡", "!"],
    ["—", "—"],
    ["…", "…"],
    ["*", "*"],
    ["**", "**"],
    ["_", "_"],
    ["~", "~"],
    ["~~", "~~"],
    ["==", "=="],
    ["<", ">"],
    ["<em>", "</em>"],
    ["[", "]"],
    ["!", "!"],
    ["!", "."],
    ["\\", "\\"],
    [";", ":"],
    ["`", ""],
    ["", "`"],
    ["`x`", "`y`"],
    ["$x$", "$y$"],
    ["> ", ","],
    ["| ", " |"],
  ])("keeps %j before and %j after the link while fixing its destination", (before, after) => {
    const doc = `${before}[draft](#)${after}`;
    const expected = `${before}[draft](TODO)${after}`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it("ranges over the link only, not the punctuation touching it", () => {
    const doc = 'See ("[draft](#)"), done.\n';
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[draft](#)");
    expect(doc[from.offset - 1]).toBe('"');
    expect(doc[to.offset]).toBe('"');
    expect(doc[from.offset - 2]).toBe("(");
    expect(doc[to.offset + 1]).toBe(")");
  });

  it("preserves stacked punctuation around several links in one sentence", () => {
    const doc = 'See (("[draft](#)"))—really; then («[note](?)»)!…\n';
    const expected = 'See (("[draft](TODO)"))—really; then («[note](TODO)»)!…\n';
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("preserves the punctuation separating a chain of adjacent invalid links", () => {
    const doc = "[a](#),[b](#);[c](?)!";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(3);
    expect(applyFix(doc, violations[0])).toBe("[a](TODO),[b](#);[c](?)!");
    expect(applyFix(doc, violations[2])).toBe("[a](#),[b](#);[c](TODO)!");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("[a](TODO),[b](TODO);[c](TODO)!");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("preserves table pipes touching a link inside a tight cell", () => {
    const doc = "| h | i |\n| - | - |\n|[x](#)| y |\n";
    const expected = "| h | i |\n| - | - |\n|[x](TODO)| y |\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("keeps punctuation at both document boundaries, without a final newline", () => {
    const doc = "([draft](#)\n...\n[draft](#))";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    const expected = "([draft](TODO)\n...\n[draft](TODO))";
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["\n", ""],
    ["\n", "\n"],
    ["\r\n", ""],
    ["\r\n", "\r\n"],
  ])("keeps neighbors across lines with %j breaks and ending %j", (newline, ending) => {
    const doc =
      ['Intro: ("[first](#)"),', "then ('[second](?)');", "«[third](  )»…"].join(
        newline,
      ) + ending;
    const expected =
      [
        'Intro: ("[first](TODO)"),',
        "then ('[second](TODO)');",
        "«[third](TODO)»…",
      ].join(newline) + ending;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "invalid-link-target",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "`[draft](#)`",
    "$[draft](#)$",
    "[a](b[c](#))",
    "[draft](#.)",
    "[draft](#x)",
    "[draft](#!)",
  ])("flags no link in %j, so nothing is rewritten", (doc) => {
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(applyAllFixes(doc, [])).toBe(doc);
  });
});
