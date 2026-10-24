/**
 * milkdownListEnter.ts: list continuation on Enter in the visual editor.
 */

import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { continueList, detectListContext } from "./editorShortcuts";

/**
 * The transaction for Enter with the cursor (an empty selection) after a
 * list item typed as text (`- a`, `1. b`, the text of the cursor's line up
 * to it), or `null` when Enter there is not list continuation: in a code
 * block, whose `- x` lines are code, or on a line that is no list item.
 * A non-empty item gets a line break and the next marker; an empty one
 * (`- `) loses its marker, which leaves the line blank and ends the list.
 */
export function listEnterTransaction(state: EditorState): Transaction | null {
  const sel = state.selection;
  if (sel.from !== sel.to) return null;
  const pos = sel.from;
  const $pos = state.doc.resolve(pos);
  if ($pos.parent.type.spec.code) return null;
  const lineStart = $pos.start();
  const lineText = state.doc.textBetween(lineStart, pos, "\n");
  const listCtx = detectListContext(lineText);
  if (!listCtx) return null;
  const continuation = continueList(listCtx);
  if (continuation === "") {
    // The marker is the text after the line's last break. Only it is
    // deleted: the line used to be replaced from the position before its
    // block, across the block boundary, with a text "\n", which put a
    // newline character into the text in place of a blank line.
    const marker = lineText.slice(lineText.lastIndexOf("\n") + 1);
    const from = pos - marker.length;
    // An inline node with no text (an image) in it leaves it alone.
    if (from < lineStart || state.doc.textBetween(from, pos, "\n") !== marker)
      return null;
    return state.tr.delete(from, pos);
  }
  return state.tr.insertText(continuation, pos, pos);
}
