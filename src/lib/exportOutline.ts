/**
 * exportOutline.ts — build structured outline trees from Markdown headings.
 *
 * Provides two pure, side-effect-free functions consumed by exportOutline()
 * in export.ts:
 *
 *   buildOutlineTree(headings)   → OutlineNode[]     (JSON outline)
 *   buildOpml(nodes, title)      → string            (OPML XML string)
 *
 * Both work from the HeadingItem[] produced by parseHeadings() in outline.ts,
 * so slug parity with the rendered DOM is guaranteed — heading IDs in the
 * JSON output and OPML anchor attributes round-trip to the same fragment
 * identifiers that rehype-slug writes into the read view.
 *
 * ## JSON shape
 *
 *   {
 *     id:       string,          // stable github-slugger id (matches DOM #id)
 *     title:    string,          // plain text (inline markdown stripped)
 *     level:    1 | 2 | 3 | 4 | 5 | 6,
 *     children: OutlineNode[],
 *     metadata: {
 *       startLine: number,       // 1-based line number in source document
 *       endLine:   number | null // 1-based line of the next same-or-higher heading, or null
 *       headingId: string        // alias for id — handy for block-reference tools
 *     }
 *   }
 *
 * ## OPML shape
 *
 *   Standard OPML 2.0 (<opml version="2.0">) with a <head> containing the
 *   document title and a <body> containing one <outline> per heading node.
 *   Children are nested outlines.  The `_note` attribute carries the `#id`
 *   anchor so downstream tools (OmniOutliner, Logseq, etc.) can link back to
 *   the source section.
 *
 * ## Edge cases handled
 *
 *   - Mixed / skipped heading levels (e.g. H1 → H3, no H2): the tree is built
 *     with the actual levels present; H3 becomes a child of the nearest ancestor
 *     with level < 3, not necessarily H2.
 *   - Missing H1: the outline starts at whatever the first heading level is.
 *   - Empty headings list: returns an empty array / minimal valid OPML.
 *   - Duplicate heading text: IDs remain unique because they come from
 *     github-slugger (which appends -1, -2, … for repeats).
 *   - Heading-like lines inside fenced code blocks: already filtered out by
 *     parseHeadings() — exportOutline only sees real headings.
 */

import type { HeadingItem } from "./outline";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single node in the hierarchical outline tree. */
export interface OutlineNode {
  /** github-slugger id — matches the rendered heading's DOM id. */
  id: string;
  /** Plain text heading title (inline markdown already stripped). */
  title: string;
  /** ATX heading level 1–6. */
  level: 1 | 2 | 3 | 4 | 5 | 6;
  /** Child headings at a deeper level. */
  children: OutlineNode[];
  /** Source-location metadata for block-reference tools. */
  metadata: {
    /** 1-based source line number of this heading in the original document. */
    startLine: number;
    /**
     * 1-based line of the *next* heading at the same or higher level, or null
     * when this is the last section in the document. Useful for extracting
     * the body text of a section without re-parsing the document.
     */
    endLine: number | null;
    /** Alias of `id` — convenience for tools that use "headingId" terminology. */
    headingId: string;
  };
}

// ─── buildOutlineTree ─────────────────────────────────────────────────────────

/**
 * Convert a flat list of HeadingItems into a nested OutlineNode tree.
 *
 * Algorithm: maintains a "parent stack" whose invariant is that every entry
 * has a lower level than the current heading.  When we encounter a heading
 * at depth D, we pop entries until the stack top has depth < D (or is empty),
 * then attach the new node as a child of the stack top (or as a root node
 * when the stack is empty).
 *
 * endLine is computed after the tree is built via a second O(n) pass that
 * walks the flat input again and assigns the start line of the next heading
 * at the same or shallower depth.
 */
export function buildOutlineTree(headings: HeadingItem[]): OutlineNode[] {
  if (headings.length === 0) return [];

  // First pass: build the tree structure (without endLines).
  const roots: OutlineNode[] = [];
  // Stack entries are [node, depth] — depth is the heading level number.
  const stack: Array<{ node: OutlineNode; depth: number }> = [];

  for (const h of headings) {
    const node: OutlineNode = {
      id: h.slug,
      title: h.text,
      level: h.depth,
      children: [],
      metadata: {
        startLine: h.line,
        endLine: null, // filled in the second pass
        headingId: h.slug,
      },
    };

    // Pop entries that are at the same or deeper level than the current heading.
    while (stack.length > 0 && stack[stack.length - 1].depth >= h.depth) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }

    stack.push({ node, depth: h.depth });
  }

  // Second pass: fill endLine for each node.
  // For each heading at index i, its endLine is the startLine of the next
  // heading with level <= current level (closing the section), or null.
  for (let i = 0; i < headings.length; i++) {
    const current = headings[i];
    let endLine: number | null = null;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].depth <= current.depth) {
        endLine = headings[j].line;
        break;
      }
    }
    // Find the matching node in the tree by slug + line (slugs are unique
    // within a document because github-slugger deduplicates them).
    setEndLine(roots, current.slug, current.line, endLine);
  }

  return roots;
}

/** Recursively walk the tree and set endLine on the matching node. */
function setEndLine(
  nodes: OutlineNode[],
  slug: string,
  startLine: number,
  endLine: number | null,
): boolean {
  for (const node of nodes) {
    if (node.id === slug && node.metadata.startLine === startLine) {
      node.metadata.endLine = endLine;
      return true;
    }
    if (setEndLine(node.children, slug, startLine, endLine)) return true;
  }
  return false;
}

// ─── buildOpml ────────────────────────────────────────────────────────────────

/** Minimal XML special-character escaping for OPML attribute values. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Serialise an array of OutlineNode trees to OPML 2.0 XML.
 *
 * Each heading becomes an `<outline text="…" _note="#id">` element.
 * Children are nested inside their parent outline element.  The `_note`
 * attribute carries the `#headingId` fragment so OPML readers that display
 * notes (OmniOutliner, WorkFlowy, etc.) show the anchor link.
 *
 * @param nodes  The root nodes produced by buildOutlineTree().
 * @param title  Document title for the OPML <head> block.
 */
export function buildOpml(nodes: OutlineNode[], title: string): string {
  const now = new Date().toUTCString();
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "<head>",
    `  <title>${escapeXml(title)}</title>`,
    `  <dateCreated>${now}</dateCreated>`,
    "</head>",
    "<body>",
  ];

  function serializeNode(node: OutlineNode, indent: number): void {
    const pad = "  ".repeat(indent);
    const attrs =
      `text="${escapeXml(node.title)}"` +
      ` _note="#${escapeXml(node.id)}"` +
      ` level="${node.level}"` +
      ` startLine="${node.metadata.startLine}"` +
      (node.metadata.endLine != null
        ? ` endLine="${node.metadata.endLine}"`
        : "");

    if (node.children.length === 0) {
      lines.push(`${pad}<outline ${attrs}/>`);
    } else {
      lines.push(`${pad}<outline ${attrs}>`);
      for (const child of node.children) {
        serializeNode(child, indent + 1);
      }
      lines.push(`${pad}</outline>`);
    }
  }

  for (const root of nodes) {
    serializeNode(root, 1);
  }

  lines.push("</body>");
  lines.push("</opml>");

  return lines.join("\n");
}
