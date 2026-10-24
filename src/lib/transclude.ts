/**
 * transclude.ts — extract a section of a Markdown document for a partial
 * Obsidian embed: `![[note#Heading]]` or `![[note#^blockid]]`.
 *
 * Heading embeds return the heading and everything under it up to the next
 * heading of the same-or-higher level. Block embeds (`^id`) return the single
 * block (paragraph/list item) tagged with that id, with the `^id` marker
 * stripped. If the fragment can't be located, the full content is returned so
 * the embed still shows something useful.
 */

import { atxHeadings, markdownLines } from "./outline";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split a wikilink target into its file part and `#fragment` (without the #). */
export function splitFragment(target: string): {
  file: string;
  fragment: string | null;
} {
  const hash = target.indexOf("#");
  if (hash < 0) return { file: target, fragment: null };
  return { file: target.slice(0, hash), fragment: target.slice(hash + 1) };
}

/** Extract the section named by `fragment` from `content` (see module doc). */
export function extractSection(content: string, fragment: string): string {
  const lines = content.split("\n");

  // Block reference: a text line ending with ` ^id`, by the line rule of
  // the Outline (markdownLines). A `^id` in front matter or in fenced or
  // indented code is not one, as Obsidian reads it; it used to be found
  // on any line, and the block then ran back over the fence above it.
  if (fragment.startsWith("^")) {
    const id = fragment.slice(1);
    const blockRe = new RegExp(`\\s\\^${escapeRegExp(id)}\\s*$`);
    const kinds = markdownLines(content);
    const text = (i: number) => kinds[i]?.kind === "text";
    const idx = lines.findIndex((l, i) => text(i) && blockRe.test(l));
    if (idx < 0) return content;
    // Walk back to the start of the block: a blank line or a line that is
    // not text (a fence, code, front matter or HTML) ends it.
    let start = idx;
    while (start > 0 && text(start - 1) && lines[start - 1].trim() !== "") start--;
    return lines
      .slice(start, idx + 1)
      .join("\n")
      .replace(blockRe, "")
      .trim();
  }

  // Heading reference. Headings are read as the outline reads them
  // (atxHeadings): a `# comment` in front matter or fenced code, or one
  // indented as code, used to be a heading here, and `## Goals ##` did not
  // match `Goals`.
  const wanted = fragment.trim().toLowerCase();
  const headings = atxHeadings(content);
  const at = headings.findIndex((h) => h.text.toLowerCase() === wanted);
  if (at < 0) return content;
  const startIdx = headings[at].line - 1;
  const level = headings[at].depth;
  const next = headings.slice(at + 1).find((h) => h.depth <= level);
  const endIdx = next ? next.line - 1 : lines.length;
  return lines.slice(startIdx, endIdx).join("\n").trim();
}

/** File extensions Obsidian renders as inline images in an `![[…]]` embed. */
export const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "bmp",
  "avif",
];

/** True if `file` names an image we should embed as an `<img>`. */
export function isImageTarget(file: string): boolean {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.includes(file.slice(dot + 1).toLowerCase());
}

/**
 * Plain-text attachments a wikilink may resolve to (`resolve_wikilink`'s
 * TEXT_EXTENSIONS in src-tauri/src/document.rs). An embed shows their text
 * as written, not read as Markdown.
 */
export const PLAIN_TEXT_EXTENSIONS = ["txt", "text", "csv", "tsv"];

/** True if `file` names a plain-text attachment ({@link PLAIN_TEXT_EXTENSIONS}). */
export function isPlainTextTarget(file: string): boolean {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return false;
  return PLAIN_TEXT_EXTENSIONS.includes(file.slice(dot + 1).toLowerCase());
}
