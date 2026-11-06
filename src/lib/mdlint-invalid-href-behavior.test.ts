import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyAllFixes, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

const guide = readFileSync("docs/mdlint-invalid-href-behavior.md", "utf8");
const rules = [ruleInvalidLinkTarget];

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("invalid href behavior guide", () => {
  it("shows all four warning cases and the resulting placeholders", () => {
    const before = example("before");
    const violations = lintDocument(before, { rules });
    expect(
      violations.map((v) => before.slice(v.range!.from.offset, v.range!.to.offset)),
    ).toEqual(["[draft]()", "[notes](   )", "[section](#)", "[search](?)"]);
    const after = applyAllFixes(before, violations);
    expect(after).toBe(example("after"));
    expect(lintDocument(after, { rules })).toEqual([]);
  });

  it.each([
    " # ",
    " ? ",
    "#setup",
    "?page=2",
    "./guide.md",
  ])("does not flag the nonempty destination %j", (href) => {
    expect(lintDocument(`[label](${href})`, { rules })).toEqual([]);
  });

  it("fixes an image destination while preserving the image marker and label", () => {
    const doc = "![chart](?)";
    expect(applyAllFixes(doc, lintDocument(doc, { rules }))).toBe("![chart](TODO)");
  });
});
