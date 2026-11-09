import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { markdownLines } from "./outline";
import { isInsideFencedCode, markdownSnippetSource } from "./snippets";

describe("fenced snippets", () => {
  it("keeps a shorter run of backticks inside the enclosing fence", () => {
    const doc = "````markdown\nbefore\n```\nafter inner fence\n````\noutside\n";
    const lines = markdownLines(doc);
    expect(lines.map(({ kind, text }) => [kind, text])).toEqual([
      ["fence", "````markdown"],
      ["code", "before"],
      ["code", "```"],
      ["code", "after inner fence"],
      ["fence", "````"],
      ["text", "outside"],
      ["text", ""],
    ]);

    const source = markdownSnippetSource();
    const state = EditorState.create({ doc });
    for (const text of ["before", "```\nafter", "after inner fence"]) {
      const pos = doc.indexOf(text) + 1;
      expect(isInsideFencedCode(doc, pos)).toBe(true);
      expect(source(new CompletionContext(state, pos, true))).toBeNull();
    }
    const outside = doc.indexOf("outside") + 1;
    expect(isInsideFencedCode(doc, outside)).toBe(false);
    expect(source(new CompletionContext(state, outside, true))).not.toBeNull();
  });
});
