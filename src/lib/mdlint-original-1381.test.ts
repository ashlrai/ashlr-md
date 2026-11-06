import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleMissingAltText } from "./mdlint";

describe("original 1381: autofix: undescribed image with surrounding punctuation", () => {
  const rules = [ruleMissingAltText];

  it.each([
    [
      "colon before",
      "Look: ![](fig.png) next.\n",
      "Look: ![TODO: describe image](fig.png) next.\n",
    ],
    [
      "closing paren before",
      "Ref: (![](fig.png) and more).\n",
      "Ref: (![TODO: describe image](fig.png) and more).\n",
    ],
    [
      "opening quote before",
      'Look "![](fig.png) is a quote.\n',
      'Look "![TODO: describe image](fig.png) is a quote.\n',
    ],
    [
      "period after",
      "See ![](fig.png). Done.\n",
      "See ![TODO: describe image](fig.png). Done.\n",
    ],
    [
      "comma after",
      "See ![](fig.png), done.\n",
      "See ![TODO: describe image](fig.png), done.\n",
    ],
    [
      "paren + period after",
      "See ![](fig.png)). Done.\n",
      "See ![TODO: describe image](fig.png)). Done.\n",
    ],
    [
      "em dash on both sides",
      "—![](fig.png)—.\n",
      "—![TODO: describe image](fig.png)—.\n",
    ],
    [
      "colon before, period after",
      "Note: ![](fig.png). Done.\n",
      "Note: ![TODO: describe image](fig.png). Done.\n",
    ],
    [
      "parens on both sides",
      "(See ![](fig.png)).\n",
      "(See ![TODO: describe image](fig.png)).\n",
    ],
    [
      "quotes on both sides",
      '"![](fig.png)".\n',
      '"![TODO: describe image](fig.png)".\n',
    ],
  ])("describes the image and preserves %s (LF)", (_name, doc, expected) => {
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyFix(doc, violations[0])).toBe(expected);

    // Idempotent: second pass makes no further changes.
    const reViolations = lintDocument(fixed, { rules });
    expect(reViolations).toEqual([]);
    expect(applyAllFixes(fixed, reViolations)).toBe(fixed);
  });

  it.each([
    [
      "colon before",
      "Look: ![](fig.png) next.\r\n",
      "Look: ![TODO: describe image](fig.png) next.\r\n",
    ],
    [
      "period after",
      "See ![](fig.png). Done.\r\n",
      "See ![TODO: describe image](fig.png). Done.\r\n",
    ],
    [
      "parens on both sides",
      "(See ![](fig.png)).\r\n",
      "(See ![TODO: describe image](fig.png)).\r\n",
    ],
    [
      "em dash on both sides",
      "—![](fig.png)—.\r\n",
      "—![TODO: describe image](fig.png)—.\r\n",
    ],
    [
      "quotes on both sides",
      '"![](fig.png)".\r\n',
      '"![TODO: describe image](fig.png)".\r\n',
    ],
  ])("describes the image and preserves %s (CRLF)", (_name, doc, expected) => {
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyFix(doc, violations[0])).toBe(expected);

    const reViolations = lintDocument(fixed, { rules });
    expect(reViolations).toEqual([]);
    expect(applyAllFixes(fixed, reViolations)).toBe(fixed);
  });

  it("inserts the placeholder for an image at document start followed by punctuation", () => {
    const doc = "![](chart.png). This is the first line.\n";
    const expected = "![TODO: describe image](chart.png). This is the first line.\n";
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(violations[0].range!.from.offset).toBe(0);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyFix(doc, violations[0])).toBe(expected);
    // Punctuation and following text are byte-identical.
    expect(fixed.slice(fixed.indexOf(")."))).toBe(doc.slice(doc.indexOf(").")));
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    [
      "![](a.png),![](b.png).",
      "![TODO: describe image](a.png),![TODO: describe image](b.png).",
    ],
    [
      "(![](a.png)); ![ ](b.png)!",
      "(![TODO: describe image](a.png)); ![TODO: describe image](b.png)!",
    ],
  ])("fixes multiple adjacent undescribed images separated by punctuation (%s)", (body, repaired) => {
    const doc = `${body}\n`;
    const expected = `${repaired}\n`;
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("original 1381: malformed opening quote fixture", () => {
  it("does not treat the original malformed fixture as an image", () => {
    const doc = 'Look "!\t](fig.png) is a quote.\n';
    const originalExpected = 'Look "![TODO: describe image](fig.png) is a quote.\n';
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
    expect(doc).not.toBe(originalExpected);
  });
});
