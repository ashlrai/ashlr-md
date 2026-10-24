import { describe, expect, it } from "vitest";
import {
  inLineBreaks,
  joinFrontmatter,
  splitFrontmatter,
  stripFrontmatter,
  usesCrlf,
} from "./frontmatter";
import { listItem, markdownLines, parseHeadings } from "./outline";

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

describe("the visual editor's line breaks", () => {
  it("writes the body of a CRLF file in CRLF", () => {
    // Crepe writes LF, so an edited CRLF file was saved with CRLF front
    // matter and an LF body.
    const raw = "---\r\na: 1\r\n---\r\n# T\r\n\r\nx\r\n";
    const { frontmatter } = splitFrontmatter(raw);
    const crlf = usesCrlf(raw);
    expect(crlf).toBe(true);
    expect(joinFrontmatter(frontmatter, inLineBreaks("# T\n\ny\n", crlf))).toBe(
      "---\r\na: 1\r\n---\r\n# T\r\n\r\ny\r\n",
    );
    expect(usesCrlf("a\nb")).toBe(false);
    expect(usesCrlf("a\r\nb\nc")).toBe(false);
    expect(inLineBreaks("a\nb", false)).toBe("a\nb");
  });
});

describe("a byte order mark", () => {
  it("keeps the front matter behind it and stays out of the editor's body", () => {
    // Notepad saves a BOM; micromark drops it, so the page reads the block
    // as front matter. It used to hide the block from the split.
    const doc = "\uFEFF---\ntitle: x\n---\n# A\n";
    expect(splitFrontmatter(doc)).toEqual({
      frontmatter: "\uFEFF---\ntitle: x\n---\n",
      body: "# A\n",
    });
    expect(splitFrontmatter("\uFEFF# A\n")).toEqual({
      frontmatter: "\uFEFF",
      body: "# A\n",
    });
    for (const d of [doc, "\uFEFF# A\n", "# A\n"]) {
      const { frontmatter, body } = splitFrontmatter(d);
      expect(joinFrontmatter(frontmatter, body)).toBe(d);
    }
  });

  it("is no text of the first line for the Outline", () => {
    expect(parseHeadings("\uFEFF# Top\n").map((h) => h.slug)).toEqual(["top"]);
    expect(parseHeadings("\uFEFF---\ntitle: x\n---\n# A\n").map((h) => h.line)).toEqual(
      [4],
    );
    expect(markdownLines("\uFEFF---\nt: 1\n---\n").map((l) => l.kind)).toEqual([
      "frontmatter",
      "frontmatter",
      "frontmatter",
      "text",
    ]);
    const item = markdownLines("\uFEFF- [ ] task\n")[0];
    expect(listItem(item)).toEqual({ ordered: false, text: "[ ] task" });
  });
});
