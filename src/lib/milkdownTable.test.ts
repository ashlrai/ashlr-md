import { type Node, Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { describe, expect, it } from "vitest";
import {
  insertTableTransaction,
  syncTableTransaction,
  tableIndexAt,
  tableIndexOfOffset,
  tableOffsetAt,
} from "./milkdownTable";
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

describe("tableIndexOfOffset / syncTableTransaction", () => {
  it("names the table that starts at an offset", () => {
    expect(tableIndexOfOffset(markdown, markdown.indexOf("| a"))).toBe(0);
    expect(tableIndexOfOffset(markdown, markdown.indexOf("| c"))).toBe(1);
    expect(tableIndexOfOffset(markdown, 0)).toBeNull();
  });

  it("replaces the edited table only, or the document when they differ more", () => {
    const state = EditorState.create({ schema, doc });
    const edited = schema.node("doc", null, [
      doc.child(0),
      doc.child(1),
      doc.child(2),
      grid([
        ["c", "d"],
        ["3", "4"],
        ["5", "6"],
      ]),
    ]);
    const tr = syncTableTransaction(state, edited, 1);
    expect(tr?.doc.eq(edited)).toBe(true);
    // Only the table's range was replaced.
    expect(tr?.steps).toHaveLength(1);
    expect(tr?.mapping.map(1)).toBe(1);
    // Nothing to change.
    expect(syncTableTransaction(state, doc, 1)).toBeNull();
    // A table more: the whole document is replaced.
    const more = schema.node("doc", null, [...edited.content.content, grid([["x"]])]);
    expect(syncTableTransaction(state, more, 1)?.doc.eq(more)).toBe(true);
  });
});

describe("insertTableTransaction", () => {
  const wizard = schema.node("doc", null, [
    grid([
      ["H1", "H2"],
      ["a", "b"],
    ]),
  ]);
  const at = (d: Node, pos: number) =>
    EditorState.create({ doc: d, selection: TextSelection.create(d, pos) });

  it("inserts a real table after the cursor's block, not its Markdown as text", () => {
    const d = schema.node("doc", null, [
      p.create(null, text("Before")),
      p.create(null, text("After")),
    ]);
    const tr = insertTableTransaction(at(d, 3), wizard);
    const out = tr?.doc;
    expect(out?.childCount).toBe(3);
    expect(out?.child(0).textContent).toBe("Before");
    expect(out?.child(1).type.name).toBe("table");
    expect(out?.child(1).eq(wizard.child(0))).toBe(true);
    expect(out?.child(2).textContent).toBe("After");
    // No text with pipes anywhere.
    expect(out?.textContent.includes("|")).toBe(false);
  });

  it("replaces an empty paragraph the cursor is in", () => {
    const d = schema.node("doc", null, [p.create(null, text("A")), p.create()]);
    const out = insertTableTransaction(at(d, 4), wizard)?.doc;
    expect(out?.childCount).toBe(2);
    expect(out?.child(1).type.name).toBe("table");
  });

  it("is null without a table to insert", () => {
    const d = schema.node("doc", null, [p.create(null, text("A"))]);
    const none = schema.node("doc", null, [p.create(null, text("| a |"))]);
    expect(insertTableTransaction(at(d, 1), none)).toBeNull();
  });
});
