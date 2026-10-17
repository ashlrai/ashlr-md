/**
 * milkdownPasteImage.ts — put a pasted image into the WYSIWYG editor as an
 * image node.
 *
 * `tr.insertText("![](…)")` adds plain text, which Milkdown serializes
 * escaped (`!\[]\(…)`): the image never renders and the saved Markdown is a
 * literal string. Crepe does not re-parse it. So the Markdown reference is
 * parsed with the editor's own parser, and its source becomes an inline
 * `image` node at the selection, which serializes back to `![](…)`.
 */

import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";

/** The editor's Markdown parser (`ctx.get(parserCtx)`). */
export type MarkdownParser = (markdown: string) => ProseNode;

/** The first image's `src` and `alt` in `doc`, or null when it has none. */
function firstImage(doc: ProseNode): { src: string; alt: string } | null {
  let found: { src: string; alt: string } | null = null;
  doc.descendants((node) => {
    if (found) return false;
    const src = node.attrs.src;
    if ((node.type.name === "image" || node.type.name === "image-block") && src) {
      // Crepe's image-block keeps the size ratio where alt text would be.
      const alt = node.type.name === "image" ? String(node.attrs.alt ?? "") : "";
      found = { src: String(src), alt };
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Replace the selection in `view` with the image `markdown` refers to.
 * Returns false (and changes nothing) when the schema has no inline image
 * or `markdown` holds no image.
 */
export function insertImageMarkdown(
  view: EditorView,
  parse: MarkdownParser,
  markdown: string,
): boolean {
  const imageType = view.state.schema.nodes.image;
  if (!imageType) return false;
  const image = firstImage(parse(markdown));
  if (!image) return false;
  const node = imageType.create({ src: image.src, alt: image.alt });
  view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
  return true;
}
