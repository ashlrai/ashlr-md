/**
 * remark-comments.ts
 *
 * Remark plugin that strips Obsidian-style inline comments (`%%text%%`) from
 * the rendered output. Obsidian hides these in Reading View; this plugin
 * replicates that behaviour by removing the delimiters and their content.
 *
 * Scope:
 *   - Inline only: `%%comment%%` within a single text node is removed.
 *   - Block / multi-line comments (where `%%` spans paragraph boundaries) are
 *     out of scope and are left as-is.
 *   - Text nodes inside `inlineCode` (or `code`) are never touched.
 *
 * Modeled on remark-wikilinks / remark-highlights: operates on `text` nodes
 * and splices replacement nodes (or removes spans) in the parent's children.
 */

import type { Root, Text } from "mdast";
import { visit } from "unist-util-visit";

/** Remark plugin: removes %%comment%% spans from visible text. */
export function remarkComments() {
  // Tempered-token match (`(?!%%)` per char) so content can't contain `%%` and
  // there's no catastrophic backtracking on `%`-heavy input. Built per-tree so
  // the stateful `g` regex is never shared across concurrent renders.
  const COMMENT_RE = /%%(?:(?!%%)[\s\S])+%%/g;

  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (index == null || !parent || !node.value.includes("%%")) return;

      // Skip text inside code contexts.
      if (["code", "inlineCode"].includes(parent.type)) {
        return;
      }

      // Build a replacement array by keeping only the non-comment spans.
      // biome-ignore lint/suspicious/noExplicitAny: mdast parent children
      const replacement: any[] = [];
      let last = 0;
      COMMENT_RE.lastIndex = 0;
      let m: RegExpExecArray | null = COMMENT_RE.exec(node.value);
      while (m !== null) {
        const start = m.index;
        // Keep the text before the comment.
        if (start > last) {
          replacement.push({ type: "text", value: node.value.slice(last, start) });
        }
        // Comment content is intentionally dropped.
        last = start + m[0].length;
        m = COMMENT_RE.exec(node.value);
      }

      if (replacement.length === 0 && last === 0) {
        // No comments found — leave node untouched.
        return;
      }

      // Keep trailing text after the last comment.
      if (last < node.value.length) {
        replacement.push({ type: "text", value: node.value.slice(last) });
      }

      if (replacement.length === 0) {
        // The entire node was a comment; remove it.
        parent.children.splice(index, 1);
        return index;
      }

      parent.children.splice(index, 1, ...replacement);
      return index + replacement.length;
    });
  };
}
