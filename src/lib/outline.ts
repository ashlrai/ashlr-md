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

import { decodeNamedCharacterReference } from "decode-named-character-reference";
import GithubSlugger from "github-slugger";
import katex from "katex";
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
 * The text the page shows for inline math `value`: the read view renders
 * it with KaTeX (rehype-katex, default options) and takes a heading's slug
 * from the text of the result, which holds the formula three times (its
 * MathML, its TeX source and its HTML), so `$E=mc^2$` reads `E=mc2`,
 * `E=mc^2` and `E=mc2`. A formula KaTeX refuses is rendered again as
 * rehype-katex does, without strict checks and as an error, and one that
 * fails that too reads as written.
 */
function mathText(value: string): string {
  let html: string;
  try {
    html = katex.renderToString(value, { displayMode: false, throwOnError: true });
  } catch {
    try {
      html = katex.renderToString(value, {
        displayMode: false,
        strict: "ignore",
        throwOnError: false,
      });
    } catch {
      return value;
    }
  }
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => {
      const k = e.toLowerCase();
      if (k.startsWith("#x"))
        return String.fromCodePoint(Number.parseInt(k.slice(2), 16));
      if (k.startsWith("#"))
        return String.fromCodePoint(Number.parseInt(k.slice(1), 10));
      return (
        { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" }[k] ?? ""
      );
    });
}

/**
 * Reduce inline markdown to its plain rendered text so slugs/labels match the
 * DOM: the text of the heading's mdast tree, as remark-parse with remark-gfm
 * and remark-math reads it ({@link inlineNodes}), after the read view's
 * Obsidian plugins (`%%comments%%` dropped, `==highlights==` unwrapped,
 * `[[wikilinks]]` read as their label, `![[embeds]]` dropped).
 *
 * With `slug`, the text rehype-slug takes the page's id from: whitespace as
 * written (`# a  b` is `a--b` on the page; it was collapsed to `a-b` here),
 * a line break between lines, nothing for an image or raw HTML, and the text
 * KaTeX renders for inline math ({@link mathText}). Without it, the label
 * the Outline lists: whitespace collapsed, an image read as its alt text and
 * math as its TeX source.
 *
 * Emphasis, strong and GFM strikethrough are matched by micromark's
 * delimiter rules (flanking, the rule of three, `_` inside words), links
 * and images by its bracket rules, with `defs` the document's link
 * reference definition labels ({@link normalizeLabel}), and backslash
 * escapes and character references are decoded. Ad hoc patterns used to
 * read `a*b*c` and `x_y_z` alike, kept every `&amp;` and `\*` as written,
 * and kept raw HTML tags (`<b>`) in the text, so slugs differed from the
 * page's. Fuzzed against the read view's pipeline.
 */
function stripInline(
  text: string,
  slug = false,
  defs: ReadonlySet<string> = new Set(),
): string {
  // A paragraph's lines lose the whitespace around their line breaks
  // (but in a code span or math, which keep it), and a heading's text the
  // whitespace at its ends, as micromark reads them.
  const norm = text.replace(/\r\n?/g, "\n");
  const lineEnds = (t: string) => t.replace(/[ \t]*\n[ \t]*/g, "\n");
  let source = "";
  let at = 0;
  for (const span of inlineSpans(norm)) {
    source += lineEnds(norm.slice(at, span.start)) + norm.slice(span.start, span.end);
    at = span.end;
  }
  source = (source + lineEnds(norm.slice(at))).replace(/^[ \t]+|[ \t]+$/g, "");
  const out = flattenInline(inlineNodes(source, defs), slug);
  return slug ? out : out.replace(/\s+/g, " ").trim();
}

/** A run of an mdast text node's characters, or a node read as one piece. */
type InlineNode =
  | { t: "text"; v: string }
  /** A non-text node: what the page's text holds for it, and the label's. */
  | { t: "atom"; slug: string; label: string }
  /** An unmatched-yet `*`, `_` or `~` run, with micromark's open and close. */
  | {
      t: "delim";
      ch: string;
      n: number;
      open: boolean;
      close: boolean;
    }
  /** `[` or `![`, which a `]` may close into a link or an image. */
  | { t: "bracket"; image: boolean; inactive: boolean; balanced: boolean; at: number }
  | { t: "group"; kind: "emphasis" | "link" | "image"; children: InlineNode[] };

/** micromark's character class: 1 whitespace, 2 punctuation, 0 other. */
function charClass(ch: string | undefined): 0 | 1 | 2 {
  if (ch === undefined || /\s/u.test(ch)) return 1;
  return /\p{P}|\p{S}/u.test(ch) ? 2 : 0;
}

/** The code point of `text` that ends at `i` (exclusive), or undefined. */
function charBefore(text: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const lo = text.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = text.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return text.slice(i - 2, i);
  }
  return text[i - 1];
}

/** The code point of `text` that starts at `i`, or undefined. */
function charAt(text: string, i: number): string | undefined {
  const c = text.codePointAt(i);
  return c === undefined ? undefined : String.fromCodePoint(c);
}

/**
 * A link label as micromark compares them: whitespace runs as one space,
 * trimmed, case folded.
 */
function normalizeLabel(label: string): string {
  return label
    .replace(/[\t\n\r ]+/g, " ")
    .replace(/^ | $/g, "")
    .toLowerCase()
    .toUpperCase();
}

/** The text of a numeric character reference, as micromark decodes it. */
function numericReference(code: number): string {
  if (
    code < 9 ||
    code === 11 ||
    (code > 13 && code < 32) ||
    (code > 126 && code < 160) ||
    (code > 55295 && code < 57344) ||
    (code > 64975 && code < 65008) ||
    (code & 65535) === 65535 ||
    (code & 65535) === 65534 ||
    code > 1114111
  ) {
    return "�";
  }
  return String.fromCodePoint(code);
}

/**
 * The offset past the reference label (`[ref]`: 1 to 999 characters, some
 * not whitespace, no unescaped bracket) that starts at `start`, or null.
 */
function referenceLabelEnd(text: string, start: number): number | null {
  if (text[start] !== "[") return null;
  let seen = false;
  let i = start + 1;
  while (i < text.length && i - start <= 1000) {
    const c = text[i];
    if (c === "[") return null;
    if (c === "]") return seen ? i + 1 : null;
    if (c === "\\" && /[[\\\]]/.test(text[i + 1] ?? "")) i++;
    if (!/[\t\n ]/.test(c)) seen = true;
    i++;
  }
  return null;
}

/**
 * Pair the `*`, `_` and `~` runs of `nodes` into emphasis and
 * strikethrough groups by micromark's resolvers, in `order` (`"*"` for
 * emphasis and strong, `"~"` for strikethrough), and read the runs left
 * over as text.
 */
function resolveDelims(nodes: InlineNode[], order: string[]): InlineNode[] {
  let list = nodes;
  for (const kind of order)
    list = kind === "~" ? resolveTilde(list) : resolveAttention(list);
  return list.map((n) =>
    n.t === "delim" && n.n > 0 ? { t: "text", v: n.ch.repeat(n.n) } : n,
  );
}

/** The pieces between two pairs, resolved inside as a span is. */
function inside(nodes: InlineNode[]): InlineNode[] {
  return resolveDelims(nodes, ["~", "*"]);
}

/** micromark's `resolveAllAttention` over `nodes`. */
function resolveAttention(nodes: InlineNode[]): InlineNode[] {
  const list = [...nodes];
  let index = 0;
  while (index < list.length) {
    const closer = list[index];
    if (closer.t !== "delim" || closer.ch === "~" || !closer.close || closer.n === 0) {
      index++;
      continue;
    }
    let matched = false;
    for (let open = index - 1; open >= 0; open--) {
      const opener = list[open];
      if (
        opener.t !== "delim" ||
        opener.ch !== closer.ch ||
        !opener.open ||
        opener.n === 0
      )
        continue;
      if (
        (opener.close || closer.open) &&
        closer.n % 3 !== 0 &&
        (opener.n + closer.n) % 3 === 0
      )
        continue;
      const use = opener.n > 1 && closer.n > 1 ? 2 : 1;
      const group: InlineNode = {
        t: "group",
        kind: "emphasis",
        children: inside(list.slice(open + 1, index)),
      };
      const before = { ...opener, n: opener.n - use };
      const after = { ...closer, n: closer.n - use };
      const next: InlineNode[] = [];
      if (before.n > 0) next.push(before);
      next.push(group);
      if (after.n > 0) next.push(after);
      list.splice(open, index - open + 1, ...next);
      // Go on at the closer's markers left over, if any.
      index = open + next.length - (after.n > 0 ? 1 : 0);
      matched = true;
      break;
    }
    if (!matched) index++;
  }
  return list;
}

/** micromark-extension-gfm-strikethrough's resolver over `nodes`. */
function resolveTilde(nodes: InlineNode[]): InlineNode[] {
  const list = [...nodes];
  let index = 0;
  while (index < list.length) {
    const closer = list[index];
    if (closer.t !== "delim" || closer.ch !== "~" || !closer.close) {
      index++;
      continue;
    }
    let matched = false;
    for (let open = index - 1; open >= 0; open--) {
      const opener = list[open];
      if (
        opener.t !== "delim" ||
        opener.ch !== "~" ||
        !opener.open ||
        opener.n !== closer.n
      )
        continue;
      const group: InlineNode = {
        t: "group",
        kind: "emphasis",
        children: inside(list.slice(open + 1, index)),
      };
      list.splice(open, index - open + 1, group);
      index = open + 1;
      matched = true;
      break;
    }
    if (!matched) index++;
  }
  return list;
}

/**
 * The inline nodes of `text` (one block's inline content), as micromark
 * reads it with GFM and math: code spans and math ({@link inlineSpans}),
 * autolinks, raw HTML, escapes, character references, links and images
 * (`defs` holds the defined reference labels) and emphasis, strong and
 * strikethrough, read by micromark's tokenizers and resolvers.
 */
function inlineNodes(text: string, defs: ReadonlySet<string>): InlineNode[] {
  const spans = new Map(inlineSpans(text).map((s) => [s.start, s]));
  const list: InlineNode[] = [];
  // The resolvers in the order their first run was read, as micromark
  // runs them on the whole text.
  const order: string[] = [];
  const text1 = (v: string) => list.push({ t: "text", v });
  let i = 0;
  while (i < text.length) {
    const span = spans.get(i);
    if (span) {
      const code = span.value.replace(/\n/g, " ");
      list.push(
        span.kind === "code"
          ? { t: "atom", slug: code, label: code }
          : { t: "atom", slug: mathText(span.value), label: span.value },
      );
      i = span.end;
      continue;
    }
    const c = text[i];
    if (c === "\\") {
      const next = text[i + 1];
      if (next === "\n") {
        list.push({ t: "atom", slug: "\n", label: "\n" });
        i += 2;
      } else if (next !== undefined && /[!-/:-@[-`{-~]/.test(next)) {
        text1(next);
        i += 2;
      } else {
        text1(c);
        i++;
      }
      continue;
    }
    if (c === "&") {
      const m =
        /^&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|([A-Za-z][A-Za-z0-9]{0,31}));/.exec(
          text.slice(i, i + 40),
        );
      const value = !m
        ? false
        : m[1] !== undefined
          ? numericReference(Number.parseInt(m[1], 16))
          : m[2] !== undefined
            ? numericReference(Number.parseInt(m[2], 10))
            : decodeNamedCharacterReference(m[3]);
      if (m && value !== false) {
        text1(value);
        i += m[0].length;
      } else {
        text1(c);
        i++;
      }
      continue;
    }
    if (c === "<") {
      const auto = autolinkEnd(text, i);
      if (auto !== null) {
        const inner = text.slice(i + 1, auto - 1);
        list.push({ t: "group", kind: "link", children: [{ t: "text", v: inner }] });
        i = auto;
        continue;
      }
      const html = inlineHtmlEnd(text, i);
      if (html !== null) {
        list.push({ t: "atom", slug: "", label: "" });
        i = html;
        continue;
      }
      text1(c);
      i++;
      continue;
    }
    // A GFM literal autolink is a link, out of an open link text: no `_`
    // or `*` in it is emphasis.
    if (/[wWhH]/.test(c) && !list.some((n) => n.t === "bracket" && !n.balanced)) {
      const end = literalAutolinkEnd(text, i);
      if (end !== null) {
        list.push({
          t: "group",
          kind: "link",
          children: [{ t: "text", v: text.slice(i, end) }],
        });
        i = end;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      let n = 0;
      while (text[i + n] === c) n++;
      const before = charClass(charBefore(text, i));
      const afterCh = charAt(text, i + n);
      const after = charClass(afterCh);
      if (c === "~") {
        if (n > 2) {
          text1(c.repeat(n));
        } else {
          if (!order.includes("~")) order.push("~");
          list.push({
            t: "delim",
            ch: c,
            n,
            open: !after || (after === 2 && before !== 0),
            close: !before || (before === 2 && after !== 0),
          });
        }
      } else {
        if (!order.includes("*")) order.push("*");
        const prevCh = charBefore(text, i);
        const marker = (ch: string | undefined) =>
          ch === "*" || ch === "_" || ch === "~";
        const open = !after || (after === 2 && before !== 0) || marker(afterCh);
        const close = !before || (before === 2 && after !== 0) || marker(prevCh);
        list.push({
          t: "delim",
          ch: c,
          n,
          open: c === "*" ? open : open && (before !== 0 || !close),
          close: c === "*" ? close : close && (after !== 0 || !open),
        });
      }
      i += n;
      continue;
    }
    if (c === "[" || (c === "!" && text[i + 1] === "[")) {
      const image = c === "!";
      list.push({
        t: "bracket",
        image,
        inactive: false,
        balanced: false,
        at: i + (image ? 2 : 1),
      });
      i += image ? 2 : 1;
      continue;
    }
    if (c === "]") {
      let open = -1;
      for (let k = list.length - 1; k >= 0; k--) {
        const n = list[k];
        if (n.t === "bracket" && !n.balanced) {
          open = k;
          break;
        }
      }
      const start =
        open < 0 ? null : (list[open] as Extract<InlineNode, { t: "bracket" }>);
      let end: number | null = null;
      if (start && !start.inactive) {
        const defined = defs.has(normalizeLabel(text.slice(start.at, i)));
        const after = i + 1;
        if (text[after] === "(") {
          end = inlineLinkEnd(text, after) ?? (defined ? after : null);
        } else if (text[after] === "[") {
          const full = referenceLabelEnd(text, after);
          if (
            full !== null &&
            defs.has(normalizeLabel(text.slice(after + 1, full - 1)))
          )
            end = full;
          else if (defined && text[after + 1] === "]") end = after + 2;
        } else if (defined) {
          end = after;
        }
      }
      if (start === null || end === null) {
        if (start) start.balanced = true;
        text1(c);
        i++;
        continue;
      }
      const children = inside(list.slice(open + 1));
      list.splice(open, list.length - open, {
        t: "group",
        kind: start.image ? "image" : "link",
        children,
      });
      // A link holds no link: the brackets before it no longer open one.
      if (!start.image)
        for (const n of list) if (n.t === "bracket" && !n.image) n.inactive = true;
      i = end;
      continue;
    }
    text1(c);
    i++;
  }
  return resolveDelims(list, order).map((n) =>
    n.t === "bracket" ? { t: "text", v: n.image ? "![" : "[" } : n,
  );
}

/**
 * The text of `nodes`: the page's (`slug`) or the Outline label's, after
 * the read view's remark plugins, which rewrite each mdast text node
 * (comments, then highlights, then wikilinks outside a link's own text).
 */
function flattenInline(nodes: InlineNode[], slug: boolean): string {
  // The text nodes, each with whether it is a link's own text, and the
  // pieces between them.
  const parts: ({ text: string; link: boolean } | string)[] = [];
  const walk = (list: InlineNode[], link: boolean) => {
    for (const n of list) {
      if (n.t === "text") {
        const last = parts[parts.length - 1];
        if (typeof last === "object" && last.link === link) last.text += n.v;
        else parts.push({ text: n.v, link });
      } else if (n.t === "atom") {
        parts.push(slug ? n.slug : n.label);
      } else if (n.t === "group") {
        if (n.kind === "image") {
          parts.push(slug ? "" : flattenInline(n.children, false));
        } else {
          parts.push("");
          walk(n.children, n.kind === "link");
          parts.push("");
        }
      }
    }
  };
  walk(nodes, false);
  let out = "";
  for (const p of parts) {
    if (typeof p === "string") out += p;
    else out += textPlugins(p.text, p.link);
  }
  return out;
}

/** One mdast text node through remark-comments, -highlights and -wikilinks. */
function textPlugins(value: string, inLink: boolean): string {
  const nodes = value.split(/%%(?:(?!%%)[\s\S])+%%/);
  const out: string[] = [];
  for (const node of nodes) {
    // Highlights make the inner text a node of its own.
    const pieces: string[] = [];
    let last = 0;
    for (const m of node.matchAll(/==(?:(?!==)[\s\S])+?==/g)) {
      const inner = m[0].slice(2, -2);
      pieces.push(node.slice(last, m.index), inner.trim() === "" ? m[0] : inner);
      last = m.index + m[0].length;
    }
    pieces.push(node.slice(last));
    for (const piece of pieces) {
      out.push(
        inLink
          ? piece
          : piece.replace(
              /(!)?\[\[([^\]|#\r\n]+)(?:#([^\]|\r\n]+))?(?:\|([^\]\r\n]+))?\]\]/g,
              (_, bang, target, heading, alias) =>
                bang ? "" : (alias ?? (heading ? `${target} › ${heading}` : target)),
            ),
      );
    }
  }
  return out.join("");
}

/** A code span or inline math in a block's inline text ({@link inlineSpans}). */
export interface InlineSpan {
  kind: "code" | "math";
  /** Offset of its opening run. */
  start: number;
  /** Offset past its closing run. */
  end: number;
  /**
   * Its content, one space or line break taken off each side when both
   * sides have one and it is not all spaces, as micromark reads it.
   */
  value: string;
}

/**
 * The code spans (`` `a` ``, ` `` a`b `` `) and, with `math`, the inline
 * math (`$x$`, `$$x$$`) of `text`, one block's inline content (a
 * paragraph's lines joined by line breaks, or a heading's text), as
 * micromark reads them with remark-math, which the read view enables with
 * its default `singleDollarTextMath`: a run of backticks or dollars that
 * no backslash escapes opens one, the next run of exactly as many of the
 * same character closes it, and a run never closed is text. The one that
 * opens first holds the other's character as content (`` `$` `` is code,
 * `` $`$ `` math). The rule of mdopener-mcp's `inline_spans`.
 */
export function inlineSpans(text: string, math = true): InlineSpan[] {
  const out: InlineSpan[] = [];
  // Link texts open (`[` or `![`) and not yet closed.
  let brackets = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // A backslash escapes the punctuation after it: `\`` and `\$` are
    // text, and the run after them may still open one.
    if (c === "\\") {
      i += /[!-/:-@[-`{-~]/.test(text[i + 1] ?? "") ? 2 : 1;
      continue;
    }
    // An autolink or inline HTML is read first: `<a title="$">` holds no
    // math.
    if (c === "<") {
      i = autolinkEnd(text, i) ?? inlineHtmlEnd(text, i) ?? i + 1;
      continue;
    }
    if (c === "[") brackets++;
    if (c === "]" && brackets > 0) {
      brackets--;
      // A link's `(destination "title")` holds no span: `[a](b$c) $d$`.
      const end = text[i + 1] === "(" ? inlineLinkEnd(text, i + 1) : null;
      if (end !== null) {
        i = end;
        continue;
      }
    }
    // A GFM literal autolink (`www.x.com/a`b`c`, `https://x/$y$`) holds
    // none either, out of an open link text, as micromark reads it.
    if (brackets === 0 && /[wWhH]/.test(c)) {
      const end = literalAutolinkEnd(text, i);
      if (end !== null) {
        i = end;
        continue;
      }
    }
    if (c !== "`" && !(math && c === "$")) {
      i++;
      continue;
    }
    let run = 0;
    while (text[i + run] === c) run++;
    // The next run of exactly as many closes it.
    let j = i + run;
    let close = -1;
    while (j < text.length) {
      if (text[j] !== c) {
        j++;
        continue;
      }
      let n = 0;
      while (text[j + n] === c) n++;
      if (n === run) {
        close = j;
        break;
      }
      j += n;
    }
    if (close < 0) {
      i += run;
      continue;
    }
    let value = text.slice(i + run, close);
    if (/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value) && /[^ \r\n]/.test(value)) {
      value = value.replace(/^(\r\n|[ \r\n])/, "").replace(/(\r\n|[ \r\n])$/, "");
    }
    out.push({ kind: c === "`" ? "code" : "math", start: i, end: close + run, value });
    i = close + run;
  }
  return out;
}

/** Whether `ch` is whitespace to micromark (a line ending, a space or a tab too). */
function isSpace(ch: string): boolean {
  return /\s/u.test(ch);
}

/** Whether `ch` is Unicode punctuation or a symbol, as micromark reads it. */
function isPunctuation(ch: string): boolean {
  return /\p{P}|\p{S}/u.test(ch);
}

/**
 * The offset past the GFM literal autolink (`www.x.org/a`, `https://x.org`)
 * that starts at `start`, or `null`, by the rules of
 * micromark-extension-gfm-autolink-literal: `www.` after the start, a space
 * or one of `( * _ [ ] ~`, or `http://` or `https://` after anything but
 * an ASCII letter, then a domain (no `_` in its last two segments) and a
 * path up to whitespace or a `<`, without the punctuation that trails it
 * ({@link autolinkTrail}). Email literals hold no `` ` `` or `$`, so they
 * are not read. The rule of mdopener-mcp's `literal_autolink_end`.
 */
function literalAutolinkEnd(text: string, start: number): number | null {
  const c = text[start];
  const prev = text[start - 1];
  let i = start;
  if (c === "w" || c === "W") {
    if (prev !== undefined && !isSpace(prev) && !"(*_[]~".includes(prev)) return null;
    if (!/^[wW]{3}\./.test(text.slice(start, start + 4)) || start + 4 >= text.length)
      return null;
  } else if (c === "h" || c === "H") {
    if (prev !== undefined && /[A-Za-z]/.test(prev)) return null;
    const m = /^https?:\/\//i.exec(text.slice(start, start + 8));
    if (!m) return null;
    i = start + m[0].length;
    const next = text[i];
    if (next === undefined || isControl(next) || isSpace(next) || isPunctuation(next))
      return null;
  } else {
    return null;
  }
  // The domain.
  let seen = false;
  let underscoreLast = false;
  let underscoreBefore = false;
  for (;;) {
    const ch = text[i];
    if (ch === "." || ch === "_") {
      if (autolinkTrail(text, i)) break;
      if (ch === "_") underscoreLast = true;
      else {
        underscoreBefore = underscoreLast;
        underscoreLast = false;
      }
      i++;
      continue;
    }
    if (ch === undefined || isSpace(ch) || (ch !== "-" && isPunctuation(ch))) break;
    seen = true;
    i++;
  }
  if (underscoreLast || underscoreBefore || !seen) return null;
  // The path, its parentheses balanced.
  let open = 0;
  let close = 0;
  for (;;) {
    const ch = text[i];
    if (ch === "(") {
      open++;
      i++;
      continue;
    }
    if (ch === ")" && close < open) {
      close++;
      i++;
      continue;
    }
    if (ch !== undefined && `!"&')*,.:;<?]_~`.includes(ch)) {
      if (autolinkTrail(text, i)) return i;
      if (ch === ")") close++;
      i++;
      continue;
    }
    if (ch === undefined || isSpace(ch)) return i;
    i++;
  }
}

/**
 * Whether the text at `i` is punctuation that trails a literal autolink
 * rather than ends its path: a run of `!"')*,.:;?_~`, `&name;` and `]`
 * (one followed by the end, a space, `(` or `[` ends it), up to the end,
 * whitespace or a `<`.
 */
function autolinkTrail(text: string, i: number): boolean {
  let j = i;
  for (;;) {
    const ch = text[j];
    if (ch !== undefined && `!"')*,.:;?_~`.includes(ch)) {
      j++;
    } else if (ch === "&") {
      j++;
      if (!/[A-Za-z]/.test(text[j] ?? "")) return false;
      while (/[A-Za-z]/.test(text[j] ?? "")) j++;
      if (text[j] !== ";") return false;
      j++;
    } else if (ch === "]") {
      j++;
      const n = text[j];
      if (n === undefined || n === "(" || n === "[" || isSpace(n)) return true;
    } else {
      return ch === undefined || ch === "<" || isSpace(ch);
    }
  }
}

/** Whether `ch` is an ASCII control character. */
function isControl(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c < 0x20 || c === 0x7f;
}

/**
 * The offset past the autolink (`<https://x>`, `<me@x.org>`) that starts at
 * `start` (its `<`), as CommonMark reads one, or `null`. The rule of
 * mdopener-mcp's `autolink_end`.
 */
function autolinkEnd(text: string, start: number): number | null {
  const close = text.indexOf(">", start + 1);
  if (close < 0) return null;
  const inner = text.slice(start + 1, close);
  const colon = inner.indexOf(":");
  if (
    colon >= 2 &&
    colon <= 32 &&
    /^[A-Za-z][A-Za-z0-9+.-]*$/.test(inner.slice(0, colon)) &&
    ![...inner.slice(colon + 1)].some((ch) => ch === " " || ch === "<" || isControl(ch))
  ) {
    return close + 1;
  }
  const at = inner.indexOf("@");
  if (at < 0) return null;
  const local = inner.slice(0, at);
  const domain = inner.slice(at + 1);
  const ok =
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) &&
    domain
      .split(".")
      .every((l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l));
  return ok ? close + 1 : null;
}

/**
 * The offset past the inline HTML that starts at `start` (its `<`), as
 * CommonMark reads it: an open or closing tag, a comment, a processing
 * instruction, a declaration or a CDATA section, or `null`. The rule of
 * mdopener-mcp's `html_end`.
 */
function inlineHtmlEnd(text: string, start: number): number | null {
  const find = (from: number, end: string) => {
    const k = text.indexOf(end, from);
    return k < 0 ? null : k + end.length;
  };
  const nameEnd = (j: number) => {
    if (!/[A-Za-z]/.test(text[j] ?? "")) return null;
    while (/[A-Za-z0-9-]/.test(text[j] ?? "")) j++;
    return j;
  };
  const spaces = (j: number) => {
    while (text[j] === " " || text[j] === "\t") j++;
    return j;
  };
  const j = start + 1;
  const rest = text.slice(j);
  if (text[j] === "/") {
    const n = nameEnd(j + 1);
    if (n === null) return null;
    const k = spaces(n);
    return text[k] === ">" ? k + 1 : null;
  }
  if (text[j] === "?") return find(j + 1, "?>");
  if (rest.startsWith("!-->")) return j + 4;
  if (rest.startsWith("!--->")) return j + 5;
  if (rest.startsWith("!--")) return find(j + 3, "-->");
  if (rest.startsWith("![CDATA[")) return find(j + 8, "]]>");
  if (text[j] === "!")
    return /[A-Za-z]/.test(text[j + 1] ?? "") ? find(j + 1, ">") : null;
  let k = nameEnd(j);
  if (k === null) return null;
  for (;;) {
    const gap = spaces(k);
    if (gap >= text.length) return null;
    if (text[gap] === ">") return gap + 1;
    if (text[gap] === "/" && text[gap + 1] === ">") return gap + 2;
    if (gap === k) return null;
    // An attribute name, then an optional value.
    if (!/[A-Za-z_:]/.test(text[gap])) return null;
    k = gap + 1;
    while (/[A-Za-z0-9_.:-]/.test(text[k] ?? "")) k++;
    const eq = spaces(k);
    if (text[eq] === "=") {
      const v = spaces(eq + 1);
      const q = text[v];
      if (q === undefined) return null;
      if (q === '"' || q === "'") {
        const e = text.indexOf(q, v + 1);
        if (e < 0) return null;
        k = e + 1;
      } else {
        let e = v;
        while (e < text.length && !/[\s"'=<>`]/.test(text[e])) e++;
        if (e === v) return null;
        k = e;
      }
    }
  }
}

/**
 * The offset past the `(destination "title")` tail of an inline link that
 * starts at `start` (its `(`), as CommonMark reads one, or `null`. The rule
 * of mdopener-mcp's `inline_link_end`.
 */
function inlineLinkEnd(text: string, start: number): number | null {
  const punct = (ch: string | undefined) =>
    ch !== undefined && /[!-/:-@[-`{-~]/.test(ch);
  const spaces = (j: number) => {
    while (text[j] === " " || text[j] === "\t") j++;
    return j;
  };
  if (text[start] !== "(") return null;
  let j = spaces(start + 1);
  if (text[j] === "<") {
    j++;
    for (;;) {
      const ch = text[j];
      if (ch === undefined || ch === "<") return null;
      if (ch === "\\" && punct(text[j + 1])) j += 2;
      else if (ch === ">") break;
      else j++;
    }
    j++;
  } else {
    let depth = 0;
    while (j < text.length) {
      const ch = text[j];
      if (ch === "\\" && punct(text[j + 1])) j++;
      else if (ch === "(") depth++;
      else if (ch === ")" && depth === 0) break;
      else if (ch === ")") depth--;
      else if (ch === " " || isControl(ch)) break;
      j++;
    }
    if (depth > 0) return null;
  }
  const k = spaces(j);
  if (text[k] === ")") return k + 1;
  if (k === j) return null;
  const close = { '"': '"', "'": "'", "(": ")" }[text[k] ?? ""];
  if (close === undefined) return null;
  let t = k + 1;
  for (;;) {
    const ch = text[t];
    if (ch === undefined) return null;
    if (ch === "\\" && punct(text[t + 1])) t += 2;
    else if (ch === close) break;
    else if (ch === "(" && close === ")") return null;
    else t++;
  }
  const end = spaces(t + 1);
  return text[end] === ")" ? end + 1 : null;
}

/**
 * The text of each of `lines` ({@link markdownLines}) with its code spans
 * and inline math ({@link inlineSpans}) masked by `\r`s, so it keeps its
 * length and line breaks. They are read over each block's inline content:
 * a paragraph's lines (a text line and the lines that go on with it, its
 * `continues`) together, so a span may run over its line breaks, and a
 * front matter block, which is no Markdown, for code spans only, as
 * mdopener-mcp's `prose_chars` reads it. Other lines are as they are. A
 * code span used to be read over the whole document, so a backtick could
 * pair with one paragraphs later, and inline math was not read.
 *
 * A GFM table in a paragraph ({@link tableRows}) is read cell by cell, as
 * remark-gfm reads each cell's inline content on its own: a backtick could
 * pair with one in the next cell or row (`` | `a | b` | ``), which the page
 * shows as text, so the text between was taken for code.
 */
export function maskInlineCode(lines: MarkdownLine[]): string[] {
  const out = lines.map((l) => l.text);
  // The lines with their container markers as spaces: an inline block
  // starts past them (`> www.x` is a link after the `>`).
  const view = lines.map(inlineView);
  // Mask the spans of lines [from, to) read as one inline block.
  const mask = (from: number, to: number, math: boolean) => {
    if (from >= to) return;
    const block = out.slice(from, to).join("\n");
    maskSpans(block, math, view.slice(from, to).join("\n"))
      .split("\n")
      .forEach((t, k) => {
        out[from + k] = t;
      });
  };
  let i = 0;
  while (i < lines.length) {
    const kind = lines[i].kind;
    let j = i + 1;
    if (kind === "frontmatter") {
      while (j < lines.length && lines[j].kind === "frontmatter") j++;
      mask(i, j, false);
    } else if (kind === "text") {
      while (j < lines.length && lines[j].kind === "text" && lines[j].continues) j++;
      // The paragraph's lines up to a table, its rows cell by cell, and
      // the lines after it as the next block.
      let from = i;
      for (let k = i; k + 1 < j; k++) {
        const rows = tableRows(lines, k, j, lines[i].contained);
        if (rows === 0) continue;
        mask(from, k, true);
        for (let r = k; r < k + rows; r++) {
          if (r === k + 1) continue; // The delimiter row holds no text.
          let cells = "";
          let at = 0;
          for (const cell of splitCells(view[r])) {
            cells += maskSpans(out[r].slice(at, at + cell.length), true, cell);
            at += cell.length;
          }
          out[r] = cells;
        }
        from = k + rows;
        // Lines indented four columns after it are indented code.
        while (from < j && /^ {4}/.test(lines[from].content)) from++;
        k = from - 1;
      }
      mask(from, j, true);
    }
    i = j;
  }
  return out;
}

/**
 * `block` with its code spans (and with `math` inline math) masked by
 * `\r`s, as they are read in `view`, the same text with its container
 * markers as spaces.
 */
function maskSpans(block: string, math: boolean, view = block): string {
  let masked = "";
  let at = 0;
  for (const span of inlineSpans(view, math)) {
    masked +=
      block.slice(at, span.start) +
      block.slice(span.start, span.end).replace(/[^\n]/g, "\r");
    at = span.end;
  }
  return masked + block.slice(at);
}

/**
 * The text of line `l` with the blockquote markers and list item
 * indentation before its content as spaces, so it keeps its length; as it
 * is when its content cannot be found in it (a tab expanded).
 */
function inlineView(l: MarkdownLine): string {
  const raw = l.text.endsWith("\r") ? l.text.slice(0, -1) : l.text;
  const cut = raw.length - l.content.length;
  if (!l.contained || cut <= 0 || !raw.endsWith(l.content)) return l.text;
  return " ".repeat(cut) + l.text.slice(cut);
}

/**
 * `row` cut before each pipe that splits GFM table cells (one no backslash
 * escapes, in a code span too), so the pieces join back to `row`.
 */
function splitCells(row: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\") i++;
    else if (row[i] === "|") {
      out.push(row.slice(at, i));
      at = i;
    }
  }
  out.push(row.slice(at));
  return out;
}

/** The number of GFM table cells of `content` (a row past its containers). */
function cellCount(content: string): number {
  const row = content.trim();
  const pipes = splitCells(row).length - 1;
  const lead = row.startsWith("|") ? 1 : 0;
  // A closing pipe no backslash escapes; a lone `|` opens and closes no cell.
  const trail =
    row.endsWith("|") && splitCells(row.slice(0, -1)).length === pipes ? 1 : 0;
  return pipes + 1 - lead - trail;
}

/**
 * How many lines of a paragraph, `lines` [k, end), the GFM table that
 * starts at `k` takes (its header row, its delimiter row and its body
 * rows), or 0 when none starts there, as remark-gfm reads one: a header
 * row of as many cells as the delimiter row after it (`:?-+:?` cells, not
 * a setext underline), then the lines that go on in the same containers,
 * up to a blank line or one indented four columns.
 */
function tableRows(
  lines: MarkdownLine[],
  k: number,
  end: number,
  contained: boolean,
): number {
  const head = lines[k];
  const delim = lines[k + 1];
  // A lazy line (`> a`, then `b`) is no row.
  if (head.contained !== contained || delim.contained !== contained) return 0;
  if (delim.setext || /^ {4}/.test(head.content) || /^ {4}/.test(delim.content))
    return 0;
  const d = delim.content.trim();
  const cells = splitCells(d.replace(/^\|/, "").replace(/\|$/, "")).map((c) =>
    c.replace(/^\|/, "").trim(),
  );
  if (!cells.every((c) => /^:?-+:?$/.test(c))) return 0;
  if (!d.includes("|") && !/^:|:$/.test(d)) return 0;
  if (cellCount(head.content) !== cells.length) return 0;
  let n = 2;
  while (
    k + n < end &&
    lines[k + n].contained === head.contained &&
    lines[k + n].content.trim() !== "" &&
    !/^ {4}/.test(lines[k + n].content)
  )
    n++;
  return n;
}

/**
 * For each of `lines` ({@link markdownLines}), whether it is in an
 * indented code block: an `indented` line, or a blank line between two of
 * them in the same containers, which CommonMark reads as one block holding
 * the blank lines. markdownLines marks those blank lines `text`, as a
 * blank line alone cannot tell, so a caller that took them for gaps
 * between blocks split the code (a blank line at the end of the block, or
 * one that leaves a blockquote, is not in it). Fuzzed against mdast.
 */
export function inIndentedCode(lines: MarkdownLine[]): boolean[] {
  const out = lines.map((l) => l.kind === "indented");
  const blank = (l: MarkdownLine) => l.kind === "text" && l.content.trim() === "";
  // The containers of a line, as far as a blank line shows them: whether
  // it is in one, and how many blockquotes deep.
  const quotes = (l: MarkdownLine) =>
    (/^(?:[ \t]*>)*/.exec(l.text)?.[0].match(/>/g) ?? []).length;
  const same = (a: MarkdownLine, b: MarkdownLine) =>
    a.contained === b.contained && quotes(a) === quotes(b);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== "indented") continue;
    // A code line right after a blockquote's line, outside it, is a block
    // of its own line, as micromark reads it (it tries the line as a lazy
    // one of the quote first).
    const prev = lines[i - 1];
    if (prev?.contained && !lines[i].contained && /^ {0,3}>/.test(prev.text)) continue;
    let j = i + 1;
    while (j < lines.length && blank(lines[j]) && same(lines[j], lines[i])) j++;
    if (j > i + 1 && lines[j]?.kind === "indented" && same(lines[j], lines[i])) {
      out.fill(true, i + 1, j);
    }
  }
  return out;
}

/**
 * `markdown` with every character the page does not read as Markdown text
 * replaced by a NUL, line breaks (and a `\r` before one) kept, so offsets
 * stay: front matter, fenced and indented code and HTML blocks (by the
 * line rule, {@link markdownLines}), and code spans and inline math
 * ({@link maskInlineCode}). Where the lint rules and the image reorder read
 * links, URLs and images.
 */
export function proseText(markdown: string): string {
  const lines = markdownLines(markdown);
  const masked = maskInlineCode(lines);
  return lines
    .map((l, i) => {
      if (l.kind !== "text") return l.text.replace(/[^\r]/g, "\0");
      const m = masked[i];
      let t = "";
      for (let k = 0; k < l.text.length; k++)
        t += m[k] === l.text[k] ? l.text[k] : "\0";
      return t;
    })
    .join("\n");
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

/** `line` without a leading UTF-8 byte order mark. */
function withoutBom(line: string): string {
  return line.startsWith("\uFEFF") ? line.slice(1) : line;
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
    const bare = all[i].endsWith("\r") ? all[i].slice(0, -1) : all[i];
    const content = i === 0 ? withoutBom(bare) : bare;
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
    // A byte order mark before the first line is not its text (micromark
    // drops it), so `\uFEFF# Title` is a heading.
    const unmarked = line === 1 ? withoutBom(text) : text;
    const raw = unmarked.endsWith("\r") ? unmarked.slice(0, -1) : unmarked;
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
  const text = l.line === 1 ? withoutBom(l.text) : l.text;
  const raw = text.endsWith("\r") ? text.slice(0, -1) : text;
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
  const defs = definitionLabels(lines);
  lines.forEach((l, i) => {
    // A heading in a footnote definition is in the page's footnotes, after
    // every other heading, so its slug cannot change theirs.
    if (l.kind !== "text" || l.footnote) return;
    if (l.setext) {
      // A setext heading takes its slug from its lines, joined by line
      // breaks as the renderer's heading text is, but is not listed.
      const source = lines.slice(l.setext.from, i).map(inlineSource).join("\n");
      slugger.slug(stripInline(source, true, defs));
      return;
    }
    const h = atxHeading(inlineSource(l));
    if (!h) return;
    // Every heading takes a slug, an empty one too (`#`, or `# <b></b>`):
    // rehype-slug gives it the id "" and the next empty one "-1".
    const slug = slugger.slug(stripInline(h.text, true, defs));
    const text = stripInline(h.text, false, defs);
    // An empty heading is not listed, nor one in a blockquote or a list
    // item, which takes its slug all the same.
    if (text === "" || l.contained) return;
    out.push({ depth: h.depth, text, slug, line: l.line });
  });
  return out;
}

/**
 * The text of line `l` as its inline content reads it: past its
 * containers, with its tabs as written where it sits in none (a tab in a
 * heading is a tab in its text, which the page's slug drops; the line's
 * `content` has it expanded to spaces, which the slug made `-`s).
 */
function inlineSource(l: MarkdownLine): string {
  if (l.contained) return l.content;
  return (l.line === 1 ? withoutBom(l.text) : l.text).replace(/\r$/, "");
}

/**
 * The labels ({@link normalizeLabel}) of the link reference definitions
 * of `lines` ({@link markdownLines}): those at the start of each
 * paragraph, by the rule of {@link definitionsLength}.
 */
function definitionLabels(lines: MarkdownLine[]): Set<string> {
  const defs = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    if (
      lines[i].kind !== "text" ||
      lines[i].continues ||
      lines[i].content.trim() === ""
    ) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j].kind === "text" && lines[j].continues) j++;
    const para = lines.slice(i, j).map((l) => l.content);
    let k = 0;
    while (k < para.length) {
      const text = k === 0 ? para[k] : para[k].trimStart();
      const n = referenceDefinition(text, para.slice(k + 1));
      if (n === null) break;
      const label = /^ *\[((?:\\.|[^\\\]])*)\]:/.exec(text)?.[1];
      if (label !== undefined) defs.add(normalizeLabel(label));
      k += n;
    }
    i = j;
  }
  return defs;
}
