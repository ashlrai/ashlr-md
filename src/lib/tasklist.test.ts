import { describe, expect, it } from "vitest";
import { isTaskLine, taskMarks, toggleTaskAtLine } from "./tasklist";

const DOC = [
  "# Plan", // line 1
  "", // line 2
  "- [ ] first", // line 3
  "- [x] second", // line 4
  "  * [ ] nested", // line 5
  "1. [X] ordered", // line 6
  "plain text", // line 7
].join("\n");

describe("toggleTaskAtLine", () => {
  it("checks an unchecked item", () => {
    const out = toggleTaskAtLine(DOC, 3).split("\n");
    expect(out[2]).toBe("- [x] first");
  });

  it("unchecks a checked item", () => {
    const out = toggleTaskAtLine(DOC, 4).split("\n");
    expect(out[3]).toBe("- [ ] second");
  });

  it("handles nested and ordered list markers", () => {
    expect(toggleTaskAtLine(DOC, 5).split("\n")[4]).toBe("  * [x] nested");
    expect(toggleTaskAtLine(DOC, 6).split("\n")[5]).toBe("1. [ ] ordered");
  });

  it("only changes the targeted line", () => {
    const out = toggleTaskAtLine(DOC, 3).split("\n");
    expect(out[0]).toBe("# Plan");
    expect(out[3]).toBe("- [x] second");
    expect(out[6]).toBe("plain text");
  });

  it("is a safe no-op on non-task lines and out-of-range", () => {
    expect(toggleTaskAtLine(DOC, 7)).toBe(DOC);
    expect(toggleTaskAtLine(DOC, 1)).toBe(DOC);
    expect(toggleTaskAtLine(DOC, 999)).toBe(DOC);
    expect(toggleTaskAtLine(DOC, 0)).toBe(DOC);
  });

  it("preserves trailing text after the checkbox", () => {
    const out = toggleTaskAtLine("- [ ] do the thing", 1);
    expect(out).toBe("- [x] do the thing");
  });
});

describe("isTaskLine", () => {
  it("identifies task lines and rejects others", () => {
    expect(isTaskLine(DOC, 3)).toBe(true);
    expect(isTaskLine(DOC, 4)).toBe(true);
    expect(isTaskLine(DOC, 1)).toBe(false);
    expect(isTaskLine(DOC, 7)).toBe(false);
  });
});

describe("toggleTaskAtLine follows the renderer's task rule", () => {
  /** Line `line` (1-based) of `doc` after toggleTaskAtLine. */
  const toggled = (doc: string, line: number) =>
    toggleTaskAtLine(doc, line).split("\n")[line - 1];

  it("toggles a task in a blockquote and after an ordered `1)` marker", () => {
    expect(toggled("> - [ ] quoted", 1)).toBe("> - [x] quoted");
    expect(toggled(">- [x] tight", 1)).toBe(">- [ ] tight");
    expect(toggled("1) [ ] paren", 1)).toBe("1) [x] paren");
    expect(toggled("1. a\n2) [X] b", 2)).toBe("2) [ ] b");
    expect(toggled("> 1. - [ ] deep", 1)).toBe("> 1. - [x] deep");
  });

  it("toggles a checkbox on a bare item's next line", () => {
    expect(toggled("-\n  [ ] next", 2)).toBe("  [x] next");
    expect(toggled("> 1.\n>    [x] quoted", 2)).toBe(">    [ ] quoted");
    // A space after the marker, or more indentation, leaves no first content.
    expect(toggleTaskAtLine("- \n  [ ] t", 2)).toBe("- \n  [ ] t");
    expect(toggleTaskAtLine("-\n    [ ] t", 2)).toBe("-\n    [ ] t");
  });

  it("toggles the checkbox after a nested bare item in its parent item", () => {
    // remark-gfm reads the line after a nested bare item that leaves it for
    // an item it is in as that item's first content.
    expect(toggled("10. 1.\t-\n\t \t[x] t", 2)).toBe("\t \t[ ] t");
    expect(toggled("- -\n  [ ] t", 2)).toBe("  [x] t");
    expect(toggled("> * -\n>   [ ] t", 2)).toBe(">   [x] t");
    // Not when it leaves the item for a blockquote, or is indented past it.
    expect(toggleTaskAtLine("> -\n> [ ] t", 2)).toBe("> -\n> [ ] t");
    expect(toggleTaskAtLine("- > -\n  > [ ] t", 2)).toBe("- > -\n  > [ ] t");
    expect(toggleTaskAtLine("- -\n   [ ] t", 2)).toBe("- -\n   [ ] t");
  });

  it("keeps tabs and changes only the character inside the brackets", () => {
    expect(toggled("-\t[ ] tabbed", 1)).toBe("-\t[x] tabbed");
    expect(toggled("- [ ]\ttab after", 1)).toBe("- [x]\ttab after");
    // A tab one column wide inside the brackets is a checkbox, as in micromark.
    expect(toggled("- [\t] tab inside", 1)).toBe("- [x] tab inside");
    expect(toggleTaskAtLine("-  [\t] wide tab", 1)).toBe("-  [\t] wide tab");
    expect(toggleTaskAtLine("- [ ] a\r\n- [x] b\r\n", 2)).toBe(
      "- [ ] a\r\n- [ ] b\r\n",
    );
  });

  it("does not toggle a checkbox the page shows as text or code", () => {
    const untouched = [
      "    - [ ] indented code",
      "```\n- [ ] fenced\n```",
      "---\n- [ ] front matter\n---\nbody",
      "- [ ]",
      "- [x]   ",
      "- [ ]x",
      "para\n2) [ ] t",
      "- [ ] a\n  ===",
      "- > [ ] quote in item",
      "[ ] not in a list",
    ];
    for (const doc of untouched) {
      for (let line = 1; line <= doc.split("\n").length; line++) {
        expect(toggleTaskAtLine(doc, line), `${JSON.stringify(doc)} line ${line}`).toBe(
          doc,
        );
      }
    }
  });

  it("toggles a checkbox that ends a line the paragraph goes on after", () => {
    expect(toggled("- [ ]\n  more", 1)).toBe("- [x]");
    expect(toggled("- [x]\nlazy", 1)).toBe("- [ ]");
    expect(toggleTaskAtLine("- [ ]\n  - b", 1)).toBe("- [ ]\n  - b");
  });

  it("toggles a task after front matter by its line in the document", () => {
    const doc = "---\ntitle: x\n---\n- [ ] one\n- [x] two\n";
    expect(toggled(doc, 4)).toBe("- [x] one");
    expect(toggled(doc, 5)).toBe("- [ ] two");
  });

  it("reads each task's state, text and checkbox offset", () => {
    const doc = "# T\n> - [ ] a\n-\n  [X]  b  \n";
    const marks = taskMarks(doc);
    expect(marks[1]).toEqual({ checked: false, text: "a", offset: doc.indexOf("[ ]") });
    expect(marks[3]).toEqual({ checked: true, text: "b", offset: doc.indexOf("[X]") });
    expect(marks.filter(Boolean)).toHaveLength(2);
  });
});

describe("taskMarks reads footnotes and HTML blocks as the renderer does", () => {
  it("reads a task in a footnote definition", () => {
    // remark-gfm reads `[^n]: - [ ] t` as a footnote holding a task, and
    // the lines indented four columns after it as its content.
    expect(taskMarks("[^n]: - [ ] t").map((m) => m?.text ?? null)).toEqual(["t"]);
    expect(taskMarks("[^n]: x\n\n    - [x] u").map((m) => m?.checked ?? null)).toEqual([
      null,
      null,
      true,
    ]);
  });

  it("does not read a task in an HTML block", () => {
    // The page shows an HTML block's lines as raw HTML, not as a list.
    expect(taskMarks("<div>\n- [ ] t\n</div>").every((m) => m === null)).toBe(true);
    expect(taskMarks("<u>\n- [ ] t").every((m) => m === null)).toBe(true);
  });

  it("reads no task in a $$ math block", () => {
    // remark-math reads it as fenced code is read; its `- [ ]` lines used to
    // be tasks.
    expect(
      taskMarks("$$\n- [ ] x\n$$\n- [ ] real").map((m) => m?.text ?? null),
    ).toEqual([null, null, null, "real"]);
  });
});
