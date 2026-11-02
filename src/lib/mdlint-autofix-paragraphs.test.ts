import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

describe("autofix across separate paragraphs", () => {
  it.each([
    ["\n", false],
    ["\n", true],
    ["\r\n", false],
    ["\r\n", true],
  ])("preserves paragraphs with line ending %j and image first: %s", (newline, imageFirst) => {
    const link = "Read [draft](?) for details.";
    const image = "See ![](images/café.png?size=2#chart) for context.";
    const fixedLink = "Read [draft](TODO) for details.";
    const fixedImage =
      "See ![TODO: describe image](images/café.png?size=2#chart) for context.";
    const intro = "Intro: keep  spacing and punctuation!";
    const middle = "Unrelated prose with [a valid link](./guide.md).";
    const end = "Closing prose remains unchanged. ☕";
    // Keep both one and two blank lines between paragraphs, plus a final newline.
    const separator = newline.repeat(2);
    const wideSeparator = newline.repeat(3);
    const doc =
      [intro, imageFirst ? image : link, middle].join(separator) +
      wideSeparator +
      [imageFirst ? link : image, end].join(separator) +
      newline;
    const expected =
      [intro, imageFirst ? fixedImage : fixedLink, middle].join(separator) +
      wideSeparator +
      [imageFirst ? fixedLink : fixedImage, end].join(separator) +
      newline;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(
      imageFirst
        ? ["missing-alt-text", "invalid-link-target"]
        : ["invalid-link-target", "missing-alt-text"],
    );
    expect(violations.every(({ fix }) => fix !== null)).toBe(true);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    const remaining = lintDocument(expected, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(expected, remaining)).toBe(expected);
  });
});
