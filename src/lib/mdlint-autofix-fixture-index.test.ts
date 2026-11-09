import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixtureIndex, formatMarker } from "../../scripts/docs-fixtures";

const doc = readFileSync("docs/mdlint-autofix-fixture-index.md", "utf8");
const source = `
describe("rule:invalid-link-target", () => {
  it("plain [link](#example)", () => {});
  it.each([[1]])("table %s", () => {});
});
describe("rule:missing-alt-text", () => { it("image", () => {}); });
describe("chained violations and multi-line fixes", () => { it("mixed", () => {}); });
`;

describe("mdlint autofix fixture index", () => {
  it("generates names and declaration counts without treating Markdown as links", () => {
    const result = fixtureIndex(source);
    expect(result).toContain("## Link fixtures (2)");
    expect(result).toContain('- "plain [link](#example)"');
    expect(result).toContain('- [table] "table %s"');
    expect(result).toContain("## Image fixtures (1)");
    expect(result).toContain("## Mixed-rule fixtures (1)");
    expect(result).toContain("```text\n");
  });

  it("accepts another table row without requiring a doc update", () => {
    const changed = source.replace("[[1]]", "[[1], [2]]");
    expect(fixtureIndex(changed)).toBe(fixtureIndex(source));
    expect(doc).toContain(formatMarker);
  });

  it("indexes new declarations without requiring a doc update", () => {
    const changed = source.replace(
      '  it("plain',
      '  it("new fixture", () => {});\n  it("plain',
    );
    expect(fixtureIndex(changed)).toContain("## Link fixtures (3)");
    expect(fixtureIndex(changed)).toContain('- "new fixture"');
    expect(doc).toContain(formatMarker);
  });

  it("rejects missing fixture blocks", () => {
    expect(() => fixtureIndex("")).toThrow("Missing describe block");
  });
});
