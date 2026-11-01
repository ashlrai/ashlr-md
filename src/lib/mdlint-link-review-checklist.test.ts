import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyAllFixes, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

const guide = readFileSync("docs/mdlint-link-review-checklist.md", "utf8");
const rules = [ruleInvalidLinkTarget];

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("link review checklist", () => {
  it("shows the actual fix and a reviewed replacement while preserving the label", () => {
    const before = example("before");
    const violations = lintDocument(before, { rules });
    expect(violations).toHaveLength(1);
    const placeholder = applyAllFixes(before, violations);
    expect(placeholder).toBe(example("placeholder"));
    expect(lintDocument(placeholder, { rules })).toEqual([]);

    const destination = "./mdlint-link-rule-boundaries.md#what-is-checked";
    const resolved = example("resolved");
    expect(resolved).toBe(placeholder.replace("TODO", destination));
    expect(lintDocument(resolved, { rules })).toEqual([]);
    const [path, fragment] = destination.split("#");
    const target = readFileSync(resolve("docs", path), "utf8");
    expect(fragment).toBe("what-is-checked");
    expect(target).toMatch(/^## What is checked$/m);
  });

  it.each(["", "   ", "#", "?"])("generates the same placeholder for %j", (href) => {
    const before = `[label](${href})`;
    const violations = lintDocument(before, { rules });
    expect(violations).toHaveLength(1);
    expect(applyAllFixes(before, violations)).toBe("[label](TODO)");
  });
});
