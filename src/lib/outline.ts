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
 * Strip a leading YAML frontmatter block (`---` … `---`), if present.
 * Returns the body plus the number of lines removed, so reported line numbers
 * stay accurate against the original document.
 */
function stripFrontmatter(markdown: string): { lines: string[]; offset: number } {
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== "---") return { lines, offset: 0 };
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    // Frontmatter ends on a line that is exactly `---` or `...`.
    if (t === "---" || t === "...") {
      return { lines: lines.slice(i + 1), offset: i + 1 };
    }
  }
  // No closing fence — treat the whole thing as body (don't swallow content).
  return { lines, offset: 0 };
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
 * tildes, and a backtick fence's info string has no backtick. The rule of
 * mdopener-mcp's `markdown_lines`.
 */
function codeFence(line: string): { marker: string; rest: string } | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  if (m[1][0] === "`" && m[2].includes("`")) return null;
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
 * many columns its content is past the container before it.
 */
type Container = { quote: true } | { quote: false; width: number };

/**
 * The containers `line` (tabs expanded) sits in and the rest of the line:
 * first the open list items `items` (their widths, outermost first) it is
 * indented into, then the blockquote markers and list markers it opens
 * (`> `, `- `, `1. - `, `- > `). `matched` is how many of `items` it
 * continues. When the line would otherwise continue a paragraph held by
 * `held` of the items (or indented code, which the renderer treats alike),
 * a list marker that opens no text (`-` alone) or an ordered one that does
 * not start at 1 is text, as in CommonMark, until a blockquote opens. A
 * thematic break (`- - -`) opens no item. The rule of mdopener-mcp's `markdown_lines::containers`.
 */
function containers(
  line: string,
  items: number[],
  held: number | null,
): { list: Container[]; matched: number; rest: string } {
  const list: Container[] = [];
  let rest = line;
  for (const width of items) {
    if (spacesBefore(rest) < width) break;
    rest = rest.slice(width);
    list.push({ quote: false, width });
  }
  const matched = list.length;
  let interrupt = held === matched;
  for (;;) {
    const q = quoteMarker(rest);
    if (q !== null) {
      list.push({ quote: true });
      rest = q;
      interrupt = false;
      continue;
    }
    const item = thematicBreak(rest) ? null : listMarker(rest);
    if (!item || (interrupt && (!item.one || item.rest.trim() === ""))) break;
    list.push({ quote: false, width: item.width });
    rest = item.rest;
  }
  return { list, matched, rest };
}

/**
 * The rest of `line` (tabs expanded) inside the containers `list` of an
 * open fence, or null when the line leaves one of them: a blockquote needs
 * its `>` (a blank line has none), and a list item needs its content
 * indentation unless the line is blank.
 */
function continues(line: string, list: Container[]): string | null {
  let rest = line;
  for (const c of list) {
    if (c.quote) {
      const q = quoteMarker(rest);
      if (q === null) return null;
      rest = q;
    } else if (rest.trim() === "") {
      rest = "";
    } else if (spacesBefore(rest) >= c.width) {
      rest = rest.slice(c.width);
    } else {
      return null;
    }
  }
  return rest;
}

/** The widths of the list items that open `list`, before any blockquote. */
function leadingItems(list: Container[]): number[] {
  const out: number[] = [];
  for (const c of list) {
    if (c.quote) break;
    out.push(c.width);
  }
  return out;
}

/** A source line of a Markdown document, from {@link markdownLines}. */
export interface MarkdownLine {
  /**
   * `frontmatter` for a line of a leading YAML front matter block (its
   * `---` lines included), `fence` for a code fence line, `code` for a line
   * inside fenced code, `text` for any other line.
   */
  kind: "frontmatter" | "fence" | "code" | "text";
  /** The line without its `\n` (a `\r` before it is kept). */
  text: string;
  /** 1-based line number within the full document. */
  line: number;
  /** Offset of the line's first character in `markdown`. */
  start: number;
  /**
   * Whether the line sits in a blockquote or a list item: behind its
   * markers (`> `, `- `), or indented into an open item's content column
   * (`- x`, a blank line, then `  # Sub`).
   */
  contained: boolean;
  /**
   * The line (tabs expanded, without a `\r`) past the blockquote markers,
   * list markers and item indentation it sits in: `Sub` for `> - Sub`.
   */
  content: string;
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
 * them unless it continues a paragraph. A quoted fence, a list-item fence
 * and then these used to be text, so a `# comment` in their code was
 * listed in the Outline and `- [ ] x` read as a task.
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
    });
    start += all[i].length + 1;
  }
  // The open fence, with the containers its code lines stay in.
  let fence: { marker: string; list: Container[] } | null = null;
  // The widths of the open list items, outermost first.
  let items: number[] = [];
  // How many open items hold the paragraph the line before is in (-1 for
  // one in a blockquote), or null after any other line.
  let paragraph: number | null = null;
  // The same for indented code, which a blank line does not end.
  let indented: number | null = null;
  // Whether the innermost open item has only its marker so far.
  let bare = false;
  // Whether the line before was in a blockquote or ended a bare item:
  // indented code after it closes a container.
  let closer = false;
  for (let i = 0; i < body.length; i++) {
    const text = body[i];
    const line = offset + i + 1;
    const expanded = expandTabs(text.endsWith("\r") ? text.slice(0, -1) : text);
    let kind: MarkdownLine["kind"] = "text";
    const inside = fence ? continues(expanded, fence.list) : null;
    let lineList: Container[] = fence?.list ?? [];
    let content = inside ?? expanded;
    let endsBare = false;
    if (fence && inside !== null) {
      kind = closesFence(codeFence(inside), fence.marker) ? "fence" : "code";
      if (kind === "fence") fence = null;
    } else {
      fence = null;
      const c = containers(expanded, items, paragraph ?? indented);
      lineList = c.list;
      content = c.rest;
      const f = codeFence(c.rest);
      const empty = c.rest.trim() === "";
      const opened = c.list.length > c.matched;
      if (f) {
        fence = { marker: f.marker, list: c.list };
        items = leadingItems(c.list);
        kind = "fence";
        paragraph = null;
        indented = null;
        bare = false;
      } else if (empty && !opened) {
        // A blank line. An item that starts with one ends at a second.
        if (bare) items = items.slice(0, -1);
        endsBare = bare;
        paragraph = null;
        bare = false;
      } else {
        const heading = atxHeading(c.rest) !== null;
        // A paragraph goes on in a line that leaves an item without
        // opening one, or a blockquote (lazy continuation).
        const lazy =
          paragraph !== null &&
          !heading &&
          !opened &&
          (c.matched < items.length || paragraph === -1);
        if (paragraph === c.matched && !opened && /^ {0,3}(?:-+|=+) *$/.test(c.rest)) {
          // A setext underline ends the paragraph as a heading.
          items = items.slice(0, c.matched);
          paragraph = null;
          indented = null;
          bare = false;
        } else if (thematicBreak(c.rest)) {
          // A thematic break ends the items it is not indented into.
          items = leadingItems(c.list);
          paragraph = null;
          indented = null;
          bare = false;
        } else if (!lazy) {
          const closed = c.matched < items.length || closer;
          items = leadingItems(c.list);
          const last = c.list[c.list.length - 1];
          bare = opened && empty && !last.quote;
          const level = c.list.some((x) => x.quote) ? -1 : items.length;
          // Four spaces past the containers is indented code, not text.
          const code: boolean =
            (opened || paragraph === null) && !empty && spacesBefore(c.rest) >= 4;
          paragraph = heading || empty || code ? null : level;
          // Only indented code that closed no container, as the renderer
          // reads it.
          indented = code && !closed ? level : null;
        }
      }
    }
    closer = endsBare || lineList.some((x) => x.quote);
    const contained = lineList.length > 0;
    out.push({ kind, text, line, start, contained, content });
    start += text.length + 1;
  }
  return out;
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
 * Note: only ATX headings are collected. Setext headings (underlined with
 * `===`/`---`) are intentionally out of scope: agent-generated docs use ATX,
 * and `---` is ambiguous with thematic breaks / frontmatter.
 */
export function parseHeadings(markdown: string): HeadingItem[] {
  const slugger = new GithubSlugger();
  const out: HeadingItem[] = [];
  // Quoted fences are fences ({@link markdownLines}), so quoted code is
  // skipped here with the rest of the code. A heading is read inside the
  // containers its line sits in, by the container rule of markdownLines.
  for (const l of markdownLines(markdown)) {
    if (l.kind !== "text") continue;
    const h = atxHeading(l.content);
    const text = h ? stripInline(h.text) : "";
    if (!h || text === "") continue; // empty heading -> no anchor rendered
    const slug = slugger.slug(text);
    // In a blockquote or a list item, it takes its slug but is not listed.
    if (l.contained) continue;
    out.push({ depth: h.depth, text, slug, line: l.line });
  }
  return out;
}
