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

  it.each([
    ["two blank lines between paragraphs", "one two\n\n\nthree four five"],
    ["many blank lines between paragraphs", "one two\n\n\n\n\n\nthree four five"],
    ["blank lines holding spaces and tabs", "one two\n  \n\t\n \t \nthree four five"],
    ["CRLF blank lines", "one two\r\n\r\n\r\nthree four five"],
    [
      "blank lines around the whole document",
      "\n\n\none two three\n\n\nfour five\n\n\n",
    ],
  ])("does not change the word count with %s", (_description, content) => {
    expect(computeDocStats(content).words).toBe(5);
  });

  it("returns the same stats however many blank lines separate prose", () => {
    const stats = computeDocStats("one two\n\n\n\nthree four five");
    expect(stats).toEqual(computeDocStats("one two\nthree four five"));
    expect(stats).toEqual(computeDocStats("one two three four five"));
  });

  it("does not change the reading time with consecutive blank lines", () => {
    const words = Array.from({ length: 440 }, () => "word").join(" ");
    const first = Array.from({ length: 220 }, () => "word").join(" ");
    const split = `${first}\n\n\n\n\n${first}`;
    expect(computeDocStats(split)).toEqual({ words: 440, minutes: 2 });
    expect(computeDocStats(split)).toEqual(computeDocStats(words));
  });

  it("counts no words for blank lines inside indented code", () => {
    // CommonMark reads blank lines between indented lines as part of the
    // code block, not as gaps ending it; they add no words either way.
    expect(computeDocStats("para\n\n    code one\n\n\n    code two\n\nend").words).toBe(
      2,
    );
  });

  it("counts a blockquote's prose once across its blank lines", () => {
    expect(computeDocStats("> quoted one\n>\n>\n> quoted two").words).toBe(4);
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

  it("counts only prose after frontmatter and a fenced code block", () => {
    const md =
      "---\ntitle: Hidden words\n---\n\n```js\nconst hidden = 'code words';\n```\n\nvisible prose here";
    expect(computeDocStats(md)).toEqual({ words: 3, minutes: 1 });
  });

  it.each([
    "---",
    "...",
  ])("excludes CRLF frontmatter closed by %s from the count", (closer) => {
    const md = `---\r\ntitle: My Post\r\nauthor: Jane Doe\r\n${closer}\r\n\r\nHello world here\r\n`;
    expect(computeDocStats(md)).toEqual({ words: 3, minutes: 1 });
  });

  it("excludes fenced code blocks", () => {
    const md = "intro words here\n\n```js\nconst a = 1 + 2 + 3 + 4;\n```\n\noutro";
    expect(computeDocStats(md).words).toBe(4); // "intro words here" + "outro"
  });

  it("counts surrounding prose but excludes every line of a multiline fence", () => {
    const fence =
      "```js\nconst message = 'hello world';\nconsole.log(message);\nreturn message;\n```";
    expect(computeDocStats(`words before\n\n${fence}\n\nwords after here`).words).toBe(
      5,
    );
    expect(computeDocStats(fence).words).toBe(0);
  });

  it.each([
    ["backtick fences", "```js\nhidden code words\n```", "```\nmore hidden words\n```"],
    ["mixed fences", "~~~py\nhidden code words\n~~~", "```sh\nmore hidden words\n```"],
  ])("counts prose before, between and after multiple %s", (_label, first, second) => {
    const md = `before words\n\n${first}\n\nbetween three words\n\n${second}\n\nafter words`;
    expect(computeDocStats(md)).toEqual({ words: 7, minutes: 1 });
  });

  it("does not let multiple fenced blocks increase reading time", () => {
    const prose = Array.from({ length: 220 }, () => "word").join(" ");
    const code = Array.from({ length: 220 }, () => "hidden").join(" ");
    const md = `${prose}\n\n\`\`\`\n${code}\n\`\`\`\n\n~~~\n${code}\n~~~`;
    expect(computeDocStats(md)).toEqual({ words: 220, minutes: 1 });
  });

  it("excludes tilde-fenced code blocks and counts surrounding prose", () => {
    const fence = "~~~js\nconst message = 'hello world';\nconsole.log(message);\n~~~";
    expect(computeDocStats(`words before\n\n${fence}\n\nwords after here`).words).toBe(
      5,
    );
    expect(computeDocStats(fence).words).toBe(0);
    // A backtick fence inside a tilde fence is code; only a tilde fence closes it.
    expect(computeDocStats("~~~\n```\nx y\n```\n~~~\nz").words).toBe(1);
  });

  it("excludes inline code", () => {
    // "run" + "now"; the inline-code span is removed entirely.
    expect(computeDocStats("run `npm install foo bar` now").words).toBe(2);
  });

  it("reports zero words and minutes for inline code only", () => {
    expect(computeDocStats("`npm install foo bar`")).toEqual({ words: 0, minutes: 0 });
  });

  it.each([
    ["backtick fence", "```js\nconst a = 1 + 2 + 3;\nconsole.log(a);\n```"],
    ["tilde fence", "~~~py\nprint('hello world')\n~~~"],
    ["unclosed fence", "```\nsome code words here\nmore code"],
    ["fence with trailing newline", "```sh\nnpm install foo bar\n```\n"],
  ])("reports zero words and zero minutes for a code-only document (%s)", (_d, md) => {
    expect(computeDocStats(md)).toEqual({ words: 0, minutes: 0 });
  });

  it("returns zero words and zero minutes for empty content", () => {
    expect(computeDocStats("")).toEqual({ words: 0, minutes: 0 });
    expect(computeDocStats("   \n\n")).toEqual({ words: 0, minutes: 0 });
  });

  it.each([
    ["spaces", "   "],
    ["tabs", "\t\t"],
    ["newlines", "\n\n"],
    ["mixed whitespace", " \t\n\r\n\t "],
    ["Unicode whitespace", "\u00a0\u2003"],
  ])("returns zero words and minutes for %s only", (_label, content) => {
    expect(computeDocStats(content)).toEqual({ words: 0, minutes: 0 });
  });

  it("rounds reading time up to at least one minute for short docs", () => {
    expect(computeDocStats("a few words").minutes).toBe(1);
  });

  it("estimates reading time at ~220 wpm", () => {
    const words = Array.from({ length: 660 }, () => "word").join(" ");
    expect(computeDocStats(words).minutes).toBe(3);
  });

  it.each([
    // Below and at a whole minute round to one; one word past it rounds to two.
    [219, 1],
    [220, 1],
    [221, 2],
  ])("reports %i plain words as a %i-minute read", (count, minutes) => {
    const doc = Array.from({ length: count }, () => "word").join(" ");
    expect(computeDocStats(doc)).toEqual({ words: count, minutes });
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
