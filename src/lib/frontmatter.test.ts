import { describe, expect, it } from "vitest";
import { joinFrontmatter, splitFrontmatter, stripFrontmatter } from "./frontmatter";

describe("frontmatter", () => {
  it("splits a frontmatter block from the body", () => {
    const raw = "---\ntitle: X\nauthor: Y\n---\n# Body\n\ntext";
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toBe("---\ntitle: X\nauthor: Y\n---\n");
    expect(body).toBe("# Body\n\ntext");
  });

  it("returns empty frontmatter when there is none", () => {
    const { frontmatter, body } = splitFrontmatter("# Just a heading");
    expect(frontmatter).toBe("");
    expect(body).toBe("# Just a heading");
  });

  it("does not treat a mid-document --- as frontmatter", () => {
    const raw = "# Heading\n\n---\n\nmore";
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toBe("");
    expect(body).toBe(raw);
  });

  it("round-trips split then join losslessly", () => {
    const raw = "---\na: 1\n---\nhello world";
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(joinFrontmatter(frontmatter, body)).toBe(raw);
  });

  it("join with empty frontmatter returns the body unchanged", () => {
    expect(joinFrontmatter("", "x")).toBe("x");
  });

  it("strips front matter only from delimiters at column 0", () => {
    expect(stripFrontmatter("---\na: 1\n...\nbody").offset).toBe(3);
    expect(stripFrontmatter("---\t\r\na: 1\r\n--- \r\nbody")).toEqual({
      lines: ["body"],
      offset: 3,
    });
    expect(stripFrontmatter("  ---\na: 1\n---\nbody").offset).toBe(0);
    expect(stripFrontmatter("---\na: 1\n ---\nbody").offset).toBe(0);
    // Never closed: a thematic break, and nothing is removed.
    expect(stripFrontmatter("---\na: 1\n").offset).toBe(0);
  });
});
