import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const guide = readFileSync("docs/mdlint-image-review-checklist.md", "utf8");
const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("image review checklist", () => {
  it("shows the real generated placeholder and a reviewed replacement", () => {
    const before = example("before");
    const violations = lintDocument(before, { rules });
    expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    const generated = applyAllFixes(before, violations);
    expect(generated).toBe(example("generated"));
    expect(lintDocument(generated, { rules })).toEqual([]);
    expect(example("reviewed")).toBe(
      generated.replace(
        "TODO: describe image",
        "Revenue rose from $1 million in January to $2 million in June",
      ),
    );
    expect(lintDocument(example("reviewed"), { rules })).toEqual([]);
  });

  it("shows why an empty source needs another lint pass", () => {
    const before = "![]()";
    const first = lintDocument(before, { rules });
    expect(first.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const sourceFixed = applyAllFixes(before, first);
    expect(sourceFixed).toBe("![](TODO)");
    const second = lintDocument(sourceFixed, { rules });
    expect(second.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    expect(applyAllFixes(sourceFixed, second)).toBe("![TODO: describe image](TODO)");
  });
});
