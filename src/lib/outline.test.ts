import { describe, expect, it } from "vitest";
import {
  atxHeading,
  atxHeadings,
  markdownLines,
  maskInlineCode,
  parseHeadings,
  proseText,
} from "./outline";

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

  it("reads front matter delimiters at column 0 only, as remark-frontmatter does", () => {
    // `  ---` is a thematic break on the page, so the heading after it is
    // listed; the first line used to be trimmed, which hid it.
    expect(parseHeadings("  ---\n# Shown\n---\n").map((h) => h.text)).toEqual([
      "Shown",
    ]);
    // An indented closer does not close the block either.
    expect(parseHeadings("---\n# A\n  ---\n# B\n").map((h) => h.text)).toEqual([
      "A",
      "B",
    ]);
    // Spaces and tabs may follow a delimiter.
    expect(parseHeadings("--- \n# fm\n---\t\n# Body\n").map((h) => h.text)).toEqual([
      "Body",
    ]);
    expect(markdownLines("  ---\na\n---\n").map((l) => l.kind)).toEqual([
      "text",
      "text",
      "text",
      "text",
    ]);
  });

  it("lets indented code that opens a blockquote hold the next line's markers", () => {
    // After a bare item's end, `>     code` opens a quote and is indented
    // code in it, so `> 2) ...` cannot interrupt it and is paragraph text,
    // as the renderer reads it: its ``` is no fence. It used to open an
    // item, and the item's fence made the lines after it code.
    const doc = "-\n\n>     code\n> 2) ```\n> x\n";
    expect(markdownLines(doc).map((l) => l.kind)).toEqual([
      "text",
      "text",
      "indented",
      "text",
      "text",
      "text",
    ]);
    const quoted = "> > - \n   \n   >       code\n   >   2) - - -\n===\n2) #\n";
    expect(markdownLines(quoted)[5]).toMatchObject({ contained: true, content: "#" });
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
    // atxHeadings (partial embeds, link previews) leaves them out too.
    expect(atxHeadings(doc).map((h) => h.line)).toEqual([7, 8, 9]);
  });
  it("reads a heading's containers by the rule of markdownLines", () => {
    // `2. z` cannot interrupt a paragraph and a bare `-` before an
    // unindented line ends at once, so the `   # Sub` after them is a
    // heading of the document, as the renderer reads it. Both used to be
    // read as list items holding it.
    const doc = ["text", "2. z", "   # Sub", "", "-", "text", "   # Bare"].join("\n");
    expect(parseHeadings(doc).map((h) => [h.text, h.line])).toEqual([
      ["Sub", 3],
      ["Bare", 7],
    ]);
    expect(atxHeadings(doc).map((h) => h.line)).toEqual([3, 7]);
    const lines = markdownLines("> - # Q\n- x\n\n  # Sub");
    expect(lines.map((l) => [l.contained, l.content])).toEqual([
      [true, "# Q"],
      [true, "x"],
      // A blank line stays in an open item, as a blank line indented to
      // its content column does.
      [true, ""],
      [true, "# Sub"],
    ]);
  });
  it("counts a setext heading's slug without listing it", () => {
    // The renderer gives a setext heading an id, so a later ATX heading
    // with the same text is `-1` there. The Outline used to give it none.
    expect(parseHeadings("Title\n=====\n\n# Title\n")).toEqual([
      { depth: 1, text: "Title", slug: "title-1", line: 4 },
    ]);
    // `---` after a paragraph is an underline, in a quote and an item too,
    // and a heading of several lines joins them (`Two`, `Lines` is
    // `twolines`, as rehype-slug reads it).
    const doc = [
      "Two",
      "Lines",
      "---",
      "",
      "> Quote",
      "> ===",
      "",
      "- Item",
      "  ---",
      "",
      "# Twolines",
      "# Quote",
      "# Item",
    ].join("\n");
    expect(parseHeadings(doc).map((h) => h.slug)).toEqual([
      "twolines-1",
      "quote-1",
      "item-1",
    ]);
    // A thematic break after a blank line, or front matter, is no heading.
    expect(parseHeadings("a\n\n---\n\n# A\n").map((h) => h.slug)).toEqual(["a"]);
    expect(parseHeadings("---\ntitle: A\n---\n# A\n").map((h) => h.slug)).toEqual([
      "a",
    ]);
  });
  it("tracks list items inside a blockquote", () => {
    // Only the items before the first blockquote used to be tracked, so a
    // quoted item's continuation was read by its indentation in the quote:
    // `>     # Sub` was indented code (no slug, so a later `# Sub` was
    // `sub` here and `sub-1` in the page), and a fence in the item was not
    // ended by a line that leaves it.
    const kinds = (doc: string) => markdownLines(doc).map((l) => [l.kind, l.content]);
    expect(kinds("> - a\n>\n>     - [ ] t\n>   b")).toEqual([
      ["text", "a"],
      ["text", ""],
      ["text", "[ ] t"],
      ["text", "b"],
    ]);
    expect(parseHeadings("> - a\n>\n>     # Sub\n\n# Sub")).toEqual([
      { depth: 1, text: "Sub", slug: "sub-1", line: 5 },
    ]);
    // `> ```` leaves the item, so it ends the item's fence and opens one
    // in the quote, as the renderer reads it.
    expect(kinds("> - a\n>\n>   ```\n>   # code\n> ```\n> # Quote")).toEqual([
      ["text", "a"],
      ["text", ""],
      ["fence", "```"],
      ["code", "# code"],
      ["fence", "```"],
      ["code", "# Quote"],
    ]);
    // An ordered item not at 1 does not interrupt a quoted paragraph.
    expect(kinds("> a\n> 2) b").map((k) => k[1])).toEqual(["a", "2) b"]);
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
      "indented",
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
    expect(kinds(["- a", "", "      ```", "  # h"])).toEqual(["t", "t", "i", "t"]);
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
  it("reads an HTML block as HTML, not Markdown, as the renderer does", () => {
    // The page shows the lines of an HTML block as raw HTML, so a `# x`
    // in one is no heading and takes no slug. They used to be read as
    // Markdown, so the Outline listed it.
    const doc = ["<div>", "# Inside", "</div>", "", "# After"].join("\n");
    expect(markdownLines(doc).map((l) => l.kind)).toEqual([
      "html",
      "html",
      "html",
      "text",
      "text",
    ]);
    expect(parseHeadings(doc).map((h) => [h.text, h.slug])).toEqual([
      ["After", "after"],
    ]);
    // A comment runs to its `-->`, a lone tag to a blank line.
    expect(parseHeadings("<!--\n# c\n-->\n# K").map((h) => h.text)).toEqual(["K"]);
    expect(parseHeadings("<u>\n# H\n\n# K").map((h) => h.text)).toEqual(["K"]);
    // A lone tag cannot interrupt a paragraph; a block tag can.
    expect(parseHeadings("a\n<u>\n# H").map((h) => h.text)).toEqual(["H"]);
    expect(parseHeadings("a\n<div>\n# H").map((h) => h.text)).toEqual([]);
    // In a blockquote, it ends with the quote.
    expect(parseHeadings("> <div>\n# H").map((h) => h.text)).toEqual(["H"]);
  });

  it("reads a footnote definition as a container", () => {
    // `[^n]: x` holds the lines indented four columns after it, as
    // remark-gfm reads it; they used to be read by their indentation in
    // the document.
    const lines = markdownLines("[^n]: x\n\n    # Note\n\n# Note");
    expect(lines.map((l) => [l.contained, l.content])).toEqual([
      [true, "x"],
      [true, ""],
      [true, "# Note"],
      [true, ""],
      [false, "# Note"],
    ]);
    // A footnote's heading is in the page's footnotes, after every other
    // heading, so it takes no slug before them.
    expect(parseHeadings("[^n]: # Note\n\n# Note").map((h) => h.slug)).toEqual([
      "note",
    ]);
  });

  it("reads no setext heading of link reference definitions", () => {
    // Definitions alone leave no paragraph to make a heading of, so an
    // underline after them starts one, which a lone tag cannot interrupt,
    // as remark-gfm reads it. It used to end the paragraph as a heading, so
    // the `</u>` after it opened an HTML block that hid the heading below.
    for (const doc of [
      "[a]: /u\n===\n</u>\n# Title",
      "[a]: /u\n--\n</u>\n# Title",
      "[a]: /u\n- \n</u>\n# Title",
      '[a]:\n/u\n"t"\n===\n</u>\n# Title',
    ]) {
      expect(
        parseHeadings(doc).map((h) => h.slug),
        doc,
      ).toEqual(["title"]);
      expect(
        markdownLines(doc).some((l) => l.setext || l.kind === "html"),
        doc,
      ).toBe(false);
    }
    // A heading after definitions has only the paragraph's own lines, so a
    // later `# Title` is `title-1` in the page, not `title`.
    expect(parseHeadings("[a]: /u\nTitle\n===\n\n# Title").map((h) => h.slug)).toEqual([
      "title-1",
    ]);
    // A `---` line there is a thematic break.
    expect(markdownLines("[a]: /u\n---").some((l) => l.setext)).toBe(false);
  });

  it("marks indented code as indented", () => {
    // The rule of mdopener-mcp's `with_indented_code`: four columns past
    // the line's containers, not going on with a paragraph. It used to be
    // `text`, so callers reading Markdown on text lines read it in code.
    const kinds = (doc: string) => markdownLines(doc).map((l) => l.kind);
    expect(kinds("    # code\n\n    more\nx")).toEqual([
      "indented",
      "text",
      "indented",
      "text",
    ]);
    expect(kinds("para\n    more")).toEqual(["text", "text"]);
    expect(kinds("- a\n\n      code\n  text")).toEqual([
      "text",
      "text",
      "indented",
      "text",
    ]);
    expect(kinds(">     [[x]]")).toEqual(["indented"]);
  });

  it("reads a $$ math block as fenced code", () => {
    // The page renders it with remark-math, which reads it as fenced code
    // is read; its `# x` lines used to be listed and take slugs.
    expect(parseHeadings("$$\n# not\n$$\n# Real").map((h) => h.text)).toEqual(["Real"]);
    expect(markdownLines("> $$ m\n> x\n> $$$\ny").map((l) => l.kind)).toEqual([
      "fence",
      "code",
      "fence",
      "text",
    ]);
    // `$$x$$` is inline math, and `$` alone is text.
    expect(markdownLines("$$x$$\n$\n# h").map((l) => l.kind)).toEqual([
      "text",
      "text",
      "text",
    ]);
  });
});

describe("parseHeadings reads inline math as the page renders it", () => {
  it("takes a math heading's slug from the KaTeX text, as rehype-slug does", () => {
    // Slugs from the read view (remark-math, rehype-katex, rehype-slug):
    // the formula's MathML, TeX source and HTML text. `$x*y*z$` used to
    // lose its `*`s and read `xyz` once.
    const h = parseHeadings("# Energy $E=mc^2$\n\n# a $x*y*z$ b\n\n# `$a$` code\n");
    expect(h.map((x) => x.slug)).toEqual([
      "energy-emc2emc2emc2",
      "a-xyzxyzxyz-b",
      "a-code",
    ]);
    // The Outline lists a formula by its source.
    expect(h.map((x) => x.text)).toEqual(["Energy E=mc^2", "a x*y*z b", "$a$ code"]);
  });

  it("reads `$` that opens no math as text", () => {
    // An escaped `$` and a run never closed are text.
    const h = parseHeadings("# Cost \\$5 and \\$10\n\n# One $ alone\n");
    expect(h.map((x) => x.slug)).toEqual(["cost-5-and-10", "one--alone"]);
  });
});

describe("parseHeadings reads inline text as mdast does (rehype-slug parity)", () => {
  // Each expected slug is the id the read view's pipeline gives the heading.
  const slugs = (md: string) => parseHeadings(md).map((h) => h.slug);

  it("keeps whitespace runs and tabs as the page's slug does", () => {
    expect(slugs("# a  b\n")).toEqual(["a--b"]);
    expect(slugs("# a\tb\n")).toEqual(["ab"]);
    // The label still reads with one space.
    expect(parseHeadings("# a  b\n")[0].text).toBe("a b");
  });

  it("decodes escapes and character references", () => {
    expect(slugs("# Fish &amp; Chips\n")).toEqual(["fish--chips"]);
    expect(slugs("# &#65;&#x42;C\n")).toEqual(["abc"]);
    expect(slugs("# Caf&eacute;\n")).toEqual(["café"]);
    expect(slugs("# \\*not em\\*\n")).toEqual(["not-em"]);
    expect(parseHeadings("# Fish &amp; Chips\n")[0].text).toBe("Fish & Chips");
  });

  it("drops raw HTML and keeps autolink text", () => {
    expect(slugs("# <b>Bold</b> <!-- c --> x\n")).toEqual(["bold--x"]);
    expect(slugs("# see <https://a.b/c>\n")).toEqual(["see-httpsabc"]);
    expect(parseHeadings("# <b>Bold</b> x\n")[0].text).toBe("Bold x");
  });

  it("reads emphasis by micromark's delimiter rules", () => {
    expect(slugs("# snake_case_name\n")).toEqual(["snake_case_name"]);
    expect(slugs("# a*b*c\n")).toEqual(["abc"]);
    expect(slugs("# *a **b** c*\n")).toEqual(["a-b-c"]);
    expect(slugs("# **a*\n")).toEqual(["a"]);
    expect(slugs("# _a_b\n")).toEqual(["_a_b"]);
    expect(slugs("# ~a~ ~~~b~~~\n")).toEqual(["a-b"]);
  });

  it("reads links and images, reference links by the document's definitions", () => {
    expect(slugs("# ![alt](x.png) b\n")).toEqual(["-b"]);
    expect(parseHeadings("# ![alt](x.png) b\n")[0].text).toBe("alt b");
    expect(slugs("# [a] [b]\n\n[A]: /u\n")).toEqual(["a-b"]);
    expect(slugs("# [x][a] [y][nope]\n\n[a]: /u\n")).toEqual(["x-ynope"]);
  });

  it("gives every heading a slug, an empty one too", () => {
    // rehype-slug gives `#` the id "" and the next empty heading "-1".
    expect(slugs("#\n# !!\n")).toEqual(["-1"]);
    expect(slugs("# <b></b>\n# ?\n")).toEqual(["-1"]);
  });

  it("applies the read view's Obsidian syntax to the text", () => {
    expect(slugs("# ==hi== %%note%% [[Target|alias]] ![[embed]]\n")).toEqual([
      "hi--alias-",
    ]);
  });
});

describe("maskInlineCode reads a GFM table cell by cell", () => {
  const masked = (md: string) =>
    maskInlineCode(markdownLines(md)).map((t) => t.replace(/\r/g, "#"));

  it("does not pair backticks across cells or rows", () => {
    // remark-gfm reads `a and b` as text in two cells, and the rows apart.
    expect(masked("| `a | b` |\n|---|---|\n| `c | d` |\n")).toEqual([
      "| `a | b` |",
      "|---|---|",
      "| `c | d` |",
      "",
    ]);
    expect(masked("a|b\n-|-\n`x|y\nz`|w\n")).toEqual([
      "a|b",
      "-|-",
      "`x|y",
      "z`|w",
      "",
    ]);
  });

  it("still masks a code span inside one cell, and an escaped pipe in it", () => {
    expect(masked("| `a` | `b \\| c` |\n|-|-|\n")).toEqual([
      "| ### | ######## |",
      "|-|-|",
      "",
    ]);
  });

  it("reads the paragraph before the table, and no table without a matching delimiter row", () => {
    // The line before the delimiter row is the header, out of the paragraph.
    expect(masked("`x\ny` b|c\n-|-\n")).toEqual(["`x", "y` b|c", "-|-", ""]);
    expect(masked("`x\ny`\nb|c\n-|-\n")).toEqual(["##", "##", "b|c", "-|-", ""]);
    // Two header cells, one delimiter cell: a paragraph, so the span pairs.
    expect(masked("`a|b\nc`|-\n:-\n")).toEqual(["####", "##|-", ":-", ""]);
    // A lazy line in a blockquote is no delimiter row.
    expect(masked("> `a | b\n`-|-\n")).toEqual(["> ######", "#-|-", ""]);
  });

  it("masks the lines indented four columns after a table whole: they are code", () => {
    // mdast: a table, then a code block holding `[[x]] `y``; then a paragraph.
    expect(masked("| a |\n| - |\n    [[x]] `y`\n\t| z |\n| d |\n")).toEqual([
      "| a |",
      "| - |",
      "#".repeat(13),
      "#".repeat(6),
      "| d |",
      "",
    ]);
    // In a blockquote, past its marker; three spaces is still a row.
    expect(masked("> | a |\n> | - |\n>     https://x\n")[2]).toBe("#".repeat(15));
    expect(masked("| a |\n| - |\n   | `c` |\n")[2]).toBe("   | ### |");
    // So the page's prose holds none of it (where lint reads links).
    expect(proseText("| a |\n| - |\n    [[x]]\n")).toBe(
      "| a |\n| - |\n\0\0\0\0\0\0\0\0\0\n",
    );
  });
});

describe("GFM literal autolinks hold no code span or math", () => {
  const masked = (md: string) =>
    maskInlineCode(markdownLines(md)).map((t) => t.replace(/\r/g, "#"));

  it("reads a backtick or a dollar in a URL as part of it, as remark-gfm does", () => {
    expect(masked("see https://x.org/`a [[L]] b`\n")[0]).toBe(
      "see https://x.org/`a [[L]] b`",
    );
    expect(masked("http://x.org/$a b$\n")[0]).toBe("http://x.org/$a b$");
    expect(masked("a www.x.org/`a b`\n")[0]).toBe("a www.x.org/`a b`");
    // After a blockquote marker, the line's inline text starts past it.
    expect(masked(">www.x.org/`a b`\n")[0]).toBe(">www.x.org/`a b`");
  });

  it("is no autolink after a letter or in an open link text", () => {
    expect(masked("xhttp://x.org/`a b`\n")[0]).toBe("xhttp://x.org/#####");
    expect(masked("[http://x.org/`a b`\n")[0]).toBe("[http://x.org/#####");
    // Trailing punctuation is not in the URL.
    expect(masked("www.x.org. `a`\n")[0]).toBe("www.x.org. ###");
  });

  it("keeps a URL's underscores out of emphasis in a heading's slug", () => {
    expect(parseHeadings("# see www.x.org/_a_\n")[0].slug).toBe("see-wwwxorg_a_");
  });
});
