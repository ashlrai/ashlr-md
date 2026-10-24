/**
 * YAML frontmatter helpers.
 *
 * Milkdown/Crepe does not support frontmatter (it would render the `---` block
 * as a paragraph), so before handing content to the WYSIWYG editor we split the
 * frontmatter off, edit only the body, and re-attach the frontmatter on save.
 * The raw source editor, by contrast, edits the full content losslessly.
 */

const FRONTMATTER_RE = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/;

export interface SplitDocument {
  /** The frontmatter block including its closing fence and trailing newline, or "". */
  frontmatter: string;
  /** Everything after the frontmatter. */
  body: string;
}

export function splitFrontmatter(raw: string): SplitDocument {
  const match = raw.match(FRONTMATTER_RE);
  if (match) {
    return { frontmatter: match[1], body: match[2] };
  }
  return { frontmatter: "", body: raw };
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
  if (lines.length === 0 || delimiter(lines[0]) !== "---") return { lines, offset: 0 };
  for (let i = 1; i < lines.length; i++) {
    const t = delimiter(lines[i]);
    if (t === "---" || t === "...") return { lines: lines.slice(i + 1), offset: i + 1 };
  }
  return { lines, offset: 0 };
}
