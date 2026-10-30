import { describe, expect, it } from "vitest";
import { computeDocStats } from "./wordcount";

describe("computeDocStats", () => {
  it("counts plain prose words", () => {
    expect(computeDocStats("one two three four five").words).toBe(5);
  });

  it.each([
    ["leading spaces", "  ", ""],
    ["trailing spaces", "", "  "],
    ["leading and trailing blank lines", "\n\n", "\n\n"],
    ["mixed whitespace on both sides", "\n \n  ", " \t\r\n\n"],
    ["Unicode whitespace on both sides", "\u00a0", "\u2003"],
  ])("does not change the prose word count with %s", (_description, prefix, suffix) => {
    const prose = "one two three four five";
    expect(computeDocStats(prose).words).toBe(5);
    expect(computeDocStats(`${prefix}${prose}${suffix}`).words).toBe(5);
  });

  it("counts accented words separated by Unicode whitespace", () => {
    expect(
      computeDocStats("café\u00a0mañana\u2003naïve\nre\u0301sume\u0301").words,
    ).toBe(4);
  });

  it("counts punctuation-only prose as whitespace-separated words", () => {
    expect(computeDocStats("!!! ??? ;;;")).toEqual({ words: 3, minutes: 1 });
  });

  it("excludes YAML frontmatter from the count", () => {
    const md = "---\ntitle: My Post\nauthor: Jane Doe\n---\n\nHello world here";
    expect(computeDocStats(md).words).toBe(3);
  });

  it("excludes fenced code blocks", () => {
    const md = "intro words here\n\n```js\nconst a = 1 + 2 + 3 + 4;\n```\n\noutro";
    expect(computeDocStats(md).words).toBe(4); // "intro words here" + "outro"
  });

  it("excludes inline code", () => {
    // "run" + "now"; the inline-code span is removed entirely.
    expect(computeDocStats("run `npm install foo bar` now").words).toBe(2);
  });

  it("returns zero words and zero minutes for empty content", () => {
    expect(computeDocStats("")).toEqual({ words: 0, minutes: 0 });
    expect(computeDocStats("   \n\n")).toEqual({ words: 0, minutes: 0 });
  });

  it("rounds reading time up to at least one minute for short docs", () => {
    expect(computeDocStats("a few words").minutes).toBe(1);
  });

  it("estimates reading time at ~220 wpm", () => {
    const words = Array.from({ length: 660 }, () => "word").join(" ");
    expect(computeDocStats(words).minutes).toBe(3);
  });

  it("reads code blocks and containers by the page's line rule", () => {
    // A fence was any line starting with three backticks or tildes after any
    // indentation, closed by any later one of the same character, so a
    // longer fence holding a shorter one ended early, and a quoted fence was
    // text. List and blockquote markers counted as words.
    expect(computeDocStats("````\n```js\nx y\n```\n````\nz").words).toBe(1);
    expect(computeDocStats("> ```\n> code here\n> ```\nwords").words).toBe(1);
    expect(computeDocStats("- item one\n> quoted text\n# Title").words).toBe(5);
    expect(computeDocStats("  ---\nkept\n---\n").words).toBe(1);
  });

  it("counts no words in indented code", () => {
    // Indented code is code, as fenced code is; its words used to count.
    expect(computeDocStats("para\n\n    const x = 1;\n\nend").words).toBe(2);
    expect(computeDocStats("- a\n\n      code in item\n").words).toBe(1);
    // A line indented four spaces that goes on with a paragraph is text.
    expect(computeDocStats("para\n    more").words).toBe(2);
  });
});
