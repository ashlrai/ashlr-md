import { describe, expect, it } from "vitest";
import { computeDocStats } from "./wordcount";

describe("computeDocStats", () => {
  it("counts plain prose words", () => {
    expect(computeDocStats("one two three four five").words).toBe(5);
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
});
