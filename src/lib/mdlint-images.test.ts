import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleMissingAltText } from "./mdlint";

describe("image alt text", () => {
  it("reports an empty alt and preserves the source when fixed", () => {
    const doc = "See ![](images/chart.png?size=2#preview) for details.\n";
    const diagnostics = lintDocument(doc).filter(
      ({ ruleId }) => ruleId === "missing-alt-text",
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "warning",
      message: "Image is missing alt text: images/chart.png?size=2#preview",
    });
    const fixed = applyFix(doc, diagnostics[0]);
    expect(fixed).toBe(
      "See ![TODO: describe image](images/chart.png?size=2#preview) for details.\n",
    );
    expect(
      lintDocument(fixed).filter(({ ruleId }) => ruleId === "missing-alt-text"),
    ).toEqual([]);
  });
});

describe("missing alt text diagnostics for two images", () => {
  it("reports both images and each fix preserves its own source", () => {
    const firstSrc = "./images/chart.png?size=2#preview";
    const secondSrc = "../assets/map.svg?view=full";
    const first = `![](${firstSrc})`;
    const second = `![   ](${secondSrc} "Map")`;
    const doc = `Intro.\nSee ${first} and ${second}.\nOutro.`;

    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });

    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(
      violations.map(({ range }) => doc.slice(range!.from.offset, range!.to.offset)),
    ).toEqual([first, second]);
    expect(violations.map((v) => v.severity)).toEqual(["warning", "warning"]);
    expect(violations.map((v) => v.message).some((m) => m.includes(firstSrc))).toBe(
      true,
    );
    expect(violations.map((v) => v.message).some((m) => m.includes(secondSrc))).toBe(
      true,
    );
    expect(violations.every(({ fix }) => fix !== null)).toBe(true);

    // Each fix keeps the image's own src (query, fragment, title).
    expect(applyFix(doc, violations[0])).toBe(
      `Intro.\nSee ![TODO: describe image](${firstSrc}) and ${second}.\nOutro.`,
    );
    expect(applyFix(doc, violations[1])).toBe(
      `Intro.\nSee ${first} and ![TODO: describe image](${secondSrc} "Map").\nOutro.`,
    );
  });

  it("applies both fixes without swapping or losing either source", () => {
    const firstSrc = "./images/chart.png?size=2#preview";
    const secondSrc = "../assets/map.svg?view=full";
    const doc = `Intro.\nSee ![](${firstSrc}) and ![ ](${secondSrc}).\nOutro.`;
    const expected = `Intro.\nSee ![TODO: describe image](${firstSrc}) and ![TODO: describe image](${secondSrc}).\nOutro.`;

    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    const fixed = applyAllFixes(doc, violations);

    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules: [ruleMissingAltText] })).toEqual([]);
    // The remaining document still contains both original sources verbatim.
    expect(fixed).toContain(firstSrc);
    expect(fixed).toContain(secondSrc);
  });
});
