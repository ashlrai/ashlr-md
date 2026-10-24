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
  it("counts the slug of a heading indented in a list item as the renderer does", () => {
    // `    # Sub` after `1. x` is a heading in the item (at most three
    // columns past its text), which rehype-slug gives the id `sub`, so the
    // real `# Sub` is `sub-1`. Four columns past the text is code.
    const doc = [
      "1. x",
      "",
      "    # Sub",
      "",
      "- y",
      "",
      "      # Code",
      "",
      "# Sub",
      "# Code",
    ].join("\n");
    expect(parseHeadings(doc).map((h) => [h.text, h.slug, h.line])).toEqual([
      ["Sub", "sub-1", 9],
      ["Code", "code", 10],
    ]);
  });
  it("leaves out a heading on a list item's continuation line", () => {
    // `  # Sub` after `- x` and a blank line, or after a bare `-`, is in
    // the item, so it is counted for slugs but not listed. It used to be
    // listed. One less indented than the item's text ends the list.
    const doc = [
      "- x",
      "",
      "  # Sub",
      "-",
      "  ## Bare",
      "",
      " # Out",
      "# Sub",
      "## Bare",
    ].join("\n");
    expect(parseHeadings(doc).map((h) => [h.text, h.slug, h.line])).toEqual([
      ["Out", "out", 7],
      ["Sub", "sub-1", 8],
      ["Bare", "bare-1", 9],
    ]);
  });
  it("reads a fence in a list item as a fence", () => {
    // A list-item fence used to be text, so `  # comment` in the item's
    // code was listed in the Outline. A less indented line ends it.
    const doc = [
      "- ```sh",
      "  # comment",
      "",
      "  - [ ] not a task",
      "  ```",
      "  # after",
      "1. - ~~~",
      "     code",
      "  # out",
      "-     ```",
      "# Real",
    ].join("\n");
    expect(markdownLines(doc).map((l) => l.kind)).toEqual([
      "fence",
      "code",
      "code",
      "code",
      "fence",
      "text",
      "fence",
      "code",
      "text",
      "text",
      "text",
    ]);
    expect(parseHeadings(doc).map((h) => h.text)).not.toContain("comment");
  });
  it("reads fences in item continuations, nested items, tabs and quotes in items", () => {
    // These were text, so their `# comment`s were listed in the Outline.
    // Each matches what the renderer (micromark) reads as fenced code.
    const kinds = (lines: string[]) =>
      markdownLines(lines.join("\n")).map((l) => l.kind[0]);
    // A fence on an item's continuation line, after a blank line or not.
    expect(kinds(["- a", "", "  ```", "  # c", "  ```", "# real"])).toEqual([
      "t",
      "t",
      "f",
      "c",
      "f",
      "t",
    ]);
    expect(kinds(["- a", "  ~~~", "  # c", "x"])).toEqual(["t", "f", "c", "t"]);
    // An item indented four spaces or more under its parent.
    expect(kinds(["- a", "    - ```", "      # c", "      ```"])).toEqual([
      "t",
      "f",
      "c",
      "f",
    ]);
    expect(kinds(["1. a", "   - b", "     - ```", "       # c", "     # out"])).toEqual(
      ["t", "t", "f", "c", "t"],
    );
    // A tab after the marker: the item's text starts at column four.
    expect(kinds(["-\t```", "    # c", "  # out"])).toEqual(["f", "c", "t"]);
    // A fence in a quote in an item, which a line without `>` ends.
    expect(kinds(["- > ```", "  > # c", "  > ```", "# r"])).toEqual([
      "f",
      "c",
      "f",
      "t",
    ]);
    expect(kinds(["- > ```", "  # out"])).toEqual(["f", "t"]);
    // Four spaces past the item's text is indented code, not a fence.
    expect(kinds(["- a", "", "      ```", "  # h"])).toEqual(["t", "t", "t", "t"]);
    // A line less indented than the item's text after a blank line ends it.
    expect(kinds(["- a", "", "b", "", "  ```", "x"])).toEqual([
      "t",
      "t",
      "t",
      "t",
      "f",
      "c",
    ]);
    const doc = ["- a", "", "  ```sh", "  # comment", "  ```", "", "# Real"].join("\n");
    expect(parseHeadings(doc).map((h) => h.text)).toEqual(["Real"]);
  });
  it("leaves a list-item heading out but counts its slug as the renderer does", () => {
    // rehype-slug gives `- # Step` (a heading in a list item) the id `step`,
    // so the real `# Step` below it is `step-1` in the page.
    const doc = [
      "- # Step",
      "1. ## Two",
      "> - ### Quoted item",
      "-     # indented code",
      "- #tag",
      "",
      "# Step",
      "## Two",
      "### Quoted item",
      "# indented code",
    ].join("\n");
    expect(parseHeadings(doc).map((h) => [h.text, h.slug, h.line])).toEqual([
      ["Step", "step-1", 7],
      ["Two", "two-1", 8],
      ["Quoted item", "quoted-item-1", 9],
      ["indented code", "indented-code", 10],
    ]);
    expect(atxHeadings(doc).map((h) => h.line)).toEqual([7, 8, 9, 10]);
  });
});
