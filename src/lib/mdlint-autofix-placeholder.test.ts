import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

describe("autofix TODO placeholders", () => {
  it.each([
    "\n",
    "\r\n",
  ])("leaves existing link and image placeholders unchanged across passes with %j line endings", (newline) => {
    const doc = [
      "Café: [draft](TODO) and ![TODO: describe image](images/chart.png?size=2#preview).",
      "Keep the surrounding text.",
      "",
    ].join(newline);

    const violations = lintDocument(doc, { rules });
    expect(violations).toEqual([]);
    const once = applyAllFixes(doc, violations);
    expect(once).toBe(doc);
    expect(applyAllFixes(once, lintDocument(once, { rules }))).toBe(doc);
  });

  it.each([
    true,
    false,
  ])("preserves existing placeholders when fixing matching neighbors (placeholders first: %s)", (placeholdersFirst) => {
    const placeholders = "[draft](TODO) ![TODO: describe image](chart.png)";
    const broken = "[draft]() ![](chart.png)";
    const repaired = "[draft](TODO) ![TODO: describe image](chart.png)";
    const doc = `Before ${placeholdersFirst ? placeholders : broken} and ${placeholdersFirst ? broken : placeholders} after.\r\n`;
    const expected = `Before ${repaired} and ${repaired} after.\r\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    const once = applyAllFixes(doc, violations);
    expect(once).toBe(expected);
    const remaining = lintDocument(once, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(once, remaining)).toBe(expected);
  });
});
