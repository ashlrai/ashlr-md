import { describe, expect, it } from "vitest";
import { applyFix, lintDocument } from "./mdlint";

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
