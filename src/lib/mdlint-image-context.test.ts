import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleMissingAltText } from "./mdlint";

describe("missing image description in prose", () => {
  it.each([
    "\n",
    "\r\n",
  ])("preserves the surrounding prose and image source with %j line endings", (nl) => {
    const source = 'images/chart.png?v=2#details "Chart"';
    const image = `![](${source})`;
    const doc = `An overview comes first.${nl}See ${image} for the results.${nl}More details follow.${nl}`;
    const expected = `An overview comes first.${nl}See ![TODO: describe image](${source}) for the results.${nl}More details follow.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(violations[0].fix).not.toBeNull();
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe(image);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});
