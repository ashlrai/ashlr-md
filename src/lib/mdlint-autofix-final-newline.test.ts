import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  applyFix,
  lintDocument,
  ruleFrontmatterRequired,
  ruleInvalidLinkTarget,
  ruleMaxHeadingDepth,
  ruleMissingAltText,
  ruleNoTrailingSpaces,
} from "./mdlint";

describe("invalid link autofix and final newlines", () => {
  it.each([
    ["LF without a final newline", "\n", false],
    ["LF with a final newline", "\n", true],
    ["CRLF without a final newline", "\r\n", false],
    ["CRLF with a final newline", "\r\n", true],
  ])("preserves %s", (_name, newline, finalNewline) => {
    for (const linkOnLastLine of [false, true]) {
      const lines = linkOnLastLine
        ? ["Intro: café", "Read [draft]()"]
        : ["Read [draft]()", "Closing: café"];
      const ending = finalNewline ? newline : "";
      const doc = lines.join(newline) + ending;
      const expected = doc.replace("[draft]()", "[draft](TODO)");
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed.endsWith("\n")).toBe(finalNewline);
      const remaining = lintDocument(fixed, { rules });
      expect(remaining).toEqual([]);
      expect(applyAllFixes(fixed, remaining)).toBe(expected);
    }
  });
});

describe("batched autofixes and final newlines", () => {
  it.each([
    ["LF without a final newline", "\n", false],
    ["LF with a final newline", "\n", true],
    ["CRLF without a final newline", "\r\n", false],
    ["CRLF with a final newline", "\r\n", true],
  ])("preserves %s while applying positional and document-level fixes", (_name, eol, finalNewline) => {
    const ending = finalNewline ? eol : "";
    const doc =
      ["#### Heading", "Read [draft]() and ![](image.png).", "Final line   "].join(
        eol,
      ) + ending;
    const expected =
      [
        "---",
        "title: ",
        "tags: []",
        "---",
        "",
        "### Heading",
        "Read [draft](TODO) and ![TODO: describe image](image.png).",
        "Final line",
      ].join(eol) + ending;
    const rules = [
      ruleFrontmatterRequired,
      ruleMaxHeadingDepth,
      ruleInvalidLinkTarget,
      ruleMissingAltText,
      ruleNoTrailingSpaces,
    ];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "max-heading-depth",
      "invalid-link-target",
      "missing-alt-text",
      "no-trailing-spaces",
      "frontmatter-required",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(finalNewline);
    // The generated frontmatter's blank title has a trailing space, so a
    // second pass removes it while preserving the original final newline too.
    const remaining = lintDocument(fixed, { rules });
    expect(remaining.map((violation) => violation.ruleId)).toEqual([
      "no-trailing-spaces",
    ]);
    const fixedAgain = applyAllFixes(fixed, remaining);
    expect(fixedAgain).toBe(expected.replace("title: ", "title:"));
    expect(fixedAgain.endsWith("\n")).toBe(finalNewline);
    expect(lintDocument(fixedAgain, { rules })).toEqual([]);
  });
});
