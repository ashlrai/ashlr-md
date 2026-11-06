import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleMissingAltText } from "./mdlint";

describe("autofix: undescribed image with trailing punctuation", () => {
  const rules = [ruleMissingAltText];
  const image = '![](images/chart.png?v=2#top "Chart")';
  const repaired = '![TODO: describe image](images/chart.png?v=2#top "Chart")';

  it.each([
    ["a period", "."],
    ["a comma", ","],
    ["a semicolon", ";"],
    ["a colon", ":"],
    ["a question mark", "?"],
    ["an exclamation point", "!"],
    ["an ellipsis", "…"],
    ["a CJK full stop", "。"],
  ])("inserts the placeholder before %s and keeps the mark byte-for-byte", (_name, punct) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `Intro.${nl}${nl}See ${image}${punct} then *notes*.${nl}Tail.${nl}`;
      const expected = `Intro.${nl}${nl}See ${repaired}${punct} then *notes*.${nl}Tail.${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
      const { from, to } = violations[0].range!;
      // The range covers the image only — the trailing mark stays outside it.
      expect(doc.slice(from.offset, to.offset)).toBe(image);
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // Everything after the repaired image, punctuation included, is unchanged.
      expect(fixed.slice(from.offset + repaired.length)).toBe(doc.slice(to.offset));
      expect(lintDocument(fixed, { rules })).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });

  it.each([
    ["an ellipsis run", "..."],
    ["stacked question and exclamation marks", "?!"],
    ["a closing parenthesis and period", ")."],
    ["a closing curly quote", "”"],
    ["an em dash", "—"],
    ["closing CJK bracket and full stop", "」。"],
  ])("inserts the placeholder ahead of %s that ends the line", (_name, punct) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `Notes:${nl}See ${image}${punct}${nl}Next line.${nl}`;
      const expected = `Notes:${nl}See ${repaired}${punct}${nl}Next line.${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
      const { to } = violations[0].range!;
      expect(doc.slice(to.offset)).toBe(`${punct}${nl}Next line.${nl}`);
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it.each([
    ["empty", ""],
    ["space-only", " "],
    ["tab-only", "\t"],
  ])("keeps trailing punctuation after a %s alt at the end of the document", (_name, alt) => {
    for (const punct of [".", "!?", "…)"]) {
      const doc = `Look: ![${alt}](a.png)${punct}`;
      const expected = `Look: ![TODO: describe image](a.png)${punct}`;
      const violations = lintDocument(doc, { rules });

      expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(`![${alt}](a.png)`);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // No newline is added and the punctuation still ends the document.
      expect(fixed.endsWith(punct)).toBe(true);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it("fixes each of several images on one line, each closed by different punctuation", () => {
    const doc = "See ![](a.png), ![ ](b.png); and ![](c.png)! Done.\n";
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
      "missing-alt-text",
    ]);
    // A single fix touches only its own image and leaves the other marks.
    expect(applyFix(doc, violations[0])).toBe(
      "See ![TODO: describe image](a.png), ![ ](b.png); and ![](c.png)! Done.\n",
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "See ![TODO: describe image](a.png), ![TODO: describe image](b.png); and ![TODO: describe image](c.png)! Done.\n",
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["a blockquote", `> See ${image}.\n`, `> See ${repaired}.\n`],
    ["a list item", `- See ${image}.\n`, `- See ${repaired}.\n`],
    [
      "a table cell",
      `| Pic |\n| --- |\n| See ${image}. |\n`,
      `| Pic |\n| --- |\n| See ${repaired}. |\n`,
    ],
  ])("keeps the trailing mark inside %s", (_name, doc, expected) => {
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("makes the same repair under the full default rule set", () => {
    const doc = "---\ntitle: Guide\n---\n\nSee ![](chart.png).\n";
    const violations = lintDocument(doc);

    expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "---\ntitle: Guide\n---\n\nSee ![TODO: describe image](chart.png).\n",
    );
    expect(lintDocument(fixed)).toEqual([]);
  });
});
