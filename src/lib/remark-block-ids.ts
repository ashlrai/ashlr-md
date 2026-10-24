/**
 * remark-block-ids.ts
 *
 * Obsidian block references: a block ending in ` ^id` (`Some text ^abc12`)
 * can be linked as `[[note#^abc12]]`. The read view showed the `^abc12` as
 * text and gave the block no anchor, so such a link opened the note at its
 * top. This plugin takes the marker off and puts the id on the block: the
 * paragraph, or the list item when the paragraph is an item's text. A
 * paragraph that is only `^id`, right after another block (a table, a quote,
 * a list), names that block, as Obsidian reads it.
 *
 * The id is `^id`; the sanitizer prefixes it (`user-content-^id`), which
 * `anchorElement` (docLinks.ts) finds. The rule for a block's marker is
 * transclude.ts's `extractSection`: whitespace, `^`, then letters, digits
 * and `-`, at the end of the block.
 */

import type { Paragraph, Parent, Root, RootContent } from "mdast";
import { visit } from "unist-util-visit";

/** ` ^id` at the end of a block's text, with the whitespace before it. */
const TRAILING_ID = /\s\^([A-Za-z0-9-]+)\s*$/;
/** A paragraph that is only `^id`. */
const ONLY_ID = /^\s*\^([A-Za-z0-9-]+)\s*$/;

function setId(node: RootContent | Parent, id: string): void {
  if (!node.data) node.data = {};
  const data = node.data as { hProperties?: Record<string, unknown> };
  data.hProperties = { ...(data.hProperties ?? {}), id: `^${id}` };
}

/** Remark plugin: anchors Obsidian `^block` ids (see module doc). */
export function remarkBlockIds() {
  return (tree: Root) => {
    visit(tree, "paragraph", (node: Paragraph, index, parent) => {
      if (index == null || !parent) return;
      const last = node.children[node.children.length - 1];
      if (last?.type !== "text") return;

      const only = node.children.length === 1 ? ONLY_ID.exec(last.value) : null;
      if (only && index > 0) {
        // `^id` on its own after a block: the block before it is the one.
        setId(parent.children[index - 1], only[1]);
        parent.children.splice(index, 1);
        return index;
      }

      const m = TRAILING_ID.exec(last.value);
      if (!m) return;
      last.value = last.value.slice(0, m.index);
      // An item's text paragraph is unwrapped in a tight list, so the id
      // goes on the item.
      const target =
        parent.type === "listItem" && parent.children[0] === node ? parent : node;
      setId(target, m[1]);
    });
  };
}
