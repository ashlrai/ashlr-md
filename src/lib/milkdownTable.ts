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
