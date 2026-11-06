import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
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
  it.each(["link", "image"])("shows the actual %s fix and its resolution", (name) => {
    const before = example(`${name} before`);
    const violations = lintDocument(before, { rules });
    expect(violations).toHaveLength(1);
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

  it("documents both passes for an image with an empty source and alt text", () => {
    const first = applyAllFixes("![]()", lintDocument("![]()", { rules }));
    expect(first).toBe("![](TODO)");
    const second = applyAllFixes(first, lintDocument(first, { rules }));
    expect(second).toBe("![TODO: describe image](TODO)");
    expect(guide).toContain(`\`${first}\``);
    expect(guide).toContain(`\`${second}\``);
  });
});
