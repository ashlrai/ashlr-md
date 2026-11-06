import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleFrontmatterRequired,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const guide = readFileSync("docs/mdlint-placeholder-editing.md", "utf8");

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("placeholder editing guide", () => {
  it("labels its examples as illustrative", () => {
    expect(guide).toContain("**illustrative**");
  });

  it.each([
    ["link", ruleInvalidLinkTarget],
    ["image", ruleMissingAltText],
    ["frontmatter", ruleFrontmatterRequired],
  ])("shows the actual %s fix and an edited result", (name, rule) => {
    const before = example(`${name} before`);
    const violations = lintDocument(before, { rules: [rule] });
    expect(violations).toHaveLength(1);
    const placeholder = applyAllFixes(before, violations);
    // Markdown omits the insignificant trailing space after the generated title.
    expect(placeholder.replace(/^title: $/m, "title:")).toBe(
      example(`${name} placeholder`),
    );
    const edited = example(`${name} edited`);
    expect(edited).not.toBe(placeholder);
    expect(edited).not.toContain("TODO");
    expect(lintDocument(edited, { rules: [rule] })).toEqual([]);
  });
});
