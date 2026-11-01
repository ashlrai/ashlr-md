import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const guide = readFileSync("docs/mdlint-combined-fix-example.md", "utf8");

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("combined link and image fix example", () => {
  it("matches the LF case in the autofix suite and remains unchanged on a second pass", () => {
    const input = example("input");
    const output = example("output");
    expect(input).toBe("Read [draft]() and see ![](chart.png) for details [note]\n");
    expect(output).toBe(
      "Read [draft](TODO) and see ![TODO: describe image](chart.png) for details [note]\n",
    );

    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(input, { rules });
    expect(violations.map(({ ruleId }) => ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    expect(applyAllFixes(input, violations)).toBe(output);
    const remaining = lintDocument(output, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(output, remaining)).toBe(output);
  });
});
