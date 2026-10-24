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
 * `line` without up to `max` leading blockquote markers (at most three
 * spaces, `>`, then one optional space or tab), and how many it lost. The
 * rule of mdopener-mcp's `markdown_lines::strip_quote_markers`.
 */
function stripQuoteMarkers(
  line: string,
  max: number,
): { markers: number; rest: string } {
  const marker = /^ {0,3}>[ \t]?/;
  let rest = line;
  let markers = 0;
  while (markers < max) {
    const m = marker.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
    markers++;
  }
  return { markers, rest };
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
}

/**
 * The lines of `markdown`, each marked front matter, fence, fenced code or
 * text by the rules of mdopener-mcp's `markdown_lines`: a leading front
 * matter block is closed by `---` or `...` (its lines are never fences),
 * and a fence is closed only by the same character at least as long with
 * nothing after it; one left open runs to the end. A fence inside a
 * blockquote (`> ` then a fence) is a fence too: the lines after it with at
 * least as many `>` markers are its code until a closing fence behind
 * those markers, and a line with fewer (a blank line included) ends the
 * quote and so the block, as in CommonMark. A quoted fence used to be
 * text, so a `[[link]]` in quoted code was linted as a link.
 */
export function markdownLines(markdown: string): MarkdownLine[] {
  const { lines: body, offset } = stripFrontmatter(markdown);
  const all = markdown.split("\n");
  const out: MarkdownLine[] = [];
  let start = 0;
  for (let i = 0; i < offset; i++) {
    out.push({ kind: "frontmatter", text: all[i], line: i + 1, start });
    start += all[i].length + 1;
  }
  let fence: string | null = null; // active fence marker, e.g. "```" or "~~~~"
  // The fence open inside a blockquote, with its number of `>` markers.
  let quoteFence: { marker: string; depth: number } | null = null;
  for (let i = 0; i < body.length; i++) {
    const text = body[i];
    const line = offset + i + 1;
    if (quoteFence) {
      const q = stripQuoteMarkers(text, quoteFence.depth);
      if (q.markers === quoteFence.depth) {
        const f = codeFence(q.rest);
        let kind: MarkdownLine["kind"] = "code";
        if (closesFence(f, quoteFence.marker)) {
          quoteFence = null;
          kind = "fence";
        }
        out.push({ kind, text, line, start });
        start += text.length + 1;
        continue;
      }
      quoteFence = null;
    }
    const f = codeFence(text);
    let kind: MarkdownLine["kind"] = "text";
    if (fence) {
      kind = "code";
      if (closesFence(f, fence)) {
        fence = null;
        kind = "fence";
      }
    } else if (f) {
      fence = f.marker;
      kind = "fence";
    } else {
      const q = stripQuoteMarkers(text, Number.POSITIVE_INFINITY);
      const qf = q.markers > 0 ? codeFence(q.rest) : null;
      if (qf) {
        quoteFence = { marker: qf.marker, depth: q.markers };
        kind = "fence";
      }
    }
    out.push({ kind, text, line, start });
    start += text.length + 1;
  }
  return out;
}

/**
 * The ATX headings of `markdown` outside a leading YAML front matter block
 * and fenced code ({@link markdownLines}), with their source text and
 * 1-based line, empty headings included. The rule the outline, partial
 * embeds and link previews share with mdopener-mcp's `export_metadata`
 * headings.
 */
export function atxHeadings(markdown: string): (AtxHeading & { line: number })[] {
  const out: (AtxHeading & { line: number })[] = [];
  for (const l of markdownLines(markdown)) {
    if (l.kind !== "text") continue;
    const h = atxHeading(l.text);
    if (h) out.push({ ...h, line: l.line });
  }
  return out;
}

/**
 * The text inside the blockquote markers of `line` (`> `, `>> `, `> > `),
 * or null when `line` is not in a blockquote.
 */
function quoteContent(line: string): string | null {
  const marker = /^ {0,3}>[ \t]?/;
  let rest = line.endsWith("\r") ? line.slice(0, -1) : line;
  let m = marker.exec(rest);
  if (!m) return null;
  while (m) {
    rest = rest.slice(m[0].length);
    m = marker.exec(rest);
  }
  return rest;
}

/**
 * Parse ATX headings (`#` to `######`) into an ordered outline.
 *
 * - Headings are read by {@link atxHeadings}: a leading YAML frontmatter
 *   block and fenced code are skipped, and a heading has at most three
 *   spaces before its `#`s, as the renderer and mdopener-mcp read it. A
 *   tab-indented `# x` (indented code) used to be listed, and `## ##` was
 *   listed as `#`.
 * - A heading inside a blockquote (`> # Quote`) is not listed, as in
 *   Obsidian's outline and mdopener-mcp's `export_metadata` headings: quoted
 *   text from elsewhere would clutter the outline. The renderer still gives
 *   it a slug id, so it takes its slug here too, and a later `# Quote` is
 *   `quote-1` as in the DOM. It used to take none, so that later heading's
 *   entry jumped into the quote.
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
  // skipped here with the rest of the code.
  for (const l of markdownLines(markdown)) {
    if (l.kind !== "text") continue;
    const h = atxHeading(l.text);
    if (h) {
      const text = stripInline(h.text);
      if (text === "") continue; // empty heading -> no anchor rendered
      out.push({ depth: h.depth, text, slug: slugger.slug(text), line: l.line });
      continue;
    }
    const quoted = quoteContent(l.text);
    if (quoted === null) continue;
    const qh = atxHeading(quoted);
    const text = qh ? stripInline(qh.text) : "";
    if (text !== "") slugger.slug(text);
  }
  return out;
}
