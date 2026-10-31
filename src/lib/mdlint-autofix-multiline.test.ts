import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  applyFix,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
  ruleNoTrailingSpaces,
  ruleOrphanedHeading,
} from "./mdlint";

describe("autofix across multiple lines", () => {
  it.each([
    "\n",
    "\r\n",
  ])("fixes two empty link destinations on separate lines with separator %j", (newline) => {
    const doc = [
      "Before: café.",
      "Read [first]() here.",
      "Keep this line and [valid](./guide.md) unchanged.",
      "Then read [second]() here.",
      "After: ☕.",
      "",
    ].join(newline);
    const expected = [
      "Before: café.",
      "Read [first](TODO) here.",
      "Keep this line and [valid](./guide.md) unchanged.",
      "Then read [second](TODO) here.",
      "After: ☕.",
      "",
    ].join(newline);
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.map((violation) => violation.range?.from.line)).toEqual([2, 4]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(
      doc.replace("[first]()", "[first](TODO)"),
    );
    expect(applyFix(doc, violations[1])).toBe(
      doc.replace("[second]()", "[second](TODO)"),
    );
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["\n", ""],
    ["\n", "\n"],
    ["\r\n", ""],
    ["\r\n", "\r\n"],
  ])("preserves unrelated lines with separator %j and ending %j", (newline, ending) => {
    const lines = [
      "# Café guide",
      "",
      "Read [first]() before continuing.",
      "Keep  this line and [valid](./guide.md#part) unchanged.",
      "See ![](chart.png?size=2#data).",
      "Keep this hard break.  ",
      "Remove trailing spaces here.   ",
      "Read [last](?) at the end.",
      "",
      "```md",
      "[example]() and ![](example.png)   ",
      "```",
      "Final line: ☕.",
    ];
    const expectedLines = [
      "# Café guide",
      "",
      "Read [first](TODO) before continuing.",
      "Keep  this line and [valid](./guide.md#part) unchanged.",
      "See ![TODO: describe image](chart.png?size=2#data).",
      "Keep this hard break.  ",
      "Remove trailing spaces here.",
      "Read [last](TODO) at the end.",
      "",
      "```md",
      "[example]() and ![](example.png)   ",
      "```",
      "Final line: ☕.",
    ];
    const doc = lines.join(newline) + ending;
    const expected = expectedLines.join(newline) + ending;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
      "no-trailing-spaces",
      "invalid-link-target",
    ]);
    expect(violations.map((violation) => violation.range?.from.line)).toEqual([
      3, 5, 7, 8,
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    const remaining = lintDocument(expected, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(expected, remaining)).toBe(expected);
  });

  it("applies each individual fix without altering other lines", () => {
    const doc = "Before.\n[first]()\nBetween.\n[second](#)\nAfter.";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(applyFix(doc, violations[0])).toBe(
      "Before.\n[first](TODO)\nBetween.\n[second](#)\nAfter.",
    );
    expect(applyFix(doc, violations[1])).toBe(
      "Before.\n[first]()\nBetween.\n[second](TODO)\nAfter.",
    );
    expect(applyAllFixes(doc, violations)).toBe(
      "Before.\n[first](TODO)\nBetween.\n[second](TODO)\nAfter.",
    );
  });

  it("retains an unfixable warning while fixing lines around it", () => {
    const doc = "[first]()\n\n# First\n\n## Second\n\nBody.\n\n[last](?)";
    const rules = [ruleInvalidLinkTarget, ruleOrphanedHeading];
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "orphaned-heading",
      "invalid-link-target",
    ]);
    expect(violations[1].fix).toBeNull();

    const expected = "[first](TODO)\n\n# First\n\n## Second\n\nBody.\n\n[last](TODO)";
    expect(applyAllFixes(doc, violations)).toBe(expected);
    const remaining = lintDocument(expected, { rules });
    expect(remaining.map((violation) => violation.ruleId)).toEqual([
      "orphaned-heading",
    ]);
    expect(applyAllFixes(expected, remaining)).toBe(expected);
  });
});
