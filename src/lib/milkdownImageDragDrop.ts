/**
 * milkdownImageDragDrop.ts — Pure logic for drag-drop image reordering in
 * Milkdown / ProseMirror editors.
 *
 * Exposes:
 *  - {@link extractImageRefs}  — parse `![[...]]` / `![](<url>)` references out
 *                                of a Markdown string.
 *  - {@link reorderImageInMarkdown} — given source Markdown, move the image at
 *                                     `fromIndex` to `toIndex` in document order
 *                                     and return the updated Markdown string.
 *  - {@link makeDragDropPlugin} — returns a ProseMirror Plugin that intercepts
 *                                 `dragstart` / `drop` events on image nodes and
 *                                 fires `onReorder` so the host component can
 *                                 call `documentStore.setContent()`.
 *
 * The reorder helpers operate on the raw Markdown string (not on the ProseMirror
 * document), so they are easy to unit-test without a live editor.
 */

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";

// ── Regex patterns ─────────────────────────────────────────────────────────────

/**
 * Matches Obsidian-style wiki-image embeds: `![[path]]` or `![[path|alt]]`.
 * Capture group 1 = the full embed token.
 */
const WIKI_IMAGE_RE = /!\[\[([^\]]+)\]\]/g;

/**
 * Matches standard Markdown images: `![alt](url)` (alt may be empty).
 * Capture group 1 = alt text, capture group 2 = url.
 */
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ImageRef {
  /** The full matched token, e.g. `![[image.png]]` or `![](assets/img.png)`. */
  token: string;
  /** Character offset where the token starts in the source string. */
  offset: number;
  /** Either `"wiki"` or `"standard"`. */
  kind: "wiki" | "standard";
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

/**
 * Extract all image references (wiki-embed and standard) from `markdown` in
 * document order.
 */
export function extractImageRefs(markdown: string): ImageRef[] {
  const refs: ImageRef[] = [];

  WIKI_IMAGE_RE.lastIndex = 0;
  for (const m of markdown.matchAll(WIKI_IMAGE_RE)) {
    refs.push({ token: m[0], offset: m.index ?? 0, kind: "wiki" });
  }

  MD_IMAGE_RE.lastIndex = 0;
  for (const m of markdown.matchAll(MD_IMAGE_RE)) {
    refs.push({ token: m[0], offset: m.index ?? 0, kind: "standard" });
  }

  // Sort by position in the document.
  refs.sort((a, b) => a.offset - b.offset);
  return refs;
}

/**
 * Move the image at `fromIndex` (0-based, in document order) to immediately
 * before the image currently at `toIndex`.
 *
 * - If `fromIndex === toIndex` the source is returned unchanged.
 * - Out-of-range indices are clamped and a no-op is returned rather than
 *   throwing, so callers don't have to guard.
 * - The surrounding text (headings, paragraphs, etc.) is preserved; only the
 *   image tokens are relocated.
 *
 * Returns the updated Markdown string.
 */
export function reorderImageInMarkdown(
  markdown: string,
  fromIndex: number,
  toIndex: number,
): string {
  if (fromIndex === toIndex) return markdown;

  const refs = extractImageRefs(markdown);
  if (refs.length < 2) return markdown;

  // Clamp indices.
  const from = Math.max(0, Math.min(fromIndex, refs.length - 1));
  const to = Math.max(0, Math.min(toIndex, refs.length - 1));
  if (from === to) return markdown;

  const dragged = refs[from];

  // Build the string with the dragged token removed first.
  const withoutDragged =
    markdown.slice(0, dragged.offset) +
    markdown.slice(dragged.offset + dragged.token.length);

  // Re-parse positions after removal to find the correct insertion point.
  const refsAfterRemoval = extractImageRefs(withoutDragged);

  // The effective toIndex must account for the removal.
  const effectiveTo = from < to ? to - 1 : to;
  const clampedTo = Math.max(0, Math.min(effectiveTo, refsAfterRemoval.length));

  if (clampedTo >= refsAfterRemoval.length) {
    // Append after the last remaining image ref.
    const last = refsAfterRemoval[refsAfterRemoval.length - 1];
    const insertAt = last.offset + last.token.length;
    return (
      withoutDragged.slice(0, insertAt) +
      "\n" +
      dragged.token +
      withoutDragged.slice(insertAt)
    );
  }

  const insertAt = refsAfterRemoval[clampedTo].offset;
  return (
    withoutDragged.slice(0, insertAt) +
    dragged.token +
    "\n" +
    withoutDragged.slice(insertAt)
  );
}

// ── ProseMirror plugin ─────────────────────────────────────────────────────────

export interface ImageDragDropPluginOptions {
  /**
   * Called when the user successfully drops an image at a new position.
   * `fromIndex` and `toIndex` are document-order indices into the image list
   * returned by {@link extractImageRefs}.
   *
   * The host is responsible for calling `reorderImageInMarkdown` and updating
   * the document store.
   */
  onReorder: (fromIndex: number, toIndex: number) => void;
}

const IMAGE_DRAG_DROP_KEY = new PluginKey("imageDragDrop");

/**
 * Returns a ProseMirror Plugin that:
 *  1. On `dragstart` over an image node — stores its document-order index in
 *     `event.dataTransfer` so the drop handler can identify it.
 *  2. On `drop` over an image node — reads the stored index and fires
 *     `options.onReorder(fromIndex, toIndex)`.
 *
 * The plugin uses a standard DOM event approach (capture on the editor's
 * wrapper DOM), which is compatible with Milkdown Crepe's plugin architecture.
 */
export function makeDragDropPlugin(options: ImageDragDropPluginOptions): Plugin {
  /** The index of the image node being dragged, -1 when no drag is active. */
  let dragFromIndex = -1;

  /**
   * Locate the nearest `img` or `[data-image-index]` ancestor of `target` and
   * return the data-image-index attribute value, or -1.
   */
  function imageIndexFromTarget(target: EventTarget | null): number {
    let el = target as Element | null;
    while (el) {
      const idx = el.getAttribute?.("data-image-index");
      if (idx !== null && idx !== undefined) return Number(idx);
      el = el.parentElement;
    }
    return -1;
  }

  return new Plugin({
    key: IMAGE_DRAG_DROP_KEY,
    view(editorView) {
      const dom = editorView.dom;

      const onDragStart = (event: DragEvent) => {
        const idx = imageIndexFromTarget(event.target);
        if (idx < 0) return;
        dragFromIndex = idx;
        event.dataTransfer?.setData("text/x-image-index", String(idx));
      };

      const onDrop = (event: DragEvent) => {
        if (dragFromIndex < 0) return;
        const toIdx = imageIndexFromTarget(event.target);
        if (toIdx >= 0 && toIdx !== dragFromIndex) {
          event.preventDefault();
          options.onReorder(dragFromIndex, toIdx);
        }
        dragFromIndex = -1;
      };

      const onDragEnd = () => {
        dragFromIndex = -1;
      };

      dom.addEventListener("dragstart", onDragStart as EventListener, true);
      dom.addEventListener("drop", onDrop as EventListener, true);
      dom.addEventListener("dragend", onDragEnd);

      return {
        destroy() {
          dom.removeEventListener("dragstart", onDragStart as EventListener, true);
          dom.removeEventListener("drop", onDrop as EventListener, true);
          dom.removeEventListener("dragend", onDragEnd);
        },
      };
    },
  });
}
