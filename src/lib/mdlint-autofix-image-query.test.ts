import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleMissingAltText } from "./mdlint";

describe("image autofix with a query string", () => {
  it.each(["", " \t "])("preserves the exact source when alt text is %j", (alt) => {
    const doc = `Before ![${alt}](../images/chart%20one.png?size=2&size=4&label=A%26B&empty=#preview) after.\r\n`;
    const expected =
      "Before ![TODO: describe image](../images/chart%20one.png?size=2&size=4&label=A%26B&empty=#preview) after.\r\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });
});
