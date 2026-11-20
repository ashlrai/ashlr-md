import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleFrontmatterRequired,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
  type LintRule,
} from "./mdlint";

// This guide absorbed mdlint-placeholder-examples.md and
// mdlint-placeholder-editing.md; their assertions live here now.
const guide = readFileSync("docs/mdlint-placeholder-resolution.md", "utf8");
const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("placeholder resolution guide", () => {
  it("labels its resolved examples as illustrative", () => {
    expect(guide).toContain("**illustrative**");
  });

  it.each<[string, LintRule, string, string]>([
    ["link", ruleInvalidLinkTarget, "TODO", "./installation.md"],
    [
      "image",
      ruleMissingAltText,
      "TODO: describe image",
      "Sales doubled from January to June",
    ],
    ["frontmatter", ruleFrontmatterRequired, "title:\n", "title: Garden notes\n"],
  ])(
    "shows the actual %s fix and its resolution",
    (name, rule, placeholderText, resolvedText) => {
      const before = example(`${name} before`);
      const violations = lintDocument(before, { rules: [rule] });
      expect(violations.map((violation) => violation.ruleId)).toEqual([rule.id]);
      // Markdown omits the insignificant trailing space after the generated title.
      const placeholder = applyAllFixes(before, violations).replace(
        /^title: $/m,
        "title:",
      );
      expect(placeholder).toBe(example(`${name} placeholder`));
      // The warning disappears before the author has supplied meaningful content.
      expect(lintDocument(placeholder, { rules: [rule] })).toEqual([]);
      const resolved = example(`${name} resolved`);
      expect(resolved).not.toContain("TODO");
      expect(lintDocument(resolved, { rules: [rule] })).toEqual([]);
      const edited = placeholder.replace(placeholderText, resolvedText);
      expect(edited).not.toBe(placeholder);
      if (name === "frontmatter") {
        expect(resolved).toBe(edited.replace("tags: []", "tags: [garden, planning]"));
      } else {
        expect(resolved).toBe(edited);
      }
    },
  );

  it("shows the actual fix for whitespace-only alt text", () => {
    const before = example("image whitespace before");
    const violations = lintDocument(before, { rules });
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const after = applyAllFixes(before, violations);
    expect(after).toBe(example("image whitespace placeholder"));
    expect(lintDocument(after, { rules })).toEqual([]);
  });

  it("documents both passes for an image with an empty source and alt text", () => {
    const first = applyAllFixes("![]()", lintDocument("![]()", { rules }));
    expect(first).toBe("![](TODO)");
    const second = applyAllFixes(first, lintDocument(first, { rules }));
    expect(second).toBe("![TODO: describe image](TODO)");
    expect(guide).toContain(`\`${first}\``);
    expect(guide).toContain(`\`${second}\``);
  });
});
