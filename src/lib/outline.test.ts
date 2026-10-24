import { describe, expect, it } from "vitest";
import { atxHeading, atxHeadings, markdownLines, parseHeadings } from "./outline";

describe("parseHeadings", () => {
  it("skips a leading YAML frontmatter block", () => {
    const doc = ["---", "title: Hello", "tags: [a, b]", "---", "# Real Heading"].join(
      "\n",
    );
    const out = parseHeadings(doc);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ depth: 1, text: "Real Heading", line: 5 });
    // No phantom heading from a `#` inside the frontmatter.
  });

  it("does not treat frontmatter values as headings", () => {
    const doc = ["---", "# not a heading", "---", "## Body"].join("\n");
    const out = parseHeadings(doc);
    expect(out.map((h) => h.text)).toEqual(["Body"]);
  });

  it("ignores `#` lines inside fenced code blocks", () => {
    const doc = [
      "# Title",
      "",
      "```bash",
      "# this is a shell comment, not a heading",
      "## also not a heading",
      "```",
      "",
      "## Real Section",
    ].join("\n");
    const out = parseHeadings(doc);
    expect(out.map((h) => h.text)).toEqual(["Title", "Real Section"]);
  });

  it("handles tilde fences and nested backtick fences", () => {
    const doc = [
      "# A",
      "~~~",
      "# inside tilde fence",
      "```",
      "# still inside (nested ``` does not close ~~~)",
      "~~~",
      "# B",
    ].join("\n");
    const out = parseHeadings(doc);
    expect(out.map((h) => h.text)).toEqual(["A", "B"]);
  });

  it("captures depth + nesting for ATX levels", () => {
    const doc = ["# One", "## Two", "### Three", "###### Six"].join("\n");
    const out = parseHeadings(doc);
    expect(out.map((h) => h.depth)).toEqual([1, 2, 3, 6]);
    // 7 hashes is not a heading.
    expect(parseHeadings("####### Seven")).toHaveLength(0);
  });

  it("dedupes duplicate slugs with -1/-2 suffixes (matches github-slugger)", () => {
    const doc = ["# Setup", "## Setup", "### Setup"].join("\n");
    const out = parseHeadings(doc);
    expect(out.map((h) => h.slug)).toEqual(["setup", "setup-1", "setup-2"]);
  });

  it("strips inline markdown before slugging so anchors match the DOM", () => {
    const doc = "## The **bold** `code` and [a link](https://x.com)";
    const out = parseHeadings(doc);
    expect(out[0].text).toBe("The bold code and a link");
    expect(out[0].slug).toBe("the-bold-code-and-a-link");
  });

  it("returns an empty array for a doc with no headings", () => {
    expect(parseHeadings("just some prose\n\nand more")).toEqual([]);
  });

  it("reads a heading by the ATX rule mdopener-mcp uses", () => {
    const doc = [
      "\t# tab-indented code",
      "    # four spaces is code",
      "  # Two spaces",
      "#\tTabbed",
      "## Closed ##",
      "## ##",
      "### Learn C#",
      "#tag",
    ].join("\n");
    expect(parseHeadings(doc).map((h) => [h.depth, h.text])).toEqual([
      [1, "Two spaces"],
      [1, "Tabbed"],
      [2, "Closed"],
      [3, "Learn C#"],
    ]);
  });

  it("uses the fence rule of mdopener-mcp", () => {
    // A tab-indented ``` is indented code, and a backtick info string with
    // a backtick is not a fence, so the `#` lines after them are headings.
    const doc = ["\t```", "# One", "``` a`b", "# Two"].join("\n");
    expect(parseHeadings(doc).map((h) => h.text)).toEqual(["One", "Two"]);
  });

  it("gives each heading's source text and line from atxHeadings", () => {
    const doc = [
      "---",
      "# yaml",
      "---",
      "## **Bold** ##",
      "```",
      "# no",
      "```",
      "#",
    ].join("\n");
    expect(atxHeadings(doc)).toEqual([
      { depth: 2, text: "**Bold**", line: 4 },
      { depth: 1, text: "", line: 8 },
    ]);
    expect(atxHeading("   # Three")).toEqual({ depth: 1, text: "Three" });
    expect(atxHeading("    # Four")).toBeNull();
  });

  it("marks each line front matter, fence, code or text in markdownLines", () => {
    const doc = ["---", "a: |", "  ```", "---", "x", "````", "```", "````", "y"].join(
      "\n",
    );
    const lines = markdownLines(doc);
    expect(lines.map((l) => l.kind)).toEqual([
      "frontmatter",
      "frontmatter",
      "frontmatter",
      "frontmatter",
      "text",
      "fence",
      "code",
      "fence",
      "text",
    ]);
    for (const l of lines) {
      expect(doc.slice(l.start, l.start + l.text.length)).toBe(l.text);
    }
    expect(lines[8]).toMatchObject({ text: "y", line: 9 });
  });

  it("leaves a quoted heading out but counts its slug as the renderer does", () => {
    // Obsidian's outline lists no heading inside a blockquote, and neither
    // does mdopener-mcp. rehype-slug still gives `> # Plan` the id `plan`,
    // so the real `# Plan` below it is `plan-1`.
    const doc = [
      "> # Plan",
      ">> ## Deep ##",
      "",
      "> ```",
      "> # not a heading",
      "> ```",
      "",
      "# Plan",
      "## Deep",
      "# not a heading",
    ].join("\n");
    expect(parseHeadings(doc).map((h) => [h.text, h.slug, h.line])).toEqual([
      ["Plan", "plan-1", 8],
      ["Deep", "deep-1", 9],
      ["not a heading", "not-a-heading", 10],
    ]);
    expect(atxHeadings(doc).map((h) => h.line)).toEqual([8, 9, 10]);
  });
  it("reads a fence inside a blockquote as a fence", () => {
    // A quoted fence used to be text, so its `[[link]]`s were linted and
    // its lines read as Markdown. A line with fewer `>` markers ends it.
    const doc = [
      "> ```sh",
      "> # comment",
      ">> - [ ] not a task",
      "> ```",
      "> text",
      "> > ~~~",
      "> > code",
      "> after",
      "> ```",
      "",
      "- [ ] task",
    ].join("\n");
    expect(markdownLines(doc).map((l) => l.kind)).toEqual([
      "fence",
      "code",
      "code",
      "fence",
      "text",
      "fence",
      "code",
      "text",
      "fence",
      "text",
      "text",
    ]);
  });
});
