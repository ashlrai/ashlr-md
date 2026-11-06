import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
  ruleNoBareUrls,
  ruleNoConsecutiveBlankLines,
  ruleNoTrailingSpaces,
} from "./mdlint";

const rules = [
  ruleInvalidLinkTarget,
  ruleMissingAltText,
  ruleNoBareUrls,
  ruleNoConsecutiveBlankLines,
  ruleNoTrailingSpaces,
];

describe("autofix around fenced code", () => {
  it.each([
    ["```", "\n"],
    ["~~~", "\r\n"],
  ])("preserves %s examples while fixing identical prose", (fence, newline) => {
    const example = "[draft]() ![](chart.png) https://example.com";
    const code = [
      `${fence}markdown`,
      `${example}   `,
      "",
      "",
      "[anchor](#) ![ ](other.svg)",
      fence,
    ].join(newline);
    const doc = [example, "", code, "", example].join(newline);
    const fixedProse =
      "[draft](TODO) ![TODO: describe image](chart.png) [https://example.com](https://example.com)";
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
      "no-bare-urls",
      "invalid-link-target",
      "missing-alt-text",
      "no-bare-urls",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe([fixedProse, "", code, "", fixedProse].join(newline));
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(fixed);
  });

  it("preserves an unclosed fence through the end of the document", () => {
    const code = "```markdown\n[draft]() ![](chart.png)\n[anchor](#)";
    const doc = `Before [draft]() and ![](chart.png).\n\n${code}`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `Before [draft](TODO) and ![TODO: describe image](chart.png).\n\n${code}`,
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});
