/**
 * milkdownTable.ts: find the Markdown table of the visual editor's cursor.
 *
 * The visual editor (Milkdown) holds a ProseMirror document, whose
 * positions count node boundaries and not Markdown characters, so a
 * position is no offset into the body's Markdown: the table menu used to
 * read it as one and found another table, or none, after a few lines of
 * text. The cursor's table is found instead by its index among the
 * document's tables, and the Markdown table with that index
 * ({@link nthTableStart}) is the one the menu edits.
 */

import type { Node } from "@milkdown/kit/prose/model";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { nthTableStart } from "./tableEditor";

/**
 * The index (0-based, in document order) of the top-level table that
 * holds position `pos` of `doc` among the document's top-level tables, or
 * `null` when `pos` is in none. A table in a blockquote or a list item is
 * left out, as the Markdown table finder ({@link nthTableStart}) reads
 * only tables outside containers.
 */
export function tableIndexAt(doc: Node, pos: number): number | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if ($pos.depth < 1 || $pos.node(1).type.name !== "table") return null;
  const at = $pos.index(0);
  let index = 0;
  for (let i = 0; i < at; i++) if (doc.child(i).type.name === "table") index++;
  return index;
}

/**
 * The offset in the body's Markdown of the table that holds position
 * `pos` of the visual editor's document `doc` (the start of its header
 * row), or `null` when `pos` is in no table or the Markdown has no table
 * with its index.
 */
export function tableOffsetAt(doc: Node, pos: number, markdown: string): number | null {
  const index = tableIndexAt(doc, pos);
  return index === null ? null : nthTableStart(markdown, index);
}

/**
 * The index among the Markdown's tables of the one starting at `offset`
 * (as {@link tableOffsetAt} gives it), or `null` when none starts there.
 */
export function tableIndexOfOffset(markdown: string, offset: number): number | null {
  for (let i = 0; ; i++) {
    const start = nthTableStart(markdown, i);
    if (start === null) return null;
    if (start === offset) return i;
  }
}

/** The position of the `index`th (from 0) top-level table of `doc`, or null. */
function nthTablePos(doc: Node, index: number): { pos: number; node: Node } | null {
  let seen = 0;
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    if (child.type.name === "table") {
      if (seen === index) return { pos, node: child };
      seen++;
    }
    pos += child.nodeSize;
  }
  return null;
}

/**
 * A transaction that makes the visual editor's tree show `parsed` (the
 * body's Markdown after an edit made to it outside the editor, as the
 * editor's parser reads it): the table menu edits the Markdown, and only
 * the document store was given the result, so the editor kept the old
 * table and the next typed edit wrote it back over the menu's change.
 * The `tableIndex`th top-level table is replaced by its new form when both
 * documents have it; otherwise the whole document is. Null when nothing
 * changes.
 */
export function syncTableTransaction(
  state: EditorState,
  parsed: Node,
  tableIndex: number | null,
): Transaction | null {
  const doc = state.doc;
  if (tableIndex !== null) {
    const from = nthTablePos(doc, tableIndex);
    const to = nthTablePos(parsed, tableIndex);
    const sameRest =
      from !== null &&
      to !== null &&
      doc.childCount === parsed.childCount &&
      tablesOf(doc) === tablesOf(parsed);
    if (from && to && sameRest) {
      if (from.node.eq(to.node)) return null;
      return state.tr.replaceWith(from.pos, from.pos + from.node.nodeSize, to.node);
    }
  }
  if (doc.eq(parsed)) return null;
  return state.tr.replaceWith(0, doc.content.size, parsed.content);
}

/** How many top-level tables `doc` has. */
function tablesOf(doc: Node): number {
  let n = 0;
  doc.forEach((child) => {
    if (child.type.name === "table") n++;
  });
  return n;
}
