import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  applyFix,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

describe("placeholder autofixes at document edges", () => {
  it.each([
    ["[draft]()", "[draft](TODO)", "invalid-link-target"],
    [
      "![](images/chart.png)",
      "![TODO: describe image](images/chart.png)",
      "missing-alt-text",
    ],
  ])("fixes a standalone %s", (source, replacement, ruleId) => {
    const violations = lintDocument(source, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([ruleId]);
    expect(violations[0].range?.from.offset).toBe(0);
    expect(violations[0].range?.to.offset).toBe(source.length);
    expect(applyFix(source, violations[0])).toBe(replacement);
    expect(applyAllFixes(source, violations)).toBe(replacement);
    expect(lintDocument(replacement, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes both edges while preserving intervening text with %j line endings", (newline) => {
    for (const imageFirst of [false, true]) {
      const link = "[draft](#)";
      const image = "![](images/café.png?size=2#preview)";
      const fixedLink = "[draft](TODO)";
      const fixedImage = "![TODO: describe image](images/café.png?size=2#preview)";
      const first = imageFirst ? image : link;
      const last = imageFirst ? link : image;
      const fixedFirst = imageFirst ? fixedImage : fixedLink;
      const fixedLast = imageFirst ? fixedLink : fixedImage;
      const middle = ` — Intro ☕${newline}${newline}Keep [valid](guide.md) and this text.${newline}End: `;
      const doc = first + middle + last;
      const expected = fixedFirst + middle + fixedLast;
      const violations = lintDocument(doc, { rules });

      expect(violations.map(({ ruleId }) => ruleId)).toEqual(
        imageFirst
          ? ["missing-alt-text", "invalid-link-target"]
          : ["invalid-link-target", "missing-alt-text"],
      );
      expect(
        violations.map(({ range }) => [range?.from.offset, range?.to.offset]),
      ).toEqual([
        [0, first.length],
        [doc.length - last.length, doc.length],
      ]);
      expect(applyFix(doc, violations[0])).toBe(fixedFirst + middle + last);
      expect(applyFix(doc, violations[1])).toBe(first + middle + fixedLast);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
      const remaining = lintDocument(fixed, { rules });
      expect(remaining).toEqual([]);
      expect(applyAllFixes(fixed, remaining)).toBe(expected);
    }
  });
});
