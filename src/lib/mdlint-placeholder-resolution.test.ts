import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  LINTER_DEFAULT_ENABLED_RULES,
  lintDocument,
  ruleFrontmatterRequired,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

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
  it("labels its examples as illustrative", () => {
    expect(guide).toContain("**illustrative**");
  });

  it.each([
    ["link", "invalid-link-target"],
    ["image", "missing-alt-text"],
  ])("shows the actual %s fix and its resolution", (name, ruleId) => {
    const before = example(`${name} before`);
    const violations = lintDocument(before, { rules });
    expect(violations.map((violation) => violation.ruleId)).toEqual([ruleId]);
    const placeholder = applyAllFixes(before, violations);
    expect(placeholder).toBe(example(`${name} placeholder`));
    // The warning disappears before the author has supplied meaningful content.
    expect(lintDocument(placeholder, { rules })).toEqual([]);
    const resolved = example(`${name} resolved`);
    expect(resolved).not.toContain("TODO");
    expect(lintDocument(resolved, { rules })).toEqual([]);
    if (name === "link") {
      expect(resolved).toBe(placeholder.replace("TODO", "./installation.md"));
    } else {
      expect(resolved).toBe(
        placeholder.replace(
          "TODO: describe image",
          "Sales doubled from January to June",
        ),
      );
    }
  });

  it("treats whitespace-only alt text like empty alt text", () => {
    const before = "![  ](images/flow.png)";
    const violations = lintDocument(before, { rules });
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    expect(applyAllFixes(before, violations)).toBe(
      "![TODO: describe image](images/flow.png)",
    );
    expect(guide).toContain("empty or whitespace-only alt text");
  });

  it("shows the actual frontmatter fix and its resolution", () => {
    const frontmatterRules = [ruleFrontmatterRequired];
    const before = example("frontmatter before");
    const violations = lintDocument(before, { rules: frontmatterRules });
    expect(violations).toHaveLength(1);
    const placeholder = applyAllFixes(before, violations);
    // Markdown omits the insignificant trailing space after the generated title.
    expect(placeholder.replace(/^title: $/m, "title:")).toBe(
      example("frontmatter placeholder"),
    );
    const resolved = example("frontmatter resolved");
    expect(resolved).not.toBe(placeholder);
    expect(resolved).not.toContain("TODO");
    expect(lintDocument(resolved, { rules: frontmatterRules })).toEqual([]);
  });

  it("inventories the placeholders produced by Fix all", () => {
    const before = example("inventory before");
    const violations = lintDocument(before, { rules });
    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "missing-alt-text",
    ]);
    const after = applyAllFixes(before, violations);
    expect(after).toBe(example("inventory after"));
    expect(lintDocument(after, { rules })).toEqual([]);
  });

  it("shows both passes for overlapping image and destination fixes", () => {
    const before = example("overlap before");
    const violations = lintDocument(before, { rules });
    expect(violations.map((v) => v.ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    const first = applyAllFixes(before, violations);
    expect(first).toBe(example("overlap first"));
    const remaining = lintDocument(first, { rules });
    expect(remaining.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const second = applyAllFixes(first, remaining);
    expect(second).toBe(example("overlap second"));
    expect(lintDocument(second, { rules })).toEqual([]);
  });

  it.each([
    ["![]()", ["invalid-link-target"]],
    ["![]( )", ["invalid-link-target", "missing-alt-text"]],
    ["[label]( # )", []],
    ["[label]( ? )", []],
  ])("documents rule boundaries for %s", (doc, expected) => {
    expect(
      lintDocument(doc, { rules })
        .map((v) => v.ruleId)
        .sort(),
    ).toEqual(expected);
  });

  it("matches the frontmatter rule's default and its empty-document skip", () => {
    expect(LINTER_DEFAULT_ENABLED_RULES).toContain("invalid-link-target");
    expect(LINTER_DEFAULT_ENABLED_RULES).toContain("missing-alt-text");
    expect(LINTER_DEFAULT_ENABLED_RULES).not.toContain("frontmatter-required");
    expect(guide).toContain("`frontmatter-required` is off");
    expect(lintDocument("", { rules: [ruleFrontmatterRequired] })).toEqual([]);
    expect(guide).toContain("A nonempty document does not begin");
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
