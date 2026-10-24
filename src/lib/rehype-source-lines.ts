/**
 * rehype-source-lines.ts
 *
 * Rehype plugin that gives each top-level block of the rendered document the
 * source line it starts on, as `data-source-line`, so a search hit for line
 * N can scroll the read view to the block holding that line
 * ({@link revealLine} in ./revealLine).
 *
 * It runs after rehype-sanitize, so a document's raw HTML cannot set the
 * attribute (the sanitizer allows no `data-source-line`).
 */

import type { Root } from "hast";

/** Rehype plugin: sets `data-source-line` on each top-level element. */
export function rehypeSourceLines() {
  return (tree: Root) => {
    for (const node of tree.children) {
      if (node.type !== "element") continue;
      const line = node.position?.start.line;
      if (line) node.properties.dataSourceLine = line;
    }
  };
}
