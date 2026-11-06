import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleMissingAltText } from "./mdlint";

describe("image autofix preserves file extensions", () => {
  it.each([
    ["", "photo.jpg"],
    [" \t ", "../assets/diagram.svg"],
    ["", "images/archive.preview.PNG"],
    [" \t ", "https://example.com/caf%C3%A9.webp?size=2#preview"],
  ])("preserves missing description %j with source %s", (alt, source) => {
    const image = `![${alt}](${source})`;
    const doc = `Before ${image} after.\r\n`;
    const expected = `Before ![TODO: describe image](${source}) after.\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
    expect(applyAllFixes(expected, lintDocument(expected, { rules }))).toBe(expected);
  });

  it("preserves each extension when fixing multiple images with the built-in rules", () => {
    const doc =
      "---\ntitle: Images\n---\n\nSee ![](first.jpeg) and ![ ](assets/second.svg).   \n";
    const expected =
      "---\ntitle: Images\n---\n\nSee ![TODO: describe image](first.jpeg) and ![TODO: describe image](assets/second.svg).\n";
    const violations = lintDocument(doc);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
      "no-trailing-spaces",
    ]);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected)).toEqual([]);
  });
});
