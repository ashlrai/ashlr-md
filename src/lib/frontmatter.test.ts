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

  it("splits front matter by the rule stripFrontmatter reads", () => {
    // A closer with text after it does not close the block.
    expect(splitFrontmatter("---\na: 1\n---abc\nbody")).toEqual({
      frontmatter: "",
      body: "---\na: 1\n---abc\nbody",
    });
    // Spaces and tabs after a delimiter are allowed, as remark-frontmatter reads it.
    expect(splitFrontmatter("--- \na: 1\n---\t\nbody")).toEqual({
      frontmatter: "--- \na: 1\n---\t\n",
      body: "body",
    });
    // The `...` closer and an empty block, as stripFrontmatter reads them.
    expect(splitFrontmatter("---\na: 1\n...\nbody").body).toBe("body");
    expect(splitFrontmatter("---\n---\nbody")).toEqual({
      frontmatter: "---\n---\n",
      body: "body",
    });
    expect(splitFrontmatter("---\r\na: 1\r\n---\r\nbody").body).toBe("body");
    expect(splitFrontmatter("---\na: 1\n---")).toEqual({
      frontmatter: "---\na: 1\n---",
      body: "",
    });
    // Indented or unclosed: no front matter.
    expect(splitFrontmatter(" ---\na\n---\nb").frontmatter).toBe("");
    expect(splitFrontmatter("---\na: 1\n").frontmatter).toBe("");
  });

  it("splits exactly the lines stripFrontmatter strips, and joins back losslessly", () => {
    const docs = [
      "---\na: 1\n---\nbody\n",
      "---\na\n---x\n---\nb",
      "---  \n\n...  \n# h",
      "--- x\na\n---\nb",
      "---\n---",
      "---\na\n--- \r\n\r\nb\r\n",
      "# no front matter\n---\n",
      "",
    ];
    for (const raw of docs) {
      const { frontmatter, body } = splitFrontmatter(raw);
      const { lines, offset } = stripFrontmatter(raw);
      expect(body, JSON.stringify(raw)).toBe(lines.join("\n"));
      expect(frontmatter === "", JSON.stringify(raw)).toBe(offset === 0);
      expect(joinFrontmatter(frontmatter, body)).toBe(raw);
    }
  });
});
