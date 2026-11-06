import { describe, expect, it } from "vitest";
import { computeDocStats } from "./wordcount";

describe("computeDocStats", () => {
  it.each([
    ["two spans on one line", "run `npm install` then `npm test` now", 3],
    ["a span at each end", "`setup step` only prose `cleanup step`", 2],
    ["back-to-back spans", "do `a b` `c d` it", 2],
    ["a span splitting a word", "one`x`two", 2],
    ["spans on separate lines", "start `a b`\nmiddle words here\n`c d` end", 5],
  ])("excludes multiple inline code spans: %s", (_label, md, words) => {
    expect(computeDocStats(md).words).toBe(words);
  });
});
