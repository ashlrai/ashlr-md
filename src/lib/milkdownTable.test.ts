import { type Node, Schema } from "@milkdown/kit/prose/model";
import { describe, expect, it } from "vitest";
import { tableIndexAt, tableOffsetAt } from "./milkdownTable";
import { findTableRange } from "./tableEditor";

// The node names of Milkdown's GFM preset.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    blockquote: { group: "block", content: "block+" },
    table: { group: "block", content: "table_row+" },
    table_row: { content: "table_cell+" },
    table_cell: { content: "text*" },
    text: {},
  },
});
const { paragraph: p, blockquote, table, table_row: tr, table_cell: td } = schema.nodes;
const text = (t: string) => schema.text(t);
const grid = (rows: string[][]) =>
  table.create(
    null,
    rows.map((r) =>
      tr.create(
        null,
        r.map((c) => td.create(null, text(c))),
      ),
    ),
  );

const markdown = [
  "A paragraph long enough that the second table's ProseMirror positions fall in the first table of the Markdown.",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "Middle",
  "",
  "| c | d |",
  "| - | - |",
  "| 3 | 4 |",
  "",
].join("\n");

const doc = schema.node("doc", null, [
  p.create(null, text(markdown.split("\n")[0])),
  grid([
    ["a", "b"],
    ["1", "2"],
  ]),
  p.create(null, text("Middle")),
  grid([
    ["c", "d"],
    ["3", "4"],
  ]),
]);

/** The position of the first `needle` in `doc`'s text. */
function posOf(d: Node, needle: string): number {
  let found = -1;
  d.descendants((n, pos) => {
    if (found < 0 && n.isText && n.text?.includes(needle))
      found = pos + n.text.indexOf(needle);
  });
  return found;
}

describe("tableOffsetAt", () => {
  it("finds the cursor's table by its index, not by its ProseMirror position", () => {
    const pos = posOf(doc, "3");
    const second = markdown.indexOf("| c");
    // The position read as a Markdown offset lands past the first table
    // and before the second, in no table.
    expect(markdown.indexOf("| a")).toBeLessThan(pos);
    expect(pos).toBeLessThan(second);
    expect(findTableRange(markdown, pos)).toBeNull();
    expect(tableIndexAt(doc, pos)).toBe(1);
    expect(tableOffsetAt(doc, pos, markdown)).toBe(second);
    expect(findTableRange(markdown, second)?.source).toBe(
      "| c | d |\n| - | - |\n| 3 | 4 |",
    );
    expect(tableOffsetAt(doc, posOf(doc, "2"), markdown)).toBe(markdown.indexOf("| a"));
  });

  it("finds no table for a cursor outside one", () => {
    expect(tableOffsetAt(doc, posOf(doc, "Middle"), markdown)).toBeNull();
    expect(tableOffsetAt(doc, 0, markdown)).toBeNull();
  });

  it("leaves out a table in a container, as the Markdown finder does", () => {
    const quoted = schema.node("doc", null, [
      blockquote.create(null, grid([["q"], ["1"]])),
      grid([["t"], ["2"]]),
    ]);
    const md = "> | q |\n> | - |\n> | 1 |\n\n| t |\n| - |\n| 2 |\n";
    expect(tableOffsetAt(quoted, posOf(quoted, "q"), md)).toBeNull();
    expect(tableOffsetAt(quoted, posOf(quoted, "2"), md)).toBe(md.indexOf("| t"));
  });

  it("finds none when the Markdown has no table with the index", () => {
    expect(tableOffsetAt(doc, posOf(doc, "3"), "| a |\n| - |\n")).toBeNull();
  });
});
