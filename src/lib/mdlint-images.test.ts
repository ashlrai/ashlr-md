import { describe, expect, it } from "vitest";
import { applyAllFixes, lintDocument, ruleMissingAltText } from "./mdlint";

describe("image alternative text", () => {
  it("accepts descriptive alt text and leaves the image unchanged", () => {
    const doc = "![A red kite flying over a green field](kite.png)\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });
});
