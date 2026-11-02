import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLintHistory,
  fixAllViolations,
  getLintHistory,
} from "../components/LinterToast";
import {
  applyAllFixes,
  applyFix,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

describe("invalid link autofix regression cases", () => {
  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("fixes destination %j in a document with no newline at all", (destination) => {
    const doc = `Read [draft](${destination}) for details`;
    const expected = "Read [draft](TODO) for details";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).not.toContain("\n");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("autofixes every invalid link when the last one ends the document without a newline", () => {
    const doc = "Intro.\r\nSee [first]() and [second](#)";
    const expected = "Intro.\r\nSee [first](TODO) and [second](TODO)";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("inserts TODO into an empty href without changing the Unicode link label", () => {
    const doc = "Read [Café ☕ guide]() for details.";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toBe("Read [Café ☕ guide](TODO) for details.");
    expect(applyAllFixes(doc, violations)).toBe(fixed);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    [
      "Read [café guide](../guides/setup.md?view=full#install), then [café guide]().\n",
      "Read [café guide](../guides/setup.md?view=full#install), then [café guide](TODO).\n",
    ],
    [
      "Read [café guide](), then [café guide](../guides/setup.md?view=full#install).\n",
      "Read [café guide](TODO), then [café guide](../guides/setup.md?view=full#install).\n",
    ],
  ])("preserves a relative link and its label while fixing a broken link", (doc, expected) => {
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("Fix all at EOF", () => {
  beforeEach(() => clearLintHistory());

  it("repairs an invalid link at EOF without adding a trailing newline", () => {
    const doc = "First line.\nRead [docs](./guide.md), then [draft](#)";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const fixed = fixAllViolations(doc, violations);
    expect(fixed).toBe("First line.\nRead [docs](./guide.md), then [draft](TODO)");
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(getLintHistory().map((entry) => entry.ruleId)).toEqual([
      "invalid-link-target",
    ]);
  });
});

describe("additional autofix regression cases", () => {
  it.each([
    "`[example]() and [anchor](#) and ![](example.png)`",
    "``[example](?) and `literal` and ![ ](example.png)``",
    "`[example]()\nand ![](example.png)`",
  ])("preserves link and image examples inside inline code: %s", (code) => {
    const doc = `Before [link](). ${code} After ![](image.png).\n`;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `Before [link](TODO). ${code} After ![TODO: describe image](image.png).\n`,
    );
    expect(lintDocument(fixed, { rules })).toHaveLength(0);
  });

  it.each([
    "",
    "   ",
    "#",
    "?",
  ])("autofixes an invalid destination %j while preserving adjacent punctuation", (href) => {
    const doc = `See ("[guide](${href})"), then continue!\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();

    const expected = 'See ("[guide](TODO)"), then continue!\n';
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it("autofixes an image on the final line without adding a newline", () => {
    const doc = "Introduction.\n\n![](diagram.png)";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations).toHaveLength(1);

    const expected = "Introduction.\n\n![TODO: describe image](diagram.png)";
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules: [ruleMissingAltText] })).toHaveLength(0);
  });
});
