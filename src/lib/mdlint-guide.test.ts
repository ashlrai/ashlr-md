import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
  ruleNoBareUrls,
} from "./mdlint";

const guide = readFileSync("docs/mdlint-autofix-guide.md", "utf8");
const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

function example(name: string): string {
  const marker = `<!-- example: ${name} -->\n`;
  const section = guide.split(marker);
  expect(section).toHaveLength(2);
  const match = section[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("Markdown autofix guide examples", () => {
  it.each([
    [
      "links",
      [
        "invalid-link-target",
        "invalid-link-target",
        "invalid-link-target",
        "invalid-link-target",
      ],
    ],
    ["images", ["missing-alt-text", "missing-alt-text"]],
  ])("shows the actual %s fixes", (name, expectedRules) => {
    const input = example(`${name} input`);
    const violations = lintDocument(input, { rules });
    expect(violations.map((v) => v.ruleId)).toEqual(expectedRules);
    const result = applyAllFixes(input, violations);
    expect(result).toBe(example(`${name} output`));
    expect(lintDocument(result, { rules })).toEqual([]);
  });

  it("shows both passes for overlapping image and destination fixes", () => {
    const input = example("overlap input");
    const violations = lintDocument(input, { rules });
    expect(violations.map((v) => v.ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    const first = applyAllFixes(input, violations);
    expect(first).toBe(example("overlap first"));
    const remaining = lintDocument(first, { rules });
    expect(remaining.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const second = applyAllFixes(first, remaining);
    expect(second).toBe(example("overlap second"));
    expect(lintDocument(second, { rules })).toEqual([]);
  });

  it("shows the bare URL fix", () => {
    const input = example("urls input");
    const urlRules = [ruleNoBareUrls];
    const violations = lintDocument(input, { rules: urlRules });
    expect(violations.map((v) => v.ruleId)).toEqual(["no-bare-urls"]);
    const result = applyAllFixes(input, violations);
    expect(result).toBe(example("urls output"));
    expect(lintDocument(result, { rules: urlRules })).toEqual([]);
  });
});
