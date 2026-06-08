/**
 * remark-highlights.ts
 *
 * Remark plugin that transforms Obsidian-style `==highlight==` syntax into
 * `<mark class="highlight">` elements.
 *
 * Rules:
 *   - `==text==` → <mark class="highlight">text</mark>
 *   - Content must be non-empty and not purely whitespace.
 *   - `====` (empty or whitespace-only delimiters) is left as plain text.
 *   - Text nodes inside `inlineCode` (or any code parent) are never touched.
 *
 * Modeled on remark-wikilinks: operates on `text` nodes, splices replacement
 * nodes into the parent's children array, and skips code contexts.
 */

import type { Root, Text } from "mdast";
import { visit } from "unist-util-visit";

/** Remark plugin: converts ==text== into <mark class="highlight"> nodes. */
export function remarkHighlights() {
  // Tempered-token match (`(?!==)` per char) so content can't contain `==` and
  // there's no catastrophic backtracking on `=`-heavy input. Built per-tree so
  // the stateful `g` regex is never shared across concurrent renders.
  const HIGHLIGHT_RE = /==(?:(?!==)[\s\S])+?==/g;

  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (index == null || !parent || !node.value.includes("==")) return;

      // Skip text inside code contexts where the markers are literal.
      if (["code", "inlineCode"].includes(parent.type)) {
        return;
      }

      // biome-ignore lint/suspicious/noExplicitAny: mdast→hast custom nodes
      const replacement: any[] = [];
      let last = 0;
      HIGHLIGHT_RE.lastIndex = 0;
      let m: RegExpExecArray | null = HIGHLIGHT_RE.exec(node.value);
      while (m !== null) {
        const full = m[0];
        const inner = full.slice(2, -2);
        const start = m.index;

        if (start > last) {
          replacement.push({ type: "text", value: node.value.slice(last, start) });
        }

        if (inner.trim() === "") {
          // Whitespace-only (e.g. `==   ==`) is not a highlight — keep it literal.
          replacement.push({ type: "text", value: full });
        } else {
          replacement.push({
            type: "highlight",
            data: {
              hName: "mark",
              hProperties: { className: ["highlight"] },
            },
            children: [{ type: "text", value: inner }],
          });
        }

        last = start + full.length;
        m = HIGHLIGHT_RE.exec(node.value);
      }

      if (replacement.length === 0) return;
      if (last < node.value.length) {
        replacement.push({ type: "text", value: node.value.slice(last) });
      }

      parent.children.splice(index, 1, ...replacement);
      // Skip past the inserted nodes — none of the text slices contain "==".
      return index + replacement.length;
    });
  };
}
