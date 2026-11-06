import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleMissingAltText } from "./mdlint";

describe("empty-alt image autofix preserves the source", () => {
  it.each([
    ["", "diagram.svg#layer-1"],
    [" ", "#preview"],
    ["\t", "../images/caf%C3%A9.png?size=2&mode=full#section%20one"],
    ["", 'https://example.com/chart.svg#view "Chart title"'],
  ])("preserves alt text %j's source %s", (alt, source) => {
    const image = `![${alt}](${source})`;
    const doc = `Before ${image} after.\r\n`;
    const expected = `Before ![TODO: describe image](${source}) after.\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    const remaining = lintDocument(expected, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(expected, remaining)).toBe(expected);
  });
});
