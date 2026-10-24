/**
 * slackText.ts: a rendered document as Slack mrkdwn text, for the Slack
 * export profile (a `.txt` to paste into a message).
 *
 * Slack's message format: `*bold*`, `_italic_`, `~strike~`, `` `code` ``,
 * fenced code blocks, `> quote` lines, `<url|text>` links, and `&`, `<`,
 * `>` written as entities. It has no headings, tables or images, so a
 * heading is a bold line, a table row its cells joined with ` | `, and an
 * image its alt text (a web image a link to it).
 */

/** App chrome and markup with no text of the document's own. */
const SKIP =
  "button, script, style, template, .code-block-header, .code-actions, .code-output, .review-card, .remote-images-banner, .remote-image-load, .katex-html";

/** Elements whose content is laid out as blocks, not run into a line. */
const BLOCK = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "UL",
]);

/** Text with the three characters Slack reads as markup written as entities. */
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `text` between `mark`s, with its outer spaces outside them (Slack needs that). */
function wrap(text: string, mark: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!m || m[2] === "") return text;
  return `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
}

/** The TeX source of a KaTeX element, or its text. */
function mathText(el: Element): string {
  const tex = el.querySelector('annotation[encoding="application/x-tex"]');
  return (tex?.textContent ?? el.textContent ?? "").trim();
}

/** A link in Slack's form, `<url|text>`, or `<url>` when the text is the URL. */
function link(href: string, text: string): string {
  const url = href.replace(/[<>|]/g, encodeURIComponent);
  const label = text.trim();
  return label === "" || label === href
    ? `<${url}>`
    : `<${url}|${label.replace(/\|/g, "/")}>`;
}

/** The inline text of `node`'s children, in mrkdwn. */
function inline(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) out += inlineNode(child);
  return out;
}

function inlineNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeText((node.textContent ?? "").replace(/\s+/g, " "));
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  if (el.matches(SKIP)) return "";
  if (el.matches(".katex, .katex-display")) return wrap(escapeText(mathText(el)), "`");
  switch (el.tagName) {
    case "BR":
      return "\n";
    case "STRONG":
    case "B":
      return wrap(inline(el), "*");
    case "EM":
    case "I":
      return wrap(inline(el), "_");
    case "DEL":
    case "S":
      return wrap(inline(el), "~");
    case "CODE":
    case "KBD":
      return wrap(escapeText(el.textContent ?? ""), "`");
    case "A": {
      const href = el.getAttribute("href") ?? "";
      const text = inline(el);
      return /^(https?:|mailto:)/i.test(href) ? link(href, text) : text;
    }
    case "IMG": {
      const alt = escapeText(el.getAttribute("alt") ?? "");
      const src = el.getAttribute("src") ?? "";
      return /^https?:/i.test(src) ? link(src, alt) : alt;
    }
    case "INPUT":
      if (el.getAttribute("type") === "checkbox") {
        return (el as HTMLInputElement).checked || el.hasAttribute("checked")
          ? "[x] "
          : "[ ] ";
      }
      return "";
    case "SVG":
    case "svg":
      return "";
    default:
      return inline(el);
  }
}

/** A run of inline text as one tidy paragraph (or several lines, for `<br>`). */
function paragraph(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim();
}

/** `node`'s children as mrkdwn blocks, inline runs gathered into paragraphs. */
function blocks(node: Node, depth: number): string[] {
  const out: string[] = [];
  let run = "";
  const flush = () => {
    const p = paragraph(run);
    if (p) out.push(p);
    run = "";
  };
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (el.matches(SKIP)) continue;
      if (BLOCK.has(el.tagName) && !el.matches(".katex, .katex-display")) {
        flush();
        out.push(...block(el, depth));
        continue;
      }
    }
    run += inlineNode(child);
  }
  flush();
  return out;
}

/** One block element as mrkdwn blocks. */
function block(el: Element, depth: number): string[] {
  switch (el.tagName) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const text = paragraph(inline(el));
      return text ? [wrap(text.replace(/\*/g, ""), "*")] : [];
    }
    case "HR":
      return ["----"];
    case "PRE": {
      const code = (el.textContent ?? "").replace(/\n$/, "");
      return [`\`\`\`\n${escapeText(code)}\n\`\`\``];
    }
    case "UL":
    case "OL":
      return [list(el, depth)].filter((l) => l !== "");
    case "BLOCKQUOTE": {
      const inner = blocks(el, depth).join("\n\n");
      return inner
        ? [
            inner
              .split("\n")
              .map((l) => (l ? `> ${l}` : ">"))
              .join("\n"),
          ]
        : [];
    }
    case "TABLE": {
      const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
        Array.from(tr.children)
          .map((cell) => {
            const text = paragraph(inline(cell)).replace(/\n/g, " ");
            return cell.tagName === "TH" ? wrap(text, "*") : text;
          })
          .join(" | "),
      );
      return rows.length > 0 ? [rows.join("\n")] : [];
    }
    default:
      return blocks(el, depth);
  }
}

/** A list as bullet (`•`) or numbered lines, nested lists indented. */
function list(el: Element, depth: number): string {
  const ordered = el.tagName === "OL";
  let n = Number.parseInt(el.getAttribute("start") ?? "1", 10);
  if (!Number.isFinite(n)) n = 1;
  const lines: string[] = [];
  const indent = "    ".repeat(depth);
  for (const li of Array.from(el.children)) {
    if (li.tagName !== "LI") continue;
    const marker = ordered ? `${n}. ` : "• ";
    n += 1;
    const own: string[] = [];
    const nested: string[] = [];
    for (const part of blocks(liWithoutLists(li), depth + 1)) own.push(part);
    for (const sub of Array.from(li.children)) {
      if (sub.tagName === "UL" || sub.tagName === "OL")
        nested.push(list(sub, depth + 1));
    }
    const text = own.join("\n").replace(/\n/g, `\n${indent}  `);
    lines.push(`${indent}${marker}${text}`);
    for (const sub of nested) if (sub) lines.push(sub);
  }
  return lines.join("\n");
}

/** A copy of a list item without its nested lists, which {@link list} lays out. */
function liWithoutLists(li: Element): Element {
  const copy = li.cloneNode(true) as Element;
  for (const sub of Array.from(copy.children)) {
    if (sub.tagName === "UL" || sub.tagName === "OL") sub.remove();
  }
  return copy;
}

/**
 * The rendered document `root` (a `.markdown-body`) as Slack mrkdwn text,
 * blocks separated by a blank line, ending in a newline.
 */
export function slackMrkdwn(root: Element): string {
  const text = blocks(root, 0).join("\n\n").trim();
  return text ? `${text}\n` : "";
}
