// Minimal markdown renderer for AI sidebar answers.
//
// Model output is untrusted: an answer can contain HTML (an `<img onerror>`,
// a `<script>`, a `javascript:` link) whether the model was tricked by the
// document it read or not. Every character of the text is escaped first, and
// only then is the small set of markdown formatting below applied to the
// escaped text, so the only tags in the result are the ones built here.
// Links are built only for http, https and mailto URLs; any other link keeps
// its text and drops the URL.
//
// Handles: fenced code blocks, inline code, links, bold, italics, bullet
// lists, paragraphs and line breaks. We do NOT pull in a full markdown
// library for the chat; keep it light.

/** Escapes text for use in HTML element content and quoted attributes. */
export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Reverses escHtml (only the entities escHtml writes). */
function unescHtml(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/** Whether a link URL uses a scheme the chat may link to. */
export function isSafeLinkUrl(url: string): boolean {
  if (!/^(?:https?:\/\/|mailto:)\S+$/i.test(url)) return false;
  // No control characters, which a browser may strip before reading the scheme.
  for (const ch of url) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** Placeholder marker for stashed HTML (a private-use character, stripped
 *  from the input first so text cannot forge a placeholder). */
const MARK = "\uE000";

export function renderChatMarkdown(text: string, streaming: boolean): string {
  const stashed: string[] = [];
  const stash = (html: string) => `${MARK}${stashed.push(html) - 1}${MARK}`;

  let html = text
    .replace(/\uE000/g, "")
    // Fenced code blocks
    .replace(/```[\w]*\n([\s\S]*?)```/g, (_m, body: string) =>
      stash(`<pre><code>${escHtml(body.trimEnd())}</code></pre>`),
    )
    // Inline code
    .replace(/`([^`\n]+)`/g, (_m, body: string) =>
      stash(`<code>${escHtml(body)}</code>`),
    );

  // Everything that is not code is plain text until formatted below.
  html = escHtml(html)
    // Links: only http, https and mailto become anchors.
    .replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (_m, label: string, url: string) => {
      const raw = unescHtml(url);
      if (raw.includes(MARK) || !isSafeLinkUrl(raw)) return label;
      // The tags are stashed so the formatting below never edits the href.
      const open = stash(
        `<a href="${escHtml(raw)}" target="_blank" rel="noopener noreferrer">`,
      );
      return `${open}${label}${stash("</a>")}`;
    })
    // Bold
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    // Unordered list items. Wrap only CONSECUTIVE <li> runs in one <ul>; a
    // greedy `(<li>.*<\/li>)/gs` would span from the first to the last item and
    // swallow any prose or blank lines between two separate lists.
    .replace(/^[ \t]*[-*+] (.+)$/gm, "<li>$1</li>")
    .replace(/(?:<li>.*?<\/li>\n?)+/g, (m) => `<ul>${m.replace(/\n/g, "")}</ul>`)
    // Italics: *text* or _text_, not touching a word character on the outside.
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/gm, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/gm, "$1<em>$2</em>")
    // Double newline: paragraph break
    .replace(/\n{2,}/g, "</p><p>")
    // Single newline inside paragraphs
    .replace(/\n/g, "<br>");

  html = html.replace(
    /\uE000(\d+)\uE000/g,
    (_m, i: string) => stashed[Number(i)] ?? "",
  );

  // Wrap in a paragraph unless already structured
  if (!html.startsWith("<")) html = `<p>${html}</p>`;

  // Append blinking cursor while streaming
  if (streaming) html += '<span class="ai-cursor" aria-hidden="true"></span>';

  return html;
}
