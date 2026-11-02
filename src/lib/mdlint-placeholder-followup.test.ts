import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const guide = readFileSync("docs/mdlint-placeholder-followup.md", "utf8");
const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("placeholder follow-up guide", () => {
  it.each([
    ["link", "invalid-link-target", "TODO", "./release-notes.md"],
    [
      "image",
      "missing-alt-text",
      "TODO: describe image",
      "Diagram of the sync engine's three layers",
    ],
  ])("shows what replaces the %s placeholder, and only it", (name, ruleId, placeholder, replacement) => {
    const before = example(`${name} before`);
    const violations = lintDocument(before, { rules });
    expect(violations.map((v) => v.ruleId)).toEqual([ruleId]);
    const generated = applyAllFixes(before, violations);
    expect(generated).toBe(example(`${name} placeholder`));
    // The warning clears even though the author has not supplied content.
    expect(lintDocument(generated, { rules })).toEqual([]);
    const replaced = example(`${name} replaced`);
    expect(replaced).not.toContain("TODO");
    // Only the placeholder text changes; label, source and prose stay.
    expect(replaced).toBe(generated.replace(placeholder, replacement));
    expect(lintDocument(replaced, { rules })).toEqual([]);
  });

  it("documents the image-destination form the link rule also writes", () => {
    // `![]()` has an empty source, so missing-alt-text cannot fix it; the
    // link rule writes the TODO destination the guide tells readers to fill.
    const violations = lintDocument("![]()", { rules });
    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(applyAllFixes("![]()", violations)).toBe("![](TODO)");
    expect(guide).toContain("`![](TODO)`");
  });
});
