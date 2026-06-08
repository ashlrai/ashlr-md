/**
 * remark-callouts.ts
 *
 * Remark plugin that transforms GitHub-style callout blockquotes into annotated
 * `div` elements that Renderer.tsx can map to <Callout>.
 *
 * Recognised patterns (first paragraph of a blockquote):
 *   > [!NOTE]          > [!TIP]        > [!WARNING]
 *   > [!IMPORTANT]     > [!CAUTION]
 *   > **Note:** …      > **Warning:** … (legacy bold-label style)
 *
 * The plugin rewrites the blockquote node so rehype sees:
 *   <div class="callout callout-{type}" data-callout="{type}">…</div>
 *
 * Normal blockquotes (no recognised marker) pass through completely unchanged.
 */

import type { Root } from "mdast";
import { visit } from "unist-util-visit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported callout kinds (lower-case). */
export type CalloutType = "note" | "tip" | "warning" | "important" | "caution";

const BRACKET_RE = /^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*/i;
const BOLD_LABEL_RE = /^\*\*(Note|Tip|Warning|Important|Caution):\*\*\s*/i;

// Map display labels → canonical type
const LABEL_TO_TYPE: Record<string, CalloutType> = {
  note: "note",
  tip: "tip",
  warning: "warning",
  important: "important",
  caution: "caution",
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/** Returns the plugin function (call with no arguments or as a remark plugin). */
export function remarkCallouts() {
  return (tree: Root) => {
    visit(tree, "blockquote", (node) => {
      // Safety: blockquote must have at least one child paragraph.
      if (!node.children || node.children.length === 0) return;

      const firstChild = node.children[0];
      if (firstChild.type !== "paragraph") return;
      if (!firstChild.children || firstChild.children.length === 0) return;

      // -----------------------------------------------------------------------
      // Try to extract callout type from the first inline child.
      // -----------------------------------------------------------------------
      let calloutType: CalloutType | null = null;

      const firstInline = firstChild.children[0];

      if (firstInline.type === "text") {
        // Pattern: [!NOTE] or [!NOTE] optional title text
        const bracketMatch = BRACKET_RE.exec(firstInline.value);
        if (bracketMatch) {
          calloutType = LABEL_TO_TYPE[bracketMatch[1].toLowerCase()] ?? "note";
          // Trim the marker from the text node value.
          const remaining = firstInline.value.slice(bracketMatch[0].length);
          if (remaining) {
            firstInline.value = remaining;
          } else {
            // Remove the now-empty text node.
            firstChild.children.splice(0, 1);
          }
          // If the paragraph only contained the marker and is now empty, drop it.
          if (firstChild.children.length === 0) {
            node.children.splice(0, 1);
          }
        }
      } else if (firstInline.type === "strong") {
        // Pattern: **Note:** or **Warning:** (legacy style)
        const strongText =
          firstInline.children?.[0]?.type === "text"
            ? firstInline.children[0].value
            : null;
        if (strongText) {
          const boldMatch = BOLD_LABEL_RE.exec(`**${strongText}:**`);
          if (boldMatch) {
            calloutType = LABEL_TO_TYPE[boldMatch[1].toLowerCase()] ?? "note";
            // Remove the strong label node from the paragraph.
            firstChild.children.splice(0, 1);
            // Also strip a leading space/colon that may follow.
            const next = firstChild.children[0];
            if (next?.type === "text" && /^\s*:?\s*/.test(next.value)) {
              next.value = next.value.replace(/^\s*:?\s*/, "");
              if (!next.value) firstChild.children.splice(0, 1);
            }
            if (firstChild.children.length === 0) {
              node.children.splice(0, 1);
            }
          }
        }
      }

      if (!calloutType) return; // Normal blockquote — leave untouched.

      // -----------------------------------------------------------------------
      // Annotate the blockquote node so rehype emits a <div> with our classes.
      // react-markdown + rehype-raw will pass it through; Renderer maps the
      // className to <Callout>.
      // -----------------------------------------------------------------------
      node.data = {
        ...node.data,
        hName: "div",
        hProperties: {
          // biome-ignore lint/suspicious/noExplicitAny: mdast hast bridge
          ...(node.data?.hProperties as any),
          className: ["callout", `callout-${calloutType}`],
          "data-callout": calloutType,
        },
      };
    });
  };
}
