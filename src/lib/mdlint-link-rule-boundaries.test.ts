import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyAllFixes, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

const guide = readFileSync("docs/mdlint-link-rule-boundaries.md", "utf8");
const rules = [ruleInvalidLinkTarget];

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("link rule boundary guide", () => {
  it("shows the reported links and the exact result of Fix all", () => {
    const before = example("before");
    const violations = lintDocument(before, { rules });
    expect(violations.map((v) => v.severity)).toEqual(Array(5).fill("warning"));
    expect(
      violations.map((v) => before.slice(v.range!.from.offset, v.range!.to.offset)),
    ).toEqual([
      "[draft]()",
      "[notes](   )",
      "[section](#)",
      "[search](?)",
      "[chart](?)",
    ]);
    const after = applyAllFixes(before, violations);
    expect(after).toBe(example("after"));
    expect(lintDocument(after, { rules })).toEqual([]);
  });

  it.each([
    "",
    " ",
    "\t",
    "\n",
    " \r\n\t",
    "#",
    "?",
  ])("flags and replaces destination %j", (href) => {
    const doc = `before [label](${href}) after`;
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(applyAllFixes(doc, violations)).toBe("before [label](TODO) after");
  });

  it.each([
    " # ",
    " ? ",
    "#setup",
    "?page=2",
    "TODO",
    "??",
    "./missing.md",
  ])("does not flag destination %j", (href) => {
    expect(lintDocument(`[label](${href})`, { rules })).toEqual([]);
  });

  it("ignores reference links, code, and matches crossing masked spans", () => {
    const doc = [
      "[reference][id]",
      "`[code](?)`",
      "$[math](#)$",
      "[cross `code`](?)",
      "",
      "```md",
      "[fenced](?)",
      "```",
      "",
      "    [indented](#)",
      "",
      "[prose](?)",
    ].join("\n");
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe("[prose](?)");
  });
});
