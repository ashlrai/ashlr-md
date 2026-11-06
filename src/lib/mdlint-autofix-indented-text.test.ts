import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

const rules = [ruleInvalidLinkTarget];

describe("invalid link autofix in indented prose", () => {
  it.each([
    ["one space", " ", "\n"],
    ["two spaces", "  ", "\r\n"],
    ["three spaces", "   ", "\n"],
  ])("preserves %s around a link", (_name, indent, newline) => {
    const doc = [
      "Earlier paragraph.",
      "",
      `${indent}Before [draft](?) after.  `,
      `${indent}Next line remains indented.`,
      "",
    ].join(newline);
    const expected = doc.replace("[draft](?)", "[draft](TODO)");
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    expect(from.line).toBe(3);
    expect(from.col).toBe(indent.length + "Before ".length);
    expect(doc.slice(from.offset, to.offset)).toBe("[draft](?)");
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    "    ",
    "\t",
  ])("fixes a link in a paragraph continuation indented with %j", (indent) => {
    const doc = `Opening prose\n${indent}before [draft]() after\n  last line\n`;
    const expected = `Opening prose\n${indent}before [draft](TODO) after\n  last line\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe("[draft]()");
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("leaves an indented code block alone while fixing nearby prose", () => {
    const doc = "    [sample](?)\n\n  Read [draft](#) here.\n";
    const expected = "    [sample](?)\n\n  Read [draft](TODO) here.\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe("[draft](#)");
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });
});
