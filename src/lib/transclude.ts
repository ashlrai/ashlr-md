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

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;

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

  // Block reference: a line ending with ` ^id`.
  if (fragment.startsWith("^")) {
    const id = fragment.slice(1);
    const blockRe = new RegExp(`\\s\\^${escapeRegExp(id)}\\s*$`);
    const idx = lines.findIndex((l) => blockRe.test(l));
    if (idx < 0) return content;
    // Walk back to the start of the block (previous blank line).
    let start = idx;
    while (start > 0 && lines[start - 1].trim() !== "") start--;
    return lines
      .slice(start, idx + 1)
      .join("\n")
      .replace(blockRe, "")
      .trim();
  }

  // Heading reference.
  const wanted = fragment.trim().toLowerCase();
  let startIdx = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m && m[2].trim().toLowerCase() === wanted) {
      startIdx = i;
      level = m[1].length;
      break;
    }
  }
  if (startIdx < 0) return content;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m && m[1].length <= level) {
      endIdx = i;
      break;
    }
  }
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
