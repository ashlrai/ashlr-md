import { describe, expect, it } from "vitest";
import { lintDocument, ruleMissingAltText } from "./mdlint";

describe("original PR 510: rule:missing-alt-text", () => {
  it.each(["", " ", "\t"])("flags an image with empty alt text %j", (alt) => {
    const image = `![${alt}](chart.png)`;
    const doc = `# Report\n\nSee ${image} for details.\n`;
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: "missing-alt-text",
      severity: "warning",
      message: "Image is missing alt text: chart.png",
      range: {
        from: { offset: doc.indexOf(image), line: 3, col: 4 },
        to: {
          offset: doc.indexOf(image) + image.length,
          line: 3,
          col: 4 + image.length,
        },
      },
    });
  });

  it("accepts an image with descriptive alt text", () => {
    const doc = "![Quarterly revenue chart](chart.png)\n";
    expect(lintDocument(doc, { rules: [ruleMissingAltText] })).toEqual([]);
  });

  it("detects only the image missing alt text with the default rules", () => {
    const doc = "![Quarterly revenue chart](chart.png) and ![](logo.png)\n";
    const violations = lintDocument(doc).filter((v) => v.ruleId === "missing-alt-text");

    expect(violations).toHaveLength(1);
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe("![](logo.png)");
  });
});
