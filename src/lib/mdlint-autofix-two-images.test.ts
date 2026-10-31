import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleMissingAltText } from "./mdlint";

describe("autofix two images on one line", () => {
  it.each([
    ["", "", "\n"],
    ["", " \t ", "\r\n"],
    [" \t ", "", "\n"],
    [" ", " ", "\r\n"],
  ])("fixes alt text %j and %j with line ending %j", (firstAlt, secondAlt, newline) => {
    const first = `![${firstAlt}](./images/chart%20one.png?size=2#preview)`;
    const second = `![${secondAlt}](../assets/map.svg?view=full#north "Map")`;
    const fixedFirst =
      "![TODO: describe image](./images/chart%20one.png?size=2#preview)";
    const fixedSecond =
      '![TODO: describe image](../assets/map.svg?view=full#north "Map")';
    const doc = `Intro ☕${newline}See ${first} beside ${second}.${newline}End.`;
    const expected = `Intro ☕${newline}See ${fixedFirst} beside ${fixedSecond}.${newline}End.`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(
      violations.map(({ range }) => doc.slice(range!.from.offset, range!.to.offset)),
    ).toEqual([first, second]);
    expect(violations.every(({ fix }) => fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(doc.replace(first, fixedFirst));
    expect(applyFix(doc, violations[1])).toBe(doc.replace(second, fixedSecond));
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });
});
