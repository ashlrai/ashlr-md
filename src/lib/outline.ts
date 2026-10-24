/**
 * outline.ts — extract a heading outline (table of contents) from Markdown.
 *
 * Produces the same heading slugs the rendered document uses so the Outline
 * panel's anchor links line up with the ids rehype-slug writes into the DOM.
 *
 * Slug parity: the read view renders through `rehype-slug` (see
 * src/components/viewer/Renderer.tsx), which slugifies each heading's rendered
 * text via `github-slugger`. We import the *same* library here and feed it the
 * heading's plain text (markdown inline syntax stripped), so a given heading
 * yields a byte-identical slug — including lowercase folding, accented-letter
 * retention, and `-1`/`-2` de-duplication. Confirmed against the renderer's
 * plugin list (`rehypeSlug`, default config) and github-slugger@2.
 */

import GithubSlugger from "github-slugger";
import { stripFrontmatter } from "./frontmatter";

export interface HeadingItem {
  /** ATX heading level, 1–6. */
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  /** Rendered heading text (inline markdown stripped, whitespace collapsed). */
  text: string;
  /** Slug id matching the rendered heading's DOM id (anchor target). */
  slug: string;
  /** 1-based source line number of the heading (within the full document). */
  line: number;
}

/**
 * Reduce inline markdown to its plain rendered text so slugs/labels match the
 * DOM. Mirrors what a reader sees: emphasis/strong/strikethrough markers gone,
 * inline-code backticks gone, links/images reduced to their visible label.
 */
function stripInline(text: string): string {
  let s = text;
  // Images: ![alt](url) -> alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links: [label](url) -> label  and  [label][ref] -> label
  s = s.replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  // Inline code: `code` -> code (handles 1+ backtick fences)
  s = s.replace(/(`+)(.+?)\1/g, "$2");
  // Strong / emphasis / strikethrough markers.
  s = s.replace(/(\*\*\*|___)(.+?)\1/g, "$2");
  s = s.replace(/(\*\*|__)(.+?)\1/g, "$2");
  s = s.replace(/(\*|_)(.+?)\1/g, "$2");
  s = s.replace(/~~(.+?)~~/g, "$1");
  return s.replace(/\s+/g, " ").trim();
}

/** An ATX heading's level and text, from {@link atxHeading}. */
export interface AtxHeading {
  depth: HeadingItem["depth"];
  /** The heading's source text, trimmed, without its closing `#`s. */
  text: string;
}

/**
 * The level and text of `line` when it is an ATX heading, as CommonMark
 * reads one and as mdopener-mcp does (`markdown_lines::atx_heading`): at
 * most three spaces of indentation, 1 to 6 `#`s, then a space, a tab or the
 * end of the line. The text is trimmed and loses a closing run of `#`s that
 * follows a space or a tab, so `Title ##` is `Title`, `C#` keeps its `#`,
 * and `## ##` is empty. A line indented by a tab or four spaces is indented
 * code, and `#tag` is text.
 */
export function atxHeading(line: string): AtxHeading | null {
  const l = line.endsWith("\r") ? line.slice(0, -1) : line;
  const m = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/.exec(l);
  if (!m) return null;
  let text = m[2].replace(/^[ \t]+|[ \t]+$/g, "");
  const open = text.replace(/#+$/, "");
  if (open.length !== text.length) {
    if (open === "") text = "";
    else if (/[ \t]$/.test(open)) text = open.replace(/[ \t]+$/, "");
  }
  return { depth: m[1].length as HeadingItem["depth"], text };
}

/**
 * The fence character, its run length and the rest of the line when `line`
 * is a code fence: at most three spaces, then three or more backticks or
 * tildes, and a backtick fence's info string has no backtick, or two or
 * more `$` with no `$` after them, the fence of a math block. The rule of
 * mdopener-mcp's `markdown_lines`.
 */
function codeFence(line: string): { marker: string; rest: string } | null {
  // Two or more `$` open a math block, which the page renders with
  // remark-math and micromark reads as it reads fenced code; its info
  // string has no `$` (`$$x$$` is inline math).
  const m = /^ {0,3}(`{3,}|~{3,}|\${2,})(.*)$/.exec(line);
  if (!m) return null;
  if ((m[1][0] === "`" || m[1][0] === "$") && m[2].includes(m[1][0])) return null;
  return { marker: m[1], rest: m[2] };
}

/** Whether fence `f` closes a block opened by `marker`. */
function closesFence(f: ReturnType<typeof codeFence>, marker: string): boolean {
  return (
    f !== null &&
    f.marker[0] === marker[0] &&
    f.marker.length >= marker.length &&
    f.rest.trim() === ""
  );
}

/**
 * `line` with each tab replaced by the spaces that reach the next multiple
 * of four columns, as CommonMark reads indentation.
 */
function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  let column = 0;
  for (const ch of line) {
    const n = ch === "\t" ? 4 - (column % 4) : 1;
    out += ch === "\t" ? " ".repeat(n) : ch;
    column += n;
  }
  return out;
}

/** How many spaces `line` (tabs expanded) starts with. */
function spacesBefore(line: string): number {
  return line.length - line.replace(/^ +/, "").length;
}

/**
 * `line` (tabs expanded) without the blockquote marker that opens it (at
 * most three spaces, `>`, then one optional space), or null when it has
 * none. The rule of mdopener-mcp's `markdown_lines::quote_marker`.
 */
function quoteMarker(line: string): string | null {
  const m = /^ {0,3}>/.exec(line);
  if (!m) return null;
  const after = line.slice(m[0].length);
  return after.startsWith(" ") ? after.slice(1) : after;
}

/**
 * The content column of the list item `line` (tabs expanded) opens, past
 * the line's start, and the rest of the line, or null when it opens none:
 * at most three spaces, `-`, `*`, `+` or 1 to 9 digits and `.` or `)`,
 * then one to four spaces before the text. An item with nothing after its
 * marker, or with five or more spaces (indented code), has its content one
 * column past the marker, as in CommonMark. `one` is false for an ordered
 * item that does not start at 1. The rule of mdopener-mcp's
 * `markdown_lines::list_marker`.
 */
function listMarker(
  line: string,
): { width: number; rest: string; one: boolean } | null {
  const m = /^ {0,3}(?:[-*+]|(\d{1,9})[.)])/.exec(line);
  if (!m) return null;
  const end = m[0].length;
  const after = line.slice(end);
  const spaces = spacesBefore(after);
  // Whether the item may interrupt a paragraph by its marker.
  const one = m[1] === undefined || Number(m[1]) === 1;
  if (after.trim() === "") return { width: end + 1, rest: "", one };
  if (spaces === 0) return null;
  if (spaces > 4) return { width: end + 1, rest: after.slice(1), one };
  return { width: end + spaces, rest: after.slice(spaces), one };
}

/**
 * Whether `line` (tabs expanded) is a thematic break: at most three
 * spaces, then three or more `-`, `*` or `_`, spaces between them allowed.
 */
function thematicBreak(line: string): boolean {
  return /^ {0,3}([-*_])( *\1){2,} *$/.test(line);
}

/**
 * A container a line can sit in: a blockquote, or a list item with how
 * many columns its content is past the container before it, or a GFM
 * footnote definition (`[^n]: x`), whose content goes on four columns past
 * the container before it.
 */
type Container = { quote: true } | { quote: false; width: number; footnote?: true };

/**
 * The label of the GFM footnote definition `line` (tabs expanded) opens
 * and the rest of the line past its `:` and the spaces after it, or null:
 * at most three spaces, `[^`, a label of 1 to 999 characters with no space
 * and no unescaped bracket, then `]:`, as micromark reads it. `[^a b]: x`
 * and `[^]: x` are link reference definitions. The rule of mdopener-mcp's
 * `markdown_lines::footnote_marker`.
 */
function footnoteMarker(line: string): { label: string; rest: string } | null {
  const m = /^ {0,3}\[\^((?:\\[[\\\]]|[^\s[\]\\]|\\(?![[\\\]]))+)\]:/u.exec(line);
  if (!m || [...m[1]].length > 999) return null;
  return { label: m[1], rest: line.slice(m[0].length).replace(/^ +/, "") };
}

/**
 * How many lines the link reference definition that `text` (a line past its
 * containers) starts takes, or null when it starts none; `following` holds
 * the lines after it in its paragraph. As CommonMark reads one: at most three
 * spaces, `[label]:` (a label with some text and no unescaped bracket), a
 * destination (`<...>`, or text with no space) on the line or, with nothing
 * after the colon, on the next line, then optionally a title in quotes or
 * parentheses, which may start on the line after the destination and go on
 * over lines, and nothing else. The rule of mdopener-mcp's
 * `markdown_lines::reference_definition`.
 */
function referenceDefinition(text: string, following: string[]): number | null {
  const body = text.replace(/^ +/, "");
  if (text.length - body.length > 3 || !body.startsWith("[")) return null;
  const inner = body.slice(1);
  let end = -1;
  let escaped = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (escaped) escaped = false;
    else if (c === "\\") escaped = true;
    else if (c === "[") return null;
    else if (c === "]") {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const label = inner.slice(0, end);
  if (label.trim() === "" || [...label].length > 999) return null;
  if (inner[end + 1] !== ":") return null;
  const rest = inner.slice(end + 2).trim();
  let dest = rest;
  let lines = 1;
  if (rest === "") {
    dest = following[0]?.trim() ?? "";
    if (dest === "") return null;
    lines = 2;
  }
  let after: string;
  if (dest.startsWith("<")) {
    const inside = dest.slice(1);
    const close = inside.search(/[<>]/);
    if (close < 0 || inside[close] !== ">") return null;
    after = inside.slice(close + 1);
  } else {
    const space = dest.search(/[ \t]/);
    after = space < 0 ? "" : dest.slice(space);
  }
  const more = following.slice(lines - 1);
  if (after.trim() === "") {
    // A title may start on the line after the destination.
    const title =
      more.length > 0 ? titleLines(more[0].trimStart(), more.slice(1)) : null;
    return lines + (title === null ? 0 : title + 1);
  }
  if (!/^[ \t]/.test(after)) return null;
  const title = titleLines(after.trimStart(), more);
  return title === null ? null : lines + title;
}

/**
 * How many lines of `more` the link title that starts `first` goes on over,
 * when it is a whole title (`"..."`, `'...'` or `(...)`, with no blank line
 * inside) with nothing but spaces after it.
 */
function titleLines(first: string, more: string[]): number | null {
  const close = ({ '"': '"', "'": "'", "(": ")" } as Record<string, string>)[first[0]];
  if (close === undefined) return null;
  // Whether `line` closes the title; undefined when more follows the close.
  const closes = (line: string): boolean | undefined => {
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === close) return line.slice(i + 1).trim() === "" ? true : undefined;
    }
    return false;
  };
  const head = closes(first.slice(1));
  if (head === undefined) return null;
  if (head) return 0;
  for (let n = 0; n < more.length; n++) {
    if (more[n].trim() === "") return null;
    const c = closes(more[n]);
    if (c === undefined) return null;
    if (c) return n + 1;
  }
  return null;
}

/**
 * How many of a paragraph's `lines` (each past its containers) the link
 * reference definitions at its start take, as micromark reads them: one
 * goes on after another, and the first line that starts none ends them.
 */
function definitionsLength(lines: string[]): number {
  let i = 0;
  while (i < lines.length) {
    // A definition after another one goes on with its paragraph, which
    // takes the line's indentation off.
    const text = i === 0 ? lines[i] : lines[i].trimStart();
    const n = referenceDefinition(text, lines.slice(i + 1));
    if (n === null) break;
    i += n;
  }
  return i;
}

/** How an HTML block ends, by the kind its first line opens. */
type HtmlEnd = "raw" | "comment" | "instruction" | "declaration" | "cdata" | "blank";

/** The tag names of an HTML block of the sixth kind, as micromark lists them. */
const HTML_BLOCK_NAMES = new Set(
  (
    "address article aside base basefont blockquote body caption center col " +
    "colgroup dd details dialog dir div dl dt fieldset figcaption figure footer " +
    "form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li " +
    "link main menu menuitem nav noframes ol optgroup option p param search " +
    "section summary table tbody td tfoot th thead title tr track ul"
  ).split(" "),
);

/** The tag names of an HTML block of the first kind. */
const HTML_RAW_NAMES = ["pre", "script", "style", "textarea"];

/** A whole open tag's attributes, `/` and `>`, after its name. */
const OPEN_TAG_TAIL =
  /^(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>/;

/**
 * How the HTML block that `line` (tabs expanded, past its containers)
 * opens ends, and whether it may interrupt a paragraph, or null, as
 * CommonMark and micromark read it: at most three spaces, then `<` and
 * `!--` (ended by `-->`), `?` (`?>`), `![CDATA[` (`]]>`), `!` and a letter
 * (`>`), `pre`, `script`, `style` or `textarea` (their closing tag), a
 * block-level tag name (a blank line), or any other whole open or closing
 * tag alone on its line (a blank line; it cannot interrupt a paragraph).
 * The rule of mdopener-mcp's `markdown_lines::html_start`.
 */
function htmlStart(line: string): { end: HtmlEnd; interrupts: boolean } | null {
  const m = /^ {0,3}</.exec(line);
  if (!m) return null;
  const after = line.slice(m[0].length);
  if (after.startsWith("!--")) return { end: "comment", interrupts: true };
  if (after.startsWith("?")) return { end: "instruction", interrupts: true };
  if (after.startsWith("![CDATA[")) return { end: "cdata", interrupts: true };
  if (/^![A-Za-z]/.test(after)) return { end: "declaration", interrupts: true };
  const closing = after.startsWith("/");
  const tag = closing ? after.slice(1) : after;
  const name = /^[A-Za-z][A-Za-z0-9-]*/.exec(tag)?.[0];
  if (!name) return null;
  const lower = name.toLowerCase();
  const next = tag.slice(name.length);
  const endsName = next === "" || /^[ \t>]/.test(next);
  if (!closing && endsName && HTML_RAW_NAMES.includes(lower)) {
    return { end: "raw", interrupts: true };
  }
  if ((endsName || next.startsWith("/>")) && HTML_BLOCK_NAMES.has(lower)) {
    return { end: "blank", interrupts: true };
  }
  const whole = closing ? /^[ \t]*>/.exec(next) : OPEN_TAG_TAIL.exec(next);
  if (!whole || next.slice(whole[0].length).trim() !== "") return null;
  return { end: "blank", interrupts: false };
}

/**
 * How many characters of `opener` (a line from its `<`) come before the
 * text an HTML block's end marker is looked for in: `<!-->` and `<?>` end
 * on their first line, as micromark reads them.
 */
function openerLength(end: HtmlEnd, opener: string): number {
  switch (end) {
    case "raw":
      return 1 + (/^[A-Za-z0-9]*/.exec(opener.slice(1))?.[0].length ?? 0);
    case "comment":
    case "declaration":
      return 2;
    case "instruction":
      return 1;
    case "cdata":
      return 9;
    default:
      return 0;
  }
}

/** Whether `line` ends an HTML block that ends by `end`. */
function htmlEnds(end: HtmlEnd, line: string): boolean {
  switch (end) {
    case "raw": {
      const lower = line.toLowerCase();
      return HTML_RAW_NAMES.some((name) => lower.includes(`</${name}>`));
    }
    case "comment":
      return line.includes("-->");
    case "instruction":
      return line.includes("?>");
    case "declaration":
      return line.includes(">");
    case "cdata":
      return line.includes("]]>");
    default:
      return false;
  }
}

/**
 * The rest of `rest` (tabs expanded) past the open container `c`, or null
 * when the line does not go on in it: a blockquote by its `>`, a list item
 * by its content indentation and a footnote definition by four columns (a
 * blank line stays in both).
 */
function continueOne(rest: string, c: Container): string | null {
  if (c.quote) return quoteMarker(rest);
  if (rest.trim() === "") return "";
  const width = c.footnote ? 4 : c.width;
  return spacesBefore(rest) >= width ? rest.slice(width) : null;
}

/**
 * The containers `line` (tabs expanded) sits in and the rest of the line:
 * first those of the open containers `open` (outermost first) it
 * continues, each blockquote by its `>` and each list item by its content
 * indentation (a blank line stays in an item), then the blockquote markers
 * and list markers it opens (`> `, `- `, `1. - `, `- > `). `matched` is
 * how many of `open` it continues, so an item in a blockquote (`> - a`,
 * then `>   b`) holds the lines indented into it, as an item outside one
 * does. When the line would otherwise continue a paragraph held by `held`
 * containers (or indented code, which the renderer treats alike), a list
 * marker that opens no text (`-` alone) or an ordered one that does not
 * start at 1 is text, also past a blockquote or an item the line opens,
 * as the renderer reads it. A thematic break (`- - -`) opens no item. The
 * rule of mdopener-mcp's `markdown_lines::containers`.
 */
function containers(
  line: string,
  open: Container[],
  held: number | null,
): { list: Container[]; matched: number; rest: string; footnote: boolean } {
  const list: Container[] = [];
  let rest = line;
  for (const c of open) {
    const r = continueOne(rest, c);
    if (r === null) break;
    rest = r;
    list.push(c);
  }
  const matched = list.length;
  const interrupt = held === matched;
  let footnote = false;
  for (;;) {
    const q = quoteMarker(rest);
    if (q !== null) {
      list.push({ quote: true });
      rest = q;
      continue;
    }
    // A footnote definition, which may interrupt a paragraph.
    const f = footnoteMarker(rest);
    if (f !== null) {
      list.push({ quote: false, width: 4, footnote: true });
      footnote = true;
      rest = f.rest;
      continue;
    }
    const item = thematicBreak(rest) ? null : listMarker(rest);
    if (!item || (interrupt && (!item.one || item.rest.trim() === ""))) break;
    list.push({ quote: false, width: item.width });
    rest = item.rest;
  }
  return { list, matched, rest, footnote };
}

/**
 * The rest of `line` (tabs expanded) inside the containers `list` of an
 * open fence, or null when the line leaves one of them: a blockquote needs
 * its `>` (a blank line has none), and a list item needs its content
 * indentation unless the line is blank.
 */
function continues(line: string, list: Container[]): string | null {
  let rest: string | null = line;
  for (const c of list) {
    rest = continueOne(rest, c);
    if (rest === null) return null;
  }
  return rest;
}

/** Whether container list `list` starts with the containers `prefix`. */
function startsWith(list: Container[], prefix: Container[]): boolean {
  return (
    prefix.length <= list.length &&
    prefix.every((c, i) => {
      const d = list[i];
      return c.quote
        ? d.quote
        : !d.quote && d.width === c.width && !d.footnote === !c.footnote;
    })
  );
}

/** A source line of a Markdown document, from {@link markdownLines}. */
export interface MarkdownLine {
  /**
   * `frontmatter` for a line of a leading YAML front matter block (its
   * `---` lines included), `fence` for a code fence line, `code` for a line
   * inside fenced code, `indented` for a line of indented code (four
   * columns past its containers, not going on with a paragraph, as
   * mdopener-mcp's `markdown_lines::with_indented_code` marks it), `html`
   * for a line of an HTML block (raw HTML, which the page does not read as
   * Markdown), `text` for any other line. Indented code used to be `text`,
   * so a caller that reads Markdown on text lines read it in that code.
   */
  kind: "frontmatter" | "fence" | "code" | "indented" | "html" | "text";
  /** The line without its `\n` (a `\r` before it is kept). */
  text: string;
  /** 1-based line number within the full document. */
  line: number;
  /** Offset of the line's first character in `markdown`. */
  start: number;
  /**
   * Whether the line sits in a blockquote or a list item: behind its
   * markers (`> `, `- `), or indented into an open item's content column
   * (`- x`, a blank line, then `  # Sub`). A blank line stays in an open
   * item, and in a blockquote only behind its `>`.
   */
  contained: boolean;
  /**
   * The line (tabs expanded, without a `\r`) past the blockquote markers,
   * list markers and item indentation it sits in: `Sub` for `> - Sub`.
   */
  content: string;
  /**
   * On a setext heading's underline (`===` or `---` after a paragraph),
   * the heading's level and the index in the returned lines of its first
   * line; the heading's text is the content of the lines from there to
   * the underline.
   */
  setext?: { depth: 1 | 2; from: number };
  /**
   * Whether a text line is the first content of a list item and not
   * indented code: it opens the item (`- a`, `> - a`, `1. a`), or follows a
   * line that opened one with only its marker, not even a space after it
   * (`-`, then `  a`), in that item or in a list item it is in (`- -`,
   * then `  a`), as remark-gfm reads it. Where a GFM task checkbox can be
   * ({@link taskMarks}). The rule of mdopener-mcp's
   * `markdown_lines::item_starts`.
   */
  first: boolean;
  /**
   * Whether the line goes on with the paragraph of the line before, lazily
   * (`- a`, then `b`) or in its containers.
   */
  continues: boolean;
  /**
   * Set on a line that sits in a GFM footnote definition (`[^n]: x`, and
   * the lines indented four columns after it), which the page shows in its
   * footnotes, after the rest of the document.
   */
  footnote?: true;
}

/**
 * The lines of `markdown`, each marked front matter, fence, fenced code or
 * text by the rules of mdopener-mcp's `markdown_lines`: a leading front
 * matter block is closed by `---` or `...` (its lines are never fences),
 * and a fence is closed only by the same character at least as long with
 * nothing after it; one left open runs to the end.
 *
 * A fence may sit in blockquotes and list items, as in CommonMark: behind
 * `> ` markers, after list markers (`- `, `1. - `, `-` then a tab), in a
 * quote in an item (`- > `), or on an item's continuation line indented to
 * its content column (`- a`, a blank line, then two spaces and a fence),
 * nested items included however deep. The lines after it that stay in
 * those containers (each quote's `>`, each item's content indentation, a
 * blank line staying in an item but ending a quote) are its code until a
 * closing fence in them, and a line that leaves one ends the block. Open
 * list items are tracked across text lines, a less indented line ending
 * them unless it continues a paragraph, inside blockquotes too (`> - a`,
 * then `>   b`), where only the items before the first blockquote used
 * to be. A quoted fence, a list-item fence
 * and then these used to be text, so a `# comment` in their code was
 * listed in the Outline and `- [ ] x` read as a task.
 *
 * An HTML block is `html` in the same containers, up to its end marker
 * (`-->` for a comment) or, for a block tag (`<div>`) or a lone tag
 * (`<u>`, which cannot interrupt a paragraph), a blank line, and a GFM
 * footnote definition (`[^n]: x`) is a container whose content goes on in
 * the lines indented four columns after it, as remark-gfm reads them. Both
 * used to be text, so a `# x` in a `<div>` was listed in the Outline and a
 * task in a footnote was not one.
 */
export function markdownLines(markdown: string): MarkdownLine[] {
  const { lines: body, offset } = stripFrontmatter(markdown);
  const all = markdown.split("\n");
  const out: MarkdownLine[] = [];
  let start = 0;
  for (let i = 0; i < offset; i++) {
    const content = all[i].endsWith("\r") ? all[i].slice(0, -1) : all[i];
    out.push({
      kind: "frontmatter",
      text: all[i],
      line: i + 1,
      start,
      contained: false,
      content,
      first: false,
      continues: false,
    });
    start += all[i].length + 1;
  }
  // The open fence, with the containers its code lines stay in.
  let fence: { marker: string; list: Container[] } | null = null;
  // The open HTML block (how it ends), with the containers it stays in.
  let html: { end: HtmlEnd; list: Container[] } | null = null;
  // The open blockquotes and list items, outermost first: the containers
  // of the last line that was not blank or lazy, less those a blank line
  // or a closing line ended.
  let open: Container[] = [];
  // How many containers hold the paragraph the line before is in, or
  // null after any other line.
  let paragraph: number | null = null;
  // The containers of the paragraph's last line that was not lazy.
  let paraList: Container[] = [];
  // The same for indented code, which a blank line does not end.
  let indented: number | null = null;
  // Whether the innermost open item has only its marker so far.
  let bare = false;
  // Whether that marker has nothing after it, not even a space.
  let tight = false;
  // Whether the line before was in a blockquote or ended a bare item:
  // indented code after it closes a container.
  let closer = false;
  // The index in `out` of the first line of the paragraph.
  let paraStart = 0;
  for (let i = 0; i < body.length; i++) {
    const text = body[i];
    const line = offset + i + 1;
    const raw = text.endsWith("\r") ? text.slice(0, -1) : text;
    const expanded = expandTabs(raw);
    let kind: MarkdownLine["kind"] = "text";
    // A line of an open HTML block: one that stays in its containers and,
    // for a block that ends at a blank line, is not blank.
    let inHtml = html ? continues(expanded, html.list) : null;
    if (html?.end === "blank" && inHtml?.trim() === "") inHtml = null;
    const inside = fence ? continues(expanded, fence.list) : null;
    let lineList: Container[] =
      (html && inHtml !== null ? html.list : fence?.list) ?? [];
    let content = inHtml ?? inside ?? expanded;
    let endsBare = false;
    let setext: MarkdownLine["setext"];
    let first = false;
    let continuesParagraph = false;
    if (html && inHtml !== null) {
      kind = "html";
      if (htmlEnds(html.end, inHtml)) html = null;
    } else if (fence && inside !== null) {
      kind = closesFence(codeFence(inside), fence.marker) ? "fence" : "code";
      if (kind === "fence") fence = null;
    } else {
      fence = null;
      html = null;
      const c = containers(expanded, open, paragraph ?? indented);
      lineList = c.list;
      content = c.rest;
      const f = codeFence(c.rest);
      const empty = c.rest.trim() === "";
      const opened = c.list.length > c.matched;
      if (f) {
        fence = { marker: f.marker, list: c.list };
        open = c.list;
        kind = "fence";
        paragraph = null;
        indented = null;
        bare = false;
      } else if (empty && !opened) {
        // A blank line ends the blockquotes it has no `>` for, and an
        // item that starts with one ends at a second.
        if (bare && c.matched === open.length) open = c.list.slice(0, -1);
        else open = c.list;
        endsBare = bare;
        paragraph = null;
        bare = false;
      } else {
        const heading = atxHeading(c.rest) !== null;
        const block = htmlStart(c.rest);
        // An HTML block of the first six kinds interrupts a paragraph, as a
        // heading does; one of the seventh kind (a lone tag, `<u>`) does not.
        const interrupts = heading || block?.interrupts === true;
        // A paragraph goes on in a line that leaves an item without
        // opening one, or a blockquote (lazy continuation).
        const lazy =
          paragraph !== null && !interrupts && !opened && c.matched < open.length;
        const under =
          paragraph === c.matched && !opened && /^ {0,3}(?:-+|=+) *$/.test(c.rest);
        // Link reference definitions at the paragraph's start are not in a
        // heading it makes, and alone they leave no paragraph to make a
        // heading of, as micromark reads them.
        const paraLines = under ? out.slice(paraStart).map((l) => l.content) : [];
        const defs = under ? definitionsLength(paraLines) : 0;
        const definitions = under && defs === paraLines.length;
        if (under && !definitions) {
          // A setext underline ends the paragraph as a heading.
          setext = {
            depth: c.rest.trim().startsWith("=") ? 1 : 2,
            from: paraStart + defs,
          };
          open = open.slice(0, c.matched);
          paragraph = null;
          indented = null;
          bare = false;
        } else if (thematicBreak(c.rest)) {
          // A thematic break ends the containers it is not in.
          open = c.list;
          paragraph = null;
          indented = null;
          bare = false;
        } else if (definitions) {
          // The underline starts a paragraph after them (`[a]: /u`, then
          // `===`), which a lone tag (`<u>`) or indented code after it does
          // not interrupt.
          open = c.list;
          paraList = c.list;
          paraStart = out.length;
          indented = null;
          bare = false;
        } else if (lazy && block !== null) {
          // A lone tag on a lazy line opens an HTML block in the containers
          // the paragraph is in, as micromark reads it (`> a`, then `<u>`).
          lineList = open;
          kind = "html";
          html = { end: "blank", list: open };
          paragraph = null;
          indented = null;
          bare = false;
        } else if (!lazy) {
          // Indented code that closed a container without opening one, or
          // after a bare item's end, does not hold the next line's markers;
          // one that opens a blockquote (`-`, a blank line, then
          // `>     code`) does.
          const closed = (c.matched < open.length || closer) && !opened;
          // Only a marker with nothing after it, not even a space, has its
          // first content on the next line, at its content column. The
          // renderer reads that line's paragraph as first content also
          // when the line leaves the bare item for an item it is in
          // (`- -`, then `  [ ] t`), but not for a blockquote.
          const lastLeft = c.list[c.list.length - 1];
          const afterBare =
            bare &&
            tight &&
            !opened &&
            lastLeft !== undefined &&
            !lastLeft.quote &&
            !lastLeft.footnote &&
            spacesBefore(c.rest) === 0;
          open = c.list;
          const last = c.list[c.list.length - 1];
          const item = opened && !last.quote && !last.footnote;
          bare = opened && empty && !last.quote && !last.footnote;
          tight = bare && !/[ \t]$/.test(raw);
          const level = c.list.length;
          // Four spaces past the containers is indented code, not text.
          // A paragraph goes on unless the line opens a list item, or a
          // blockquote the paragraph is not in.
          const fresh: boolean =
            paragraph === null ||
            c.list.slice(c.matched).some((x) => !x.quote) ||
            (opened && !startsWith(paraList, c.list));
          if (block !== null && (block.interrupts || fresh)) {
            // An HTML block, which ends at its end marker (on this line
            // too) or, for the last two kinds, at a blank line.
            kind = "html";
            bare = false;
            paragraph = null;
            indented = null;
            const opener = c.rest.replace(/^ +/, "");
            if (!htmlEnds(block.end, opener.slice(openerLength(block.end, opener)))) {
              html = { end: block.end, list: c.list };
            }
          } else {
            const code: boolean = fresh && !empty && spacesBefore(c.rest) >= 4;
            if (code) kind = "indented";
            continuesParagraph = !fresh && !heading && !empty;
            // The first content of an item opened by a bare marker may be
            // on the line after it (`-`, then `  [ ] t`).
            first = !code && !empty && (item || afterBare);
            if (paragraph === null || fresh) paraStart = out.length;
            paragraph = heading || empty || code ? null : level;
            paraList = c.list;
            // Only indented code that closed no container, as the renderer
            // reads it.
            indented = code && !closed ? level : null;
          }
        } else {
          continuesParagraph = true;
        }
      }
    }
    closer = endsBare;
    const contained = lineList.length > 0;
    out.push({
      kind,
      text,
      line,
      start,
      contained,
      content,
      first,
      continues: continuesParagraph,
    });
    if (setext) out[out.length - 1].setext = setext;
    if (lineList.some((c) => !c.quote && c.footnote))
      out[out.length - 1].footnote = true;
    start += text.length + 1;
  }
  return out;
}

/**
 * The list item line `l` opens, by the page's list rule
 * ({@link markdownLines}): whether its marker is ordered (`1.`, `2)`) and
 * its text, or null for any other line. A `- x` or `1. x` line in fenced
 * or indented code, `-x` (no item) and an item's continuation are none;
 * one in a blockquote (`> - x`) is one. The runbook and review renderers
 * read their list items by it; they used to match them on raw lines.
 */
export function listItem(
  l: MarkdownLine | undefined,
): { ordered: boolean; text: string } | null {
  if (!l || l.kind !== "text" || !l.first || l.content.trim() === "") return null;
  const raw = l.text.endsWith("\r") ? l.text.slice(0, -1) : l.text;
  const expanded = expandTabs(raw);
  const prefix = expanded.slice(0, expanded.length - l.content.length);
  // The marker right before the text; a line after a bare marker (`-`,
  // then `  x`) has none and continues the item opened before it.
  const marker = /(?:^|[ >])(?:(\d{1,9})[.)]|[-*+]) *$/.exec(prefix);
  if (!marker) return null;
  return { ordered: marker[1] !== undefined, text: l.content.trim() };
}

/**
 * The ATX headings of `markdown` outside a leading YAML front matter block,
 * fenced code ({@link markdownLines}) and containers, with their source
 * text and 1-based line, empty headings included. A heading in a
 * blockquote or a list item (`> # Quote`, `- # Step`, or `- x`, a blank
 * line, then `  # Sub`) is left out, as the Outline lists none
 * ({@link parseHeadings}). The rule the outline, partial embeds and link
 * previews share with mdopener-mcp's `export_metadata` headings and
 * document titles. A heading on an item's continuation line used to be
 * listed here, so a partial embed could cut at it.
 */
export function atxHeadings(markdown: string): (AtxHeading & { line: number })[] {
  const out: (AtxHeading & { line: number })[] = [];
  for (const l of markdownLines(markdown)) {
    if (l.kind !== "text" || l.contained) continue;
    const h = atxHeading(l.text);
    if (h) out.push({ ...h, line: l.line });
  }
  return out;
}

/**
 * Parse ATX headings (`#` to `######`) into an ordered outline.
 *
 * - Headings are read by the rule of {@link atxHeadings}: a leading YAML
 *   frontmatter block and fenced code are skipped, and a heading has at most three
 *   spaces before its `#`s, as the renderer and mdopener-mcp read it. A
 *   tab-indented `# x` (indented code) used to be listed, and `## ##` was
 *   listed as `#`.
 * - A heading inside a blockquote (`> # Quote`) is not listed, as in
 *   Obsidian's outline and mdopener-mcp's `export_metadata` headings: quoted
 *   text from elsewhere would clutter the outline. The renderer still gives
 *   it a slug id, so it takes its slug here too, and a later `# Quote` is
 *   `quote-1` as in the DOM. It used to take none, so that later heading's
 *   entry jumped into the quote.
 * - A heading in a list item (`- # Step`) is not listed either, as
 *   mdopener-mcp's `export_metadata` headings leave it out, but the
 *   renderer gives it an id, so it takes its slug the same way. It used to
 *   take none, so a later `# Step` was `step` here and `step-1` in the page.
 * - A heading indented four or more columns as a list item's continuation
 *   (`1. x`, a blank line, then `    # Sub`) is a heading in the item when
 *   it is at most three columns past the item's content column, and the
 *   renderer gives it an id, so it takes its slug the same way without
 *   being listed. It used to take none (it was read as indented code), so
 *   a later `# Sub` was `sub` here and `sub-1` in the page. One indented
 *   zero to three columns past the item's content column (`- x`, a blank
 *   line, then `  # Sub`, or `-` then `  # Sub`) is in the item too, so it
 *   is not listed either. It used to be listed.
 * - Blockquotes and list items are read by the container rule of
 *   {@link markdownLines}, the one its fences follow, and a heading is read
 *   past the markers and item indentation of its line. An ad hoc rule used
 *   to read `2. z` after a paragraph (which cannot interrupt it), or a bare
 *   `-` before an unindented line, as an item holding the `   # Sub` after
 *   it, so that heading was left out of the outline.
 * - Slugs are generated with github-slugger (same as the renderer), so repeated
 *   heading text dedupes to `-1`, `-2`, … exactly as the rendered ids do.
 *
 * - A setext heading (a paragraph underlined with `===` or `---`) is not
 *   listed, as mdopener-mcp's `export_metadata` headings list only ATX
 *   headings, but the renderer gives it an id, so it takes its slug the
 *   same way. It used to take none, so in `Title`, `=====`, then
 *   `# Title`, the ATX heading was `title` here and `title-1` in the page.
 *   Its underline is read by the container rule of {@link markdownLines}:
 *   `---` after a paragraph is an underline, not a thematic break, and a
 *   leading front matter block is never one.
 */
export function parseHeadings(markdown: string): HeadingItem[] {
  const slugger = new GithubSlugger();
  const out: HeadingItem[] = [];
  // Quoted fences are fences ({@link markdownLines}), so quoted code is
  // skipped here with the rest of the code. A heading is read inside the
  // containers its line sits in, by the container rule of markdownLines.
  const lines = markdownLines(markdown);
  lines.forEach((l, i) => {
    // A heading in a footnote definition is in the page's footnotes, after
    // every other heading, so its slug cannot change theirs.
    if (l.kind !== "text" || l.footnote) return;
    if (l.setext) {
      // A setext heading takes its slug from its lines, joined by line
      // breaks as the renderer's heading text is, but is not listed.
      const text = lines
        .slice(l.setext.from, i)
        .map((p) => stripInline(p.content))
        .join("\n");
      if (text.replace(/\n/g, "") !== "") slugger.slug(text);
      return;
    }
    const h = atxHeading(l.content);
    const text = h ? stripInline(h.text) : "";
    if (!h || text === "") return; // empty heading -> no anchor rendered
    const slug = slugger.slug(text);
    // In a blockquote or a list item, it takes its slug but is not listed.
    if (l.contained) return;
    out.push({ depth: h.depth, text, slug, line: l.line });
  });
  return out;
}
