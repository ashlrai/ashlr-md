import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  applyFix,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const rules = [ruleInvalidLinkTarget];

// The placeholder is `TODO`, documented in docs/mdlint-autofix-guide.md and
// docs/mdlint-placeholder-review.md: the fix replaces an empty or
// whitespace-only destination and keeps the label.
describe("invalid link autofix with a whitespace-only href", () => {
  it.each([
    " ",
    "   ",
    "\t",
    " \t ",
    "\t \t",
    "\u00a0",
    "\u2003",
    "\u3000",
    " \v\f ",
    "\u00a0 \t\u2003",
  ])("inserts the documented TODO placeholder and keeps the label (href %j)", (href) => {
    const doc = `See [café guide ☕](${href}) for details.\n`;
    const expected = "See [café guide ☕](TODO) for details.\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: "invalid-link-target",
      severity: "warning",
      message: `Invalid link target: [café guide ☕](${href})`,
    });
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`[café guide ☕](${href})`);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "\n",
    "\r\n",
  ])("keeps every label when fixing several whitespace hrefs with %j line endings", (newline) => {
    const doc = [
      "# Notes",
      "",
      "Read [the draft](   ) and [a tab link](\t),",
      "then [keep me](./guide.md) and [last]( \t ).",
      "",
    ].join(newline);
    const expected = [
      "# Notes",
      "",
      "Read [the draft](TODO) and [a tab link](TODO),",
      "then [keep me](./guide.md) and [last](TODO).",
      "",
    ].join(newline);
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(3);
    expect(
      violations.every((v) => v.ruleId === "invalid-link-target" && v.fix !== null),
    ).toBe(true);
    expect(
      violations.map((v) => doc.slice(v.range!.from.offset, v.range!.to.offset)),
    ).toEqual(["[the draft](   )", "[a tab link](\t)", "[last]( \t )"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it("keeps an empty label empty and names it 'link' in the message", () => {
    const doc = "See [](  ) here.\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toBe("Invalid link target: [link](  )");
    const expected = "See [](TODO) here.\n";
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("keeps a long label in full even though the message truncates it", () => {
    const label =
      "A very long link label that exceeds thirty characters for the message";
    const doc = `Read [${label}](  ) now.\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toBe(
      `Invalid link target: [${label.slice(0, 30)}](  )`,
    );
    const expected = `Read [${label}](TODO) now.\n`;
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("replaces an href made only of a line break, joining the lines (%j)", (inner) => {
    const doc = `A [b](${inner}) c\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const expected = "A [b](TODO) c\n";
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("fixes mixed multiline whitespace without changing a neighboring nonempty destination", () => {
    const doc = "Read [draft]( \t\n \t ) beside [draft]( ./guide.md ).\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[draft]( \t\n \t )");
    const expected = "Read [draft](TODO) beside [draft]( ./guide.md ).\n";
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("does not flag whitespace hrefs inside code spans or code blocks", () => {
    const doc = [
      "Inline `[x](  )` stays, fenced:",
      "",
      "```",
      "[y](   )",
      "```",
      "",
      "    [i](\t) indented",
      "",
      "but [z]( ) is prose.",
      "",
    ].join("\n");
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[z]( )");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(doc.replace("[z]( )", "[z](TODO)"));
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes whitespace hrefs inside list items and blockquotes", () => {
    const doc = "- item [l](  ) in a list\n> quote [q](\t) in a quote\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    const expected = "- item [l](TODO) in a list\n> quote [q](TODO) in a quote\n";
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("fixes an image's whitespace-only src while keeping its alt label", () => {
    const doc = "See ![diagram](  ) here.\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[diagram](  )");
    const expected = "See ![diagram](TODO) here.\n";
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("needs a second pass to reach TODO inside an image that gets the alt placeholder", () => {
    const doc = "A ![ ](  ) here.\n";
    const both = [ruleInvalidLinkTarget, ruleMissingAltText];
    const first = lintDocument(doc, { rules: both });

    expect(first.map((v) => v.ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    // The wider missing-alt-text fix wins the batch (see applyAllFixes); the
    // link fix applies on the next pass, as mdlint-placeholder-review.md
    // describes.
    const once = applyAllFixes(doc, first);
    expect(once).toBe("A ![TODO: describe image](  ) here.\n");
    const second = lintDocument(once, { rules: both });
    expect(second.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const twice = applyAllFixes(once, second);
    expect(twice).toBe("A ![TODO: describe image](TODO) here.\n");
    expect(lintDocument(twice, { rules: both })).toEqual([]);
  });
});
