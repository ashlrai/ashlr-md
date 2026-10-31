import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

describe("link and image autofix with no matches", () => {
  it.each([
    ["single line without a final newline", "A short, ordinary sentence."],
    ["LF and a final newline", "First paragraph.\n\nAnother sentence follows.\n"],
    [
      "CRLF without a final newline",
      "First paragraph.\r\n\r\nAnother sentence follows.",
    ],
    ["CRLF and a final newline", "Café ☕ and e\u0301.\r\nA second line.\r\n"],
    [
      "punctuation and whitespace",
      "Wait (really)? Yes! [A note], then a tab:\tend.  \n",
    ],
  ])("preserves %s exactly through repeated passes", (_name, doc) => {
    const violations = lintDocument(doc, { rules });
    expect(violations).toEqual([]);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(doc);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(doc);
  });

  it("preserves an image with descriptive alt text when autofixing", () => {
    const image = '![A red fox resting in snow](images/fox.png?size=2 "Fox")';
    const rules = [ruleMissingAltText];
    const doc = `Wildlife: ${image}.\r\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);

    const withMissingAlt = `${doc}Another: ![](images/bird.png).\r\n`;
    const pending = lintDocument(withMissingAlt, { rules });
    expect(pending.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(withMissingAlt, pending);
    expect(fixed).toBe(`${doc}Another: ![TODO: describe image](images/bird.png).\r\n`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("detects and fixes a broken link and an image missing alt text", () => {
    const doc = "Read [draft]() and see ![](chart.png).";
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Read [draft](TODO) and see ![TODO: describe image](chart.png).",
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});
