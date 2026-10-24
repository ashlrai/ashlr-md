/**
 * YAML frontmatter helpers.
 *
 * Milkdown/Crepe does not support frontmatter (it would render the `---` block
 * as a paragraph), so before handing content to the WYSIWYG editor we split the
 * frontmatter off, edit only the body, and re-attach the frontmatter on save.
 * The raw source editor, by contrast, edits the full content losslessly.
 */

export interface SplitDocument {
  /** The frontmatter block including its closing fence and trailing newline, or "". */
  frontmatter: string;
  /** Everything after the frontmatter. */
  body: string;
}

/**
 * Split `raw` into its leading front matter block (its closing delimiter
 * and the newline after it included) and the body, by the rule of
 * {@link stripFrontmatter}: the editor hides exactly the block the Outline
 * and mdopener-mcp skip. It used to have its own pattern, so a closer such
 * as `---abc` ended the block (leaving `abc` in the body), while `--- ` with
 * a trailing space, a `...` closer and an empty block (`---` then `---`)
 * did not. A leading byte order mark stays in `frontmatter` (alone, when
 * there is no block), so the body the visual editor gets has none: it
 * dropped the mark, so a saved edit lost it, and the mark hid the block
 * behind it, which the editor then got as Markdown in the body.
 */
export function splitFrontmatter(raw: string): SplitDocument {
  const { lines, offset } = stripFrontmatter(raw);
  // A byte order mark with no front matter is kept with the front matter
  // (""), so the visual editor, which drops it, does not lose it on save.
  if (offset === 0) {
    return raw.startsWith("\uFEFF")
      ? { frontmatter: "\uFEFF", body: raw.slice(1) }
      : { frontmatter: "", body: raw };
  }
  const all = raw.split("\n");
  const frontmatter = all.slice(0, offset).join("\n") + (lines.length > 0 ? "\n" : "");
  return { frontmatter, body: lines.join("\n") };
}

/** Whether `text` breaks its lines with CRLF: it has `\r\n` and no lone `\n`. */
export function usesCrlf(text: string): boolean {
  return text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
}

/**
 * `body`, the visual editor's Markdown (which it writes with LF), in CRLF
 * when `crlf`: a CRLF file edited there used to be saved with an LF body
 * after its CRLF front matter, so every line of it changed.
 */
export function inLineBreaks(body: string, crlf: boolean): string {
  return crlf ? body.replace(/\r?\n/g, "\r\n") : body;
}

/** Re-attach frontmatter to an edited body. */
export function joinFrontmatter(frontmatter: string, body: string): string {
  return frontmatter ? frontmatter + body : body;
}

/** A front matter delimiter line without the spaces, tabs and `\r` after it. */
function delimiter(line: string): string {
  return line.replace(/[ \t\r]+$/, "");
}

/**
 * Strip a leading YAML front matter block from `markdown`, split into
 * lines: a first line of `---` closed by a later `---` or `...` line, each
 * at column 0 with only spaces and tabs after it, as remark-frontmatter
 * (the renderer) reads one. Returns the body lines and how many lines were
 * removed, so line numbers stay accurate against the original document. A
 * `---` never closed is a thematic break and nothing is removed. The rule
 * of mdopener-mcp's `markdown_lines::front_matter_len`. The Outline and the
 * review detector each trimmed the first line, so `  ---` (a thematic
 * break on the page) opened front matter and hid the lines after it.
 */
export function stripFrontmatter(markdown: string): {
  lines: string[];
  offset: number;
} {
  const lines = markdown.split("\n");
  // A byte order mark before it (Notepad saves one) is no text: micromark
  // drops it, so the page reads the block as front matter.
  const first = lines[0]?.replace(/^\uFEFF/, "") ?? "";
  if (lines.length === 0 || delimiter(first) !== "---") return { lines, offset: 0 };
  for (let i = 1; i < lines.length; i++) {
    const t = delimiter(lines[i]);
    if (t === "---" || t === "...") return { lines: lines.slice(i + 1), offset: i + 1 };
  }
  return { lines, offset: 0 };
}
