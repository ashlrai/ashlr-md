import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  applyFix,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const guide = readFileSync("docs/mdlint-image-rule-boundaries.md", "utf8");
const rules = [ruleMissingAltText];

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("image rule boundaries guide", () => {
  it("shows the warning ranges, messages and actual placeholder fixes", () => {
    const before = example("before");
    const violations = lintDocument(before, { rules });
    expect(violations.map((v) => [v.ruleId, v.severity])).toEqual([
      ["missing-alt-text", "warning"],
      ["missing-alt-text", "warning"],
    ]);
    expect(
      violations.map((v) => before.slice(v.range!.from.offset, v.range!.to.offset)),
    ).toEqual(["![](chart.png?view=full#data)", '![  ](map.png "Map")']);
    expect(violations[0].message).toBe(
      "Image is missing alt text: chart.png?view=full#data",
    );
    expect(guide).toContain(`\`${violations[0].message}\``);
    const after = applyAllFixes(before, violations);
    expect(after).toBe(example("after"));
    expect(lintDocument(after, { rules })).toEqual([]);
  });

  it("Fix changes only the one image it targets", () => {
    const before = example("before");
    const [first] = lintDocument(before, { rules });
    const fixed = applyFix(before, first);
    expect(fixed).toBe(
      'See ![TODO: describe image](chart.png?view=full#data) and ![  ](map.png "Map").\n',
    );
    expect(lintDocument(fixed, { rules })).toHaveLength(1);
  });

  it.each(["", " ", "\t", " "])("flags whitespace-only alt %j", (alt) => {
    expect(lintDocument(`![${alt}](image.png)`, { rules })).toHaveLength(1);
  });

  it.each([
    "![]()",
    "![  ]()",
    "![description](image.png)",
    "![][image]",
    "![ ]",
  ])("does not warn for %s", (doc) => expect(lintDocument(doc, { rules })).toEqual([]));

  it("matches a whitespace-only source and stops at the first closing parenthesis", () => {
    expect(lintDocument("![]( )", { rules })).toHaveLength(1);
    const doc = "![](plot(1).png)";
    const violations = lintDocument(doc, { rules });
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe("![](plot(1)");
    expect(applyAllFixes(doc, violations)).toBe("![TODO: describe image](plot(1).png)");
  });

  it.each([
    "---\nimage: ![](image.png)\n---\n",
    "```md\n![](image.png)\n```\n",
    "    ![](image.png)\n",
    "<div>\n![](image.png)\n</div>\n",
    "`![](image.png)`",
    "$![](image.png)$",
  ])("ignores masked content %j", (doc) => {
    expect(lintDocument(doc, { rules })).toEqual([]);
  });

  it("shows why an empty source needs another lint pass", () => {
    const both = [ruleInvalidLinkTarget, ruleMissingAltText];
    const before = "![]()";
    const first = lintDocument(before, { rules: both });
    expect(first.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const sourceFixed = applyAllFixes(before, first);
    expect(sourceFixed).toBe("![](TODO)");
    expect(guide).toContain("`![](TODO)`");
    const second = lintDocument(sourceFixed, { rules: both });
    expect(second.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    expect(applyAllFixes(sourceFixed, second)).toBe("![TODO: describe image](TODO)");
  });

  it("shows the real generated placeholder and a reviewed replacement", () => {
    const both = [ruleInvalidLinkTarget, ruleMissingAltText];
    const before = example("review-before");
    const violations = lintDocument(before, { rules: both });
    expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    const generated = applyAllFixes(before, violations);
    expect(generated).toBe(example("generated"));
    expect(lintDocument(generated, { rules: both })).toEqual([]);
    expect(example("reviewed")).toBe(
      generated.replace(
        "TODO: describe image",
        "Revenue rose from $1 million in January to $2 million in June",
      ),
    );
    expect(lintDocument(example("reviewed"), { rules: both })).toEqual([]);
  });
});
