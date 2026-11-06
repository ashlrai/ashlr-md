import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  applyFix,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
const validLink = '[café](./guide.md?view=full#images "Guide")';
const validImage = '![Café](images/caf%C3%A9.png?size=2#preview "View")';

const cases = [
  ["link beside link", validLink, "[café](#)", "[café](TODO)", "invalid-link-target"],
  ["image beside link", validImage, "[café](?)", "[café](TODO)", "invalid-link-target"],
  [
    "link beside image",
    validLink,
    "![ ](images/caf%C3%A9.png)",
    "![TODO: describe image](images/caf%C3%A9.png)",
    "missing-alt-text",
  ],
  [
    "image beside image",
    validImage,
    '![](images/caf%C3%A9.png?size=2#preview "View")',
    '![TODO: describe image](images/caf%C3%A9.png?size=2#preview "View")',
    "missing-alt-text",
  ],
] as const;

describe("autofix with valid link and image neighbors", () => {
  it.each(
    cases,
  )("preserves a valid %s in either order, even when touching", (_name, valid, invalid, repaired, ruleId) => {
    for (const separator of ["", " "]) {
      for (const validFirst of [true, false]) {
        const doc = `☕ ${validFirst ? valid : invalid}${separator}${validFirst ? invalid : valid}.\r\n`;
        const expected = `☕ ${validFirst ? valid : repaired}${separator}${validFirst ? repaired : valid}.\r\n`;
        const violations = lintDocument(doc, { rules });

        expect(violations.map((v) => v.ruleId)).toEqual([ruleId]);
        const { from, to } = violations[0].range!;
        expect(doc.slice(from.offset, to.offset)).toBe(invalid);
        expect(violations[0].fix).not.toBeNull();
        expect(applyFix(doc, violations[0])).toBe(expected);
        const fixed = applyAllFixes(doc, violations);
        expect(fixed).toBe(expected);
        expect(lintDocument(fixed, { rules })).toEqual([]);
        expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(expected);
      }
    }
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes multiple violations around valid neighbors with %j line endings", (newline) => {
    const doc = [
      `[café]()${validLink}![ ](one.png)`,
      `![](two.png)${validImage}[last](#)`,
      "See `[example](#)` and `![](example.png)`.",
    ].join(newline);
    const expected = [
      `[café](TODO)${validLink}![TODO: describe image](one.png)`,
      `![TODO: describe image](two.png)${validImage}[last](TODO)`,
      "See `[example](#)` and `![](example.png)`.",
    ].join(newline);
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
      "missing-alt-text",
      "invalid-link-target",
    ]);
    expect(
      violations.map((v) => doc.slice(v.range!.from.offset, v.range!.to.offset)),
    ).toEqual(["[café]()", "![ ](one.png)", "![](two.png)", "[last](#)"]);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("preserves valid neighbors through both passes for an image with two violations", () => {
    const doc = `${validLink}![ ](?)${validImage}`;
    const first = lintDocument(doc, { rules });
    expect(first.map((v) => v.ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    const once = applyAllFixes(doc, first);
    expect(once).toBe(`${validLink}![TODO: describe image](?)${validImage}`);
    const second = lintDocument(once, { rules });
    expect(second.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const twice = applyAllFixes(once, second);
    expect(twice).toBe(`${validLink}![TODO: describe image](TODO)${validImage}`);
    expect(lintDocument(twice, { rules })).toEqual([]);
  });
});
