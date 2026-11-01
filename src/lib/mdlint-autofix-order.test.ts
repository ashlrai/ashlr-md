import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

describe("autofix ordering", () => {
  it.each([
    "\n",
    "\r\n",
  ])("fixes an undescribed image and invalid link in either order with %j line endings", (newline) => {
    const image = "![](images/café.png)";
    const link = "[draft](#)";
    const fixedImage = "![TODO: describe image](images/café.png)";
    const fixedLink = "[draft](TODO)";

    for (const imageFirst of [true, false]) {
      for (const separator of [" between ", `${newline}Between lines: `]) {
        const doc = `Intro ☕${newline}Before ${imageFirst ? image : link}${separator}${imageFirst ? link : image} after.${newline}Closing prose.`;
        const expected = `Intro ☕${newline}Before ${imageFirst ? fixedImage : fixedLink}${separator}${imageFirst ? fixedLink : fixedImage} after.${newline}Closing prose.`;

        for (const rules of [
          [ruleInvalidLinkTarget, ruleMissingAltText],
          [ruleMissingAltText, ruleInvalidLinkTarget],
        ]) {
          const violations = lintDocument(doc, { rules });
          expect(violations.map((violation) => violation.ruleId)).toEqual(
            imageFirst
              ? ["missing-alt-text", "invalid-link-target"]
              : ["invalid-link-target", "missing-alt-text"],
          );
          expect(
            violations.map(({ range }) =>
              doc.slice(range!.from.offset, range!.to.offset),
            ),
          ).toEqual(imageFirst ? [image, link] : [link, image]);
          expect(violations.every(({ fix }) => fix !== null)).toBe(true);

          expect(applyAllFixes(doc, violations)).toBe(expected);
          expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
          const remaining = lintDocument(expected, { rules });
          expect(remaining).toEqual([]);
          expect(applyAllFixes(expected, remaining)).toBe(expected);
        }
      }
    }
  });
});
