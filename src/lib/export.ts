/**
 * export.ts — orchestration for PDF / DOCX / HTML export.
 *
 * REQUIREMENT: The document must be in "read" view so that
 * `.markdown-body` is present in the DOM.  All three export
 * functions throw a user-visible string if the element is absent.
 *
 * Design notes:
 *  - HTML is built as a fully self-contained offline document by inlining
 *    all CSS (themes + markdown + KaTeX) via Vite's `?raw` import.
 *  - DOCX is generated client-side with `html-to-docx` (MIT, must be
 *    installed: `bun add html-to-docx`).
 *  - PDF delegates to the OS print dialog via a hidden <iframe> so only
 *    the document content is printed — no app chrome.
 *  - Bytes are persisted through the Rust `write_file_bytes` command
 *    (see src-tauri/src/export.rs) which does an atomic temp-file rename.
 */

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
// Vite ?raw imports — each resolves to the full CSS text at build time.
import katexCss from "katex/dist/katex.min.css?raw";
import { useDocumentStore } from "../store/documentStore";
import { useSettingsStore } from "../store/settingsStore";
import { toast } from "../store/toastStore";
import markdownCss from "../styles/markdown.css?raw";
import themesCss from "../styles/themes.css?raw";
import { READ_VIEW_REQUIRED, ShownExportError } from "./exportErrors";
import type { ExportProfileId, ExportTemplate } from "./exportTemplates";
import { findProfile, findTemplate } from "./exportTemplates";
import { frontmatterText } from "./frontmatter";
import { slackMrkdwn } from "./slackText";

// ─── EPUB theme CSS ──────────────────────────────────────────────────────────

/**
 * Return theme-aware CSS for EPUB chapters, mapping Ashlr's three themes
 * (paper / sepia / midnight) to portable EPUB-compatible styles.
 *
 * EPUB readers apply their own default styles; we override the key variables
 * so the document looks intentional regardless of reading app defaults.
 */
export function buildEpubThemeCss(theme: string): string {
  const themeVars: Record<
    string,
    { bg: string; text: string; code: string; border: string }
  > = {
    paper: {
      bg: "#ffffff",
      text: "#1a1a1a",
      code: "#f4f4f4",
      border: "#e0e0e0",
    },
    sepia: {
      bg: "#f8f3e8",
      text: "#3c2a1a",
      code: "#ede7d9",
      border: "#c8b89a",
    },
    midnight: {
      bg: "#1a1a2e",
      text: "#e0e0f0",
      code: "#252540",
      border: "#3a3a5c",
    },
  };
  const v = themeVars[theme] ?? themeVars.paper;

  return `
body {
  font-family: Georgia, "Times New Roman", Times, serif;
  font-size: 1em;
  line-height: 1.7;
  color: ${v.text};
  background-color: ${v.bg};
  margin: 0 5%;
  padding: 1em 0;
}
h1, h2, h3, h4, h5, h6 {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  font-weight: 700;
  line-height: 1.25;
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  color: ${v.text};
}
h1 { font-size: 1.8em; }
h2 { font-size: 1.4em; border-bottom: 1px solid ${v.border}; padding-bottom: 0.2em; }
h3 { font-size: 1.15em; }
h4, h5, h6 { font-size: 1em; }
p { margin: 0 0 0.9em; }
a { color: ${v.text}; text-decoration: underline; }
code {
  font-family: "Courier New", Courier, monospace;
  font-size: 0.88em;
  background-color: ${v.code};
  border: 1px solid ${v.border};
  border-radius: 3px;
  padding: 0.15em 0.35em;
}
pre {
  background-color: ${v.code};
  border: 1px solid ${v.border};
  border-radius: 4px;
  padding: 0.8em 1em;
  overflow-x: auto;
  margin: 0 0 1em;
  font-size: 0.85em;
  line-height: 1.5;
}
pre code { background: none; border: none; padding: 0; font-size: 100%; }
blockquote {
  border-left: 3px solid ${v.border};
  margin: 0 0 1em;
  padding: 0.5em 1em;
  color: ${v.text};
  opacity: 0.85;
}
table { border-collapse: collapse; width: 100%; margin: 0 0 1em; font-size: 0.9em; }
th, td { border: 1px solid ${v.border}; padding: 0.4em 0.7em; text-align: left; }
th { font-weight: 700; background-color: ${v.code}; }
img { max-width: 100%; height: auto; display: block; margin: 0.5em auto; }
ul, ol { margin: 0 0 0.9em; padding-left: 1.8em; }
li { margin: 0.2em 0; }
hr { border: none; border-top: 1px solid ${v.border}; margin: 1.5em 0; }
`.trim();
}

// ─── KaTeX fonts ─────────────────────────────────────────────────────────────

/**
 * KaTeX's fonts (WOFF2, which every browser that opens an export reads), as
 * `data:` URLs, loaded only when an export holds math.
 */
const KATEX_FONT_FILES = import.meta.glob<string>(
  "../../node_modules/katex/dist/fonts/*.woff2",
  { query: "?inline", import: "default" },
);

/** File name to `data:` URL, once {@link loadKatexFonts} has run. */
let katexFonts: Map<string, string> | null = null;

/** Load KaTeX's fonts for {@link katexCssForExport}. Never throws. */
export async function loadKatexFonts(): Promise<void> {
  if (katexFonts) return;
  try {
    const fonts = new Map<string, string>();
    await Promise.all(
      Object.entries(KATEX_FONT_FILES).map(async ([path, load]) => {
        fonts.set(path.slice(path.lastIndexOf("/") + 1), await load());
      }),
    );
    katexFonts = fonts;
  } catch {
    // Left as they are: the math shows in fallback fonts.
  }
}

/**
 * `css` (KaTeX's stylesheet) with each font it names as a `data:` URL from
 * `fonts` (file name to URL). Its `url(fonts/KaTeX_Main-Regular.woff2)`
 * resolved next to the exported file, where there are none, or (in the
 * PDF's print frame) in the app, whose build names them otherwise: the math
 * of every HTML and PDF export was set in fallback fonts, with misdrawn
 * roots, brackets and large operators. A font face none of whose files is
 * in `fonts` is left as it was.
 *
 * With `used` (from {@link usedKatexFaces}), only the faces the page's math
 * is set in are put in the page, where all 20 were (about 300 KB, most of it
 * for faces a page never uses); the others are left as they were, links the
 * browser follows only for a face it needs. A family set in a weight or style
 * it has no face for (the browser then picks the nearest) gets all its faces.
 */
export function katexCssForExport(
  css: string,
  fonts: ReadonlyMap<string, string> | null = katexFonts,
  used: ReadonlySet<string> | null = null,
): string {
  if (!fonts || fonts.size === 0) return css;
  const faces = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => fontFace(m[0]));
  const needed = (face: KatexFace): boolean => {
    if (!used || !face.family) return true;
    if (used.has(faceKey(face))) return true;
    // A used weight or style of this family that no face of it has.
    return [...used].some((key) => {
      const [family] = key.split("|");
      return (
        family === face.family &&
        !faces.some((f) => f.family === family && faceKey(f) === key)
      );
    });
  };
  return css.replace(/@font-face\s*\{[^}]*\}/g, (block) =>
    needed(fontFace(block)) ? embedFontFace(block, fonts) : block,
  );
}

/** An `@font-face` rule's family, weight (400 or 700) and style. */
interface KatexFace {
  family: string;
  weight: 400 | 700;
  italic: boolean;
}

function fontFace(block: string): KatexFace {
  const prop = (name: string) =>
    new RegExp(`${name}\\s*:\\s*([^;}]*)`).exec(block)?.[1].trim() ?? "";
  return {
    family: firstFontFamily(prop("font-family")),
    weight: boldWeight(prop("font-weight")) ? 700 : 400,
    italic: /italic|oblique/.test(prop("font-style")),
  };
}

/** A face as {@link usedKatexFaces} names it: `KaTeX_Main|700|italic`. */
function faceKey(face: KatexFace): string {
  return `${face.family}|${face.weight}|${face.italic ? "italic" : "normal"}`;
}

/** The first family of a `font-family` value, unquoted. */
function firstFontFamily(value: string): string {
  return (value.split(",")[0] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
}

/** Whether a `font-weight` is set with a bold face (600 and up, as CSS matching picks 700). */
function boldWeight(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "bold" || v === "bolder") return true;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n >= 600;
}

/** One `@font-face` rule with its WOFF2 files from `fonts` as `data:` URLs. */
function embedFontFace(block: string, fonts: ReadonlyMap<string, string>): string {
  return block.replace(/src:([^;}]*)/g, (whole, list: string) => {
    const kept = list
      .split(",")
      .map((entry) => {
        const m = /url\(\s*["']?(?:[^)"']*\/)?([^/)"']+\.woff2)["']?\s*\)/.exec(entry);
        const data = m ? fonts.get(m[1]) : undefined;
        return data ? `url(${data}) format("woff2")` : null;
      })
      .filter((x): x is string => x !== null);
    return kept.length > 0 ? `src:${kept.join(",")}` : whole;
  });
}

/**
 * The KaTeX faces the read view's math is set in, as the browser styled it
 * (each text's element's computed family, weight and style), named as
 * {@link faceKey} does. Null when there is no math or none of it measured in
 * a KaTeX family (its stylesheet not applied), so every face is kept.
 */
export function usedKatexFaces(root: ParentNode = document): Set<string> | null {
  const used = new Set<string>();
  const seen = new Set<Element>();
  for (const math of root.querySelectorAll(".markdown-body .katex")) {
    const walker = (math.ownerDocument ?? document).createTreeWalker(
      math,
      NodeFilter.SHOW_TEXT,
    );
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const el = t.parentElement;
      if (!el || seen.has(el) || !t.nodeValue?.trim()) continue;
      seen.add(el);
      const style = getComputedStyle(el);
      const family = firstFontFamily(style.fontFamily);
      if (!family.startsWith("KaTeX_")) continue;
      used.add(
        faceKey({
          family,
          weight: boldWeight(style.fontWeight) ? 700 : 400,
          italic: /italic|oblique/.test(style.fontStyle),
        }),
      );
    }
  }
  return used.size > 0 ? used : null;
}

/** Load KaTeX's fonts when the read view shows math. */
async function fontsForMath(): Promise<void> {
  if (document.querySelector(".markdown-body .katex")) await loadKatexFonts();
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Grab the current theme id from the document root (set by App.tsx). */
function currentTheme(): string {
  return document.documentElement.dataset.theme ?? "paper";
}

/** Return the content-width and font-size CSS vars currently applied. */
function currentLayoutVars(): string {
  const style = getComputedStyle(document.documentElement);
  const width = style.getPropertyValue("--content-width").trim() || "720px";
  const fontSize = style.getPropertyValue("--content-font-size").trim() || "17px";
  return `--content-width:${width};--content-font-size:${fontSize};`;
}

/**
 * Clone an element and strip Ashlr-injected UI chrome that lives inside
 * `.markdown-body` but is NOT part of the document: the review summary card
 * and the remote images bar (with its buttons). Exports and rich-text copies should contain the document, not
 * the app's rendering overlay.
 */
export function cloneWithoutInjectedChrome(el: Element): Element {
  const clone = el.cloneNode(true) as Element;
  // The remote images bar and its "Load remote images" buttons are the
  // app's too; a blocked image keeps its placeholder text.
  for (const node of clone.querySelectorAll(
    ".review-card, .remote-images-banner, .remote-image-load",
  ))
    node.remove();
  // An image or embed still loading (see waitForRenderedImages) is its name,
  // not the app's "Loading x…" placeholder.
  for (const node of clone.querySelectorAll(".wikiembed--loading"))
    node.replaceWith(
      node.ownerDocument.createTextNode(node.getAttribute("data-name") ?? ""),
    );
  // A diagram still rendering is its source, as a code block: it was an
  // empty block.
  for (const node of clone.querySelectorAll(".mermaid-block--loading")) {
    const pre = node.ownerDocument.createElement("pre");
    const code = node.ownerDocument.createElement("code");
    code.className = "language-mermaid";
    code.textContent = node.getAttribute("data-code") ?? "";
    pre.appendChild(code);
    node.replaceWith(pre);
  }
  // A block's source line is for the app's own search jumps.
  for (const node of clone.querySelectorAll("[data-source-line]"))
    node.removeAttribute("data-source-line");
  return clone;
}

/** How long an export waits for the read view's images and embeds to load. */
export const EXPORT_IMAGE_WAIT_MS = 5000;

/**
 * Resolves once the read view shows no image, embed or diagram still
 * loading (a local image is read through Rust, so it shows "Loading x…"
 * first; a Mermaid diagram renders once mermaid has loaded), or after
 * `timeoutMs`, whichever comes first. An export taken while one was
 * loading used to contain the placeholder text instead of the image, and
 * an empty block instead of the diagram (an export from the palette in
 * Edit view switches to Read view just before, so every diagram was still
 * rendering).
 */
export function waitForRenderedImages(timeoutMs = EXPORT_IMAGE_WAIT_MS): Promise<void> {
  const loading = () =>
    document.querySelector(
      ".markdown-body .wikiembed--loading, .markdown-body .mermaid-block--loading",
    ) !== null;
  if (!loading()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(() => {
      if (!loading()) done();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    const timer = setTimeout(done, timeoutMs);
  });
}

/**
 * Reads the live `.markdown-body` element and returns its `outerHTML`.
 * Throws a descriptive string (shown in the dialog) when the element is
 * absent — this happens when the user is in Edit or Source view.
 */
function captureMarkdownBody(): string {
  return captureMarkdownElement().outerHTML;
}

/** {@link captureMarkdownBody} as an element (a detached copy). */
function captureMarkdownElement(): Element {
  const el = document.querySelector(".markdown-body");
  if (!el) {
    throw READ_VIEW_REQUIRED;
  }
  return cloneWithoutInjectedChrome(el);
}

/**
 * An exported page runs no script: the body is sanitized already, and this
 * also stops anything that slips through (a template's CSS, say) when the
 * file is opened in a browser. Images, styles and fonts stay unrestricted.
 */
const EXPORT_CSP_META = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" />`;

/**
 * Text for the inside of a `<style>` element: a `</style` would end the
 * element early and let the rest parse as markup. `<\/style` reads the same
 * inside a CSS string and is inert elsewhere.
 */
function styleElementText(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

/** Text for the inside of a CSS comment, which a `*\/` would end. */
function cssCommentText(text: string): string {
  return escapeHtml(text).replace(/\*\//g, "* /");
}

/**
 * Build a standalone, offline HTML document that faithfully reproduces the
 * current rendered view including:
 *   • Theme tokens (paper / sepia / midnight)
 *   • Markdown typography
 *   • Shiki syntax-highlighted code (inline CSS vars are already baked into
 *     the captured outerHTML; the dual-theme rules from markdown.css travel
 *     with the inlined CSS)
 *   • Mermaid diagrams (already rendered to inline <svg> in the DOM)
 *   • KaTeX math (rendered HTML + inlined CSS)
 *
 * `@media print` rules inside the document enable clean pagination when the
 * HTML is printed (used by the PDF path).
 *
 * When `template` is provided its CSS is appended after the base styles,
 * giving it the highest cascade priority (template CSS > KaTeX > markdown >
 * theme tokens > reset).  This lets template authors override anything without
 * needing `!important`.
 */
export function buildStandaloneHtml(
  title: string,
  template?: ExportTemplate | null,
): string {
  const bodyHtml = captureMarkdownBody(); // throws if not in read view
  const theme = currentTheme();
  const layoutVars = currentLayoutVars();

  // Template CSS block — only emitted when a template is active.
  const templateBlock = template?.css
    ? `\n/* ── Export template: ${cssCommentText(template.name)} ── */\n${styleElementText(template.css)}\n`
    : "";

  return `<!doctype html>
<html lang="${escapeHtml(openDocumentLang())}" data-theme="${theme}"${template ? ` data-export-template="${escapeHtml(template.id)}"` : ""}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
${EXPORT_CSP_META}
<title>${escapeHtml(title)}</title>
<style>
/* ── Reset ── */
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}

/* ── Layout vars overridden per-export ── */
:root{${layoutVars}}

/* ── Themes (paper / sepia / midnight tokens) ── */
${themesCss}

/* ── Markdown typography ── */
${markdownCss}

/* ── KaTeX ── */
${katexCssForExport(katexCss, katexFonts, usedKatexFaces())}

/* ── Page shell ── */
body{
  background:var(--bg);
  color:var(--text);
  font-family:var(--content-font);
  -webkit-font-smoothing:antialiased;
}
.reading-surface{
  max-width:var(--content-width);
  margin:0 auto;
  padding:40px 32px 80px;
}

/* ── Print / PDF ── */
@media print{
  body{background:#fff;color:#000}
  .reading-surface{max-width:100%;padding:0}
  /* Avoid breaking inside code blocks, blockquotes, and figures */
  pre,blockquote,figure,table,img,.mermaid-block{
    break-inside:avoid;
    page-break-inside:avoid;
  }
  h1,h2,h3,h4,h5,h6{
    break-after:avoid;
    page-break-after:avoid;
  }
  a{color:inherit;text-decoration:none}
  /* Hide copy buttons that live inside code block headers */
  .copy-btn{display:none}
}
${templateBlock}</style>
</head>
<body>
<article class="reading-surface">
${bodyHtml}
</article>
</body>
</html>`;
}

/**
 * Resolve the active template from the settings store and build the HTML.
 * This is the preferred entry-point when exporting from the UI — it reads
 * the current template selection automatically.
 */
export function buildStandaloneHtmlWithActiveTemplate(title: string): string {
  const { activeTemplateId, userTemplates } = useSettingsStore.getState();
  const template = findTemplate(activeTemplateId, userTemplates) ?? null;
  return buildStandaloneHtml(title, template);
}

/**
 * The title and author an export names: the open document's front matter
 * `title` and `author` (a list of authors joined with ", "), else
 * `fallbackTitle` (its file name) and no author. An EPUB used to say
 * `author: ""` and every export was titled by its file name, whatever the
 * front matter said. The suggested file name stays the file's.
 */
export function exportMetadata(fallbackTitle: string): {
  title: string;
  author: string;
  lang: string;
} {
  const content = useDocumentStore.getState().content ?? "";
  return {
    title: frontmatterText(content, "title") ?? fallbackTitle,
    author: frontmatterText(content, "author") ?? "",
    lang: exportLang(content),
  };
}

/** The language exports name when the front matter names none (or no valid one). */
export const DEFAULT_EXPORT_LANG = "en";

/**
 * `value` as a language tag, when it is one in the shape BCP 47 gives
 * (`en`, `pt-BR`, `zh-Hant-TW`, `sr-Latn`): a primary subtag of 2 to 8
 * letters, then subtags of 1 to 8 letters and digits, joined by hyphens, at
 * most 35 characters. `en_US` reads as `en-US`. Anything else (a sentence,
 * markup, quotes) is null: it is written into an attribute.
 */
export function languageTag(value: string | null | undefined): string | null {
  if (value == null) return null;
  const tag = value.trim().replace(/_/g, "-");
  if (tag.length === 0 || tag.length > 35) return null;
  return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag) ? tag : null;
}

/**
 * The language of the document's export: its front matter `lang` (as
 * Pandoc and most static site generators read it), else
 * {@link DEFAULT_EXPORT_LANG}. Every export said `lang="en"`, so a screen
 * reader read a French document with English rules, and a browser offered
 * to translate it from English.
 */
export function exportLang(content: string): string {
  return languageTag(frontmatterText(content, "lang")) ?? DEFAULT_EXPORT_LANG;
}

/** {@link exportLang} of the open document. */
function openDocumentLang(): string {
  return exportLang(useDocumentStore.getState().content ?? "");
}

/** Minimal HTML-entity escaping for the document title. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── export functions ────────────────────────────────────────────────────────

/**
 * Export as a self-contained HTML file, written as UTF-8 through
 * `write_file_bytes` like every export, which refuses a symbolic link (as
 * the headless path does) and an Obsidian config folder. It used to go
 * through `write_markdown_file`, which saves a linked document into the
 * file the link points to, so an export over a `report.html` linked to
 * `~/.bashrc` replaced the shell profile. Like the DOCX, EPUB and profile
 * exports, it resolves true once the file is written and false when the
 * save dialog was cancelled (the Export dialog said "exported" for both).
 */
export async function exportHtml(
  title: string,
  outputPath?: string,
  opts: WriteOptions = {},
): Promise<boolean> {
  await waitForRenderedImages();
  await fontsForMath();
  // throws if not in read view
  const html = buildStandaloneHtmlWithActiveTemplate(exportMetadata(title).title);

  // An agent-supplied destination (MCP `export` with `output_path`) skips the dialog.
  const dest = await exportDestination(outputPath, opts, title, "html", "HTML");
  if (!dest) return false; // user cancelled — no toast
  const { path } = dest;

  try {
    await writeExportBytes(path, new TextEncoder().encode(html), dest.opts);
  } catch (e) {
    toast.error(`Export failed: ${errMsg(e)}`);
    throw new ShownExportError(errMsg(e));
  }
  toast.success(`Exported to ${baseName(path)}`);
  return true;
}

/**
 * Export as a DOCX file.
 *
 * Requires `html-to-docx` to be installed:
 *   bun add html-to-docx
 *   bun add -D @types/html-to-docx   (if a community types package exists)
 *
 * `html-to-docx` accepts the body HTML (not the full document) plus options,
 * and returns a Blob.  We convert that to Uint8Array and write via the Rust
 * `write_file_bytes` command for an atomic save.
 */
export async function exportDocx(
  title: string,
  outputPath?: string,
  opts: WriteOptions = {},
): Promise<boolean> {
  await waitForRenderedImages();
  const bodyHtml = captureMarkdownBody(); // throws if not in read view

  // Dynamic import so the rest of the app loads even if html-to-docx is absent.
  let HTMLtoDOCX: (
    html: string,
    _headerHtml: null,
    opts: Record<string, unknown>,
  ) => Promise<Blob | ArrayBuffer>;
  try {
    const mod = await import("html-to-docx");
    // The package ships a default export; handle both CJS interop shapes.
    HTMLtoDOCX = (mod.default ?? mod) as typeof HTMLtoDOCX;
  } catch {
    throw "html-to-docx is not installed. Run: bun add html-to-docx";
  }

  const dest = await exportDestination(
    outputPath,
    opts,
    title,
    "docx",
    "Word Document",
  );
  if (!dest) return false; // user cancelled — no toast
  const { path } = dest;

  const meta = exportMetadata(title);
  const result = await HTMLtoDOCX(bodyHtml, null, {
    title: meta.title,
    ...(meta.author ? { creator: meta.author } : {}),
    // The document's language (front matter `lang`), for Word's proofing.
    lang: meta.lang,
    // Margins in twips (1 inch = 1440 twips).
    margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
    // Embed a minimal set of font hints so Word renders reasonably.
    font: "Calibri",
    fontSize: 24, // half-points → 12 pt
  });

  // Normalise to Uint8Array regardless of whether we got a Blob or ArrayBuffer.
  let bytes: Uint8Array;
  if (result instanceof Blob) {
    bytes = new Uint8Array(await result.arrayBuffer());
  } else {
    bytes = new Uint8Array(result);
  }

  try {
    await writeExportBytes(path, bytes, dest.opts);
  } catch (e) {
    toast.error(`Export failed: ${errMsg(e)}`);
    throw new ShownExportError(errMsg(e));
  }
  toast.success(`Exported to ${baseName(path)}`);
  return true;
}

/**
 * Export as PDF via the OS print dialog.
 *
 * Strategy: inject a hidden <iframe>, write the standalone HTML into it,
 * then call `iframe.contentWindow.print()`.  This way only the document
 * content goes to the printer/PDF-writer — the Tauri app chrome is excluded.
 * The `@media print` rules inside the standalone HTML handle pagination.
 *
 * Note: on macOS the system print dialog has a "Save as PDF" option; on
 * Windows/Linux the user can choose a PDF printer.  We do not need a
 * headless renderer.
 *
 * No file-save dialog is shown because the OS print dialog already offers
 * destination selection (including "Save as PDF").
 */
export async function exportPdf(_title: string): Promise<void> {
  await waitForRenderedImages();
  await fontsForMath();
  // throws if not in read view
  const html = buildStandaloneHtmlWithActiveTemplate(exportMetadata(_title).title);

  return new Promise<void>((resolve, reject) => {
    const iframe = document.createElement("iframe");
    // Keep it visually hidden but in the DOM — display:none blocks printing
    // in some browsers; use an off-screen position instead.
    Object.assign(iframe.style, {
      position: "fixed",
      top: "-9999px",
      left: "-9999px",
      width: "1px",
      height: "1px",
      border: "none",
      visibility: "hidden",
    });

    iframe.onload = () => {
      try {
        // Wait one tick for the frame to lay out, then for its fonts.
        setTimeout(async () => {
          await framesFontsLoaded(iframe.contentDocument);
          try {
            iframe.contentWindow?.print();
            toast.success("Opened print dialog");
            // Clean up after a short delay so the print dialog has time to
            // open before we remove the iframe.
            setTimeout(() => {
              iframe.remove();
              resolve();
            }, 1000);
          } catch (e) {
            iframe.remove();
            reject(String(e));
          }
        }, 150);
      } catch (e) {
        iframe.remove();
        reject(String(e));
      }
    };

    iframe.onerror = () => {
      iframe.remove();
      reject("Failed to create print frame.");
    };

    document.body.appendChild(iframe);

    // Write the full standalone document into the iframe.
    const doc = iframe.contentDocument ?? iframe.contentWindow?.document;
    if (!doc) {
      iframe.remove();
      reject("Could not access print frame document.");
      return;
    }
    doc.open();
    doc.write(html);
    doc.close();
  });
}

/** How long the PDF's print frame waits for its fonts before printing. */
export const PRINT_FONT_WAIT_MS = 3000;

/**
 * Resolves once `doc`'s fonts have loaded (KaTeX's, which a page with math
 * carries as `data:` URLs and the browser decodes as it lays the page out),
 * or after {@link PRINT_FONT_WAIT_MS}. The frame was printed 150 ms after it
 * loaded, whatever was still loading, so the PDF's math could come out in
 * fallback fonts.
 */
function framesFontsLoaded(doc: Document | null): Promise<void> {
  const ready = doc?.fonts?.ready;
  if (!ready) return Promise.resolve();
  return Promise.race([
    ready.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((r) => setTimeout(r, PRINT_FONT_WAIT_MS)),
  ]);
}

// ─── buildEpubChapters ────────────────────────────────────────────────────────

/**
 * A single chapter for an EPUB book.
 * Maps directly to the `Chapter` type expected by `epub-gen-memory`.
 */
export interface EpubChapter {
  /** Chapter title shown in the EPUB Table of Contents. */
  title: string;
  /** HTML body content for this chapter (full HTML fragment, not a document). */
  content: string;
}

/**
 * Split a rendered HTML body into EPUB chapters using H1/H2 headings as
 * chapter boundaries.  Each heading starts a new chapter; the title is the
 * heading's text content.
 *
 * Rules:
 *  - H1 headings always start a new chapter.
 *  - H2 headings start a new chapter only when no H1 headings exist in the
 *    document (i.e. the document uses H2 as the top-level heading).
 *  - Content before the first heading is collected into a preamble chapter
 *    titled "Introduction" (only emitted when non-empty after trimming).
 *  - When the body has NO headings, the entire content becomes a single
 *    chapter whose title matches the book title.
 *
 * @param bodyHtml  The inner HTML of `.markdown-body` (not a full document).
 * @param title     Fallback title used when no headings exist.
 * @returns         Array of EpubChapter objects, at least one entry.
 */
export function buildEpubChapters(bodyHtml: string, title: string): EpubChapter[] {
  // Parse the body HTML into a DOM fragment so we can walk the tree.
  const container = document.createElement("div");
  container.innerHTML = bodyHtml;

  const children = Array.from(container.children);
  if (children.length === 0) {
    return [{ title, content: "" }];
  }

  // Determine split level: H1 if any H1 exists, otherwise H2.
  const hasH1 = children.some((el) => el.tagName === "H1");
  const splitTag = hasH1 ? "H1" : "H2";

  // Check if any split-level headings exist at all.
  const hasSplitHeadings = children.some((el) => el.tagName === splitTag);
  if (!hasSplitHeadings) {
    // No headings — single chapter with the full content.
    return [{ title, content: bodyHtml }];
  }

  const chapters: EpubChapter[] = [];
  let currentTitle = "Introduction";
  let currentNodes: Element[] = [];

  for (const el of children) {
    if (el.tagName === splitTag) {
      // Flush the accumulated nodes as a chapter (skip empty preamble).
      if (currentNodes.length > 0) {
        const html = currentNodes.map((n) => n.outerHTML).join("\n");
        chapters.push({ title: currentTitle, content: html });
      }
      currentTitle = (el.textContent ?? "").trim() || title;
      currentNodes = [];
    } else {
      currentNodes.push(el);
    }
  }

  // Flush the last chapter.
  chapters.push({
    title: currentTitle,
    content: currentNodes.map((n) => n.outerHTML).join("\n"),
  });

  return chapters.length > 0 ? chapters : [{ title, content: bodyHtml }];
}

// ─── EPUB images ─────────────────────────────────────────────────────────────

/** Where an EPUB's images are named for epub-gen-memory, which fetches them. */
const EPUB_IMAGE_ORIGIN = "https://ashlr-md.invalid/";

const EPUB_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

/** The bytes of a `data:image/...` URL, or null for any other URL or type. */
function dataUrlImage(src: string): { type: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/is.exec(src.trim());
  if (!m) return null;
  const type = m[1].toLowerCase();
  if (!EPUB_IMAGE_TYPES[type]) return null;
  try {
    if (/;base64$/i.test(m[2])) {
      const bin = atob(m[3].replace(/\s+/g, ""));
      return { type, bytes: Uint8Array.from(bin, (c) => c.charCodeAt(0)) };
    }
    return { type, bytes: new TextEncoder().encode(decodeURIComponent(m[3])) };
  } catch {
    return null;
  }
}

/**
 * Gets a rendered body's images ready for epub-gen-memory. The library
 * fetches every `<img src>`, and the app's CSP (`connect-src`) refuses a
 * `data:` URL and the web alike, so one image failed the whole export; it
 * also takes the media type from the URL's extension, which a `data:` URL
 * has none of. A local image is a `data:` URL in the rendered view
 * (`read_image_data_url`), so each one gets a placeholder URL with the right
 * extension and its bytes are served from the returned map
 * (`withEpubImages`). A web image becomes a link to it, as an e-reader shows
 * no remote image, and anything else becomes its alt text.
 */
export function prepareEpubImages(bodyHtml: string): {
  html: string;
  images: Map<string, Blob>;
} {
  const tpl = document.createElement("template");
  tpl.innerHTML = bodyHtml;
  const images = new Map<string, Blob>();
  const bySrc = new Map<string, string>();
  for (const img of Array.from(tpl.content.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    img.removeAttribute("srcset");
    const known = bySrc.get(src);
    if (known) {
      img.setAttribute("src", known);
      continue;
    }
    const data = dataUrlImage(src);
    if (data) {
      const url = `${EPUB_IMAGE_ORIGIN}image-${images.size + 1}.${EPUB_IMAGE_TYPES[data.type]}`;
      images.set(url, new Blob([data.bytes], { type: data.type }));
      bySrc.set(src, url);
      img.setAttribute("src", url);
      continue;
    }
    const alt = img.getAttribute("alt") ?? "";
    if (/^https?:\/\//i.test(src)) {
      const a = document.createElement("a");
      a.setAttribute("href", src);
      a.textContent = alt || src;
      img.replaceWith(a);
    } else {
      img.replaceWith(document.createTextNode(alt));
    }
  }
  return { html: tpl.innerHTML, images };
}

/**
 * Runs `fn` with `fetch` answering the URLs in `images` from memory. Every
 * other request goes to the real `fetch`, and it is restored afterwards.
 */
async function withEpubImages<T>(
  images: Map<string, Blob>,
  fn: () => Promise<T>,
): Promise<T> {
  if (images.size === 0) return fn();
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const blob = images.get(url);
    return blob ? Promise.resolve(new Response(blob)) : realFetch(input, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/**
 * Export as an EPUB file.
 *
 * Uses `epub-gen-memory` (MIT) to produce a fully self-contained EPUB 3
 * archive client-side — no server round-trip needed.
 *
 * Features:
 *  - Automatic Table of Contents derived from H1/H2 headings in the document.
 *  - Theme-aware chapter CSS (paper / sepia / midnight CSS vars translated to
 *    portable EPUB-compatible inline styles).
 *  - Embedded images: any <img> with a data URI src is included in the EPUB
 *    asset list so readers can display them offline.
 *  - Code blocks with Shiki-generated syntax highlighting are preserved via
 *    inline `style` attributes already present in the captured HTML.
 *  - The resulting bytes are written via the Rust `write_file_bytes` command
 *    for an atomic save (same path as DOCX export).
 *
 * Requires: `epub-gen-memory` must be installed (`bun add epub-gen-memory`).
 * The import is dynamic so the rest of the app loads even if it is absent.
 */
export async function exportEpub(
  title: string,
  outputPath?: string,
  opts: WriteOptions = {},
): Promise<boolean> {
  await waitForRenderedImages();
  // captureMarkdownBody() returns outerHTML of .markdown-body; for EPUB
  // chapter splitting we need only the inner content so headings are top-level
  // children of the parse container.
  const el = document.querySelector(".markdown-body");
  if (!el) {
    throw READ_VIEW_REQUIRED;
  }
  const { html: bodyHtml, images } = prepareEpubImages(
    cloneWithoutInjectedChrome(el).innerHTML,
  );

  let epubGen: (
    options: Record<string, unknown>,
    content: EpubChapter[],
  ) => Promise<Blob | ArrayBuffer>;

  try {
    const mod = await import("epub-gen-memory");
    epubGen = (mod.default ?? mod) as unknown as typeof epubGen;
  } catch {
    throw "epub-gen-memory is not installed. Run: bun add epub-gen-memory";
  }

  const dest = await exportDestination(outputPath, opts, title, "epub", "EPUB eBook");
  if (!dest) return false; // user cancelled — no toast
  const { path } = dest;

  const theme = currentTheme();
  const css = buildEpubThemeCss(theme);
  const meta = exportMetadata(title);
  const chapters = buildEpubChapters(bodyHtml, meta.title);

  const result = await withEpubImages(images, () =>
    epubGen(
      {
        title: meta.title,
        // The front matter's `author`, else none.
        author: meta.author,
        // The front matter's `lang`, else "en" (the library's default was "en").
        lang: meta.lang,
        // Use the theme-aware chapter CSS as the stylesheet.
        css,
        // EPUB 3 for widest modern reader support.
        version: 3,
        // Suppress verbose internal logging in production.
        verbose: false,
      },
      chapters,
    ),
  );

  // Normalise to Uint8Array regardless of whether we got a Blob or ArrayBuffer.
  let bytes: Uint8Array;
  if (result instanceof Blob) {
    bytes = new Uint8Array(await result.arrayBuffer());
  } else {
    bytes = new Uint8Array(result as ArrayBuffer);
  }

  try {
    await writeExportBytes(path, bytes, dest.opts);
  } catch (e) {
    toast.error(`Export failed: ${errMsg(e)}`);
    throw new ShownExportError(errMsg(e));
  }
  toast.success(`Exported to ${baseName(path)}`);
  return true;
}

// ─── buildExportHtml ─────────────────────────────────────────────────────────

/**
 * Build format-optimised HTML for a named export profile.
 *
 * Supported profiles:
 *   - `"notion-html"` — clean semantic HTML, no absolute positioning, max-width
 *     900px, simplified table handling, optimised for pasting into Notion.
 *   - `"slack-html"`  — constrained to ~520px (Slack thread width), Markdown-
 *     friendly inline formatting preserved, link hrefs appended as text.
 *   - `"email-html"`  — fully inlined CSS on every element, responsive via
 *     media queries, dark-mode fallback, data URI image embedding supported.
 *
 * @param profileId  One of the profile id strings from EXPORT_PROFILES.
 * @param content    Optional raw HTML body fragment to render.  When omitted
 *                   the live `.markdown-body` DOM element is captured (throws
 *                   if not in Read view).
 * @param title      The document's `<title>`, when given.
 * @returns          A complete, standalone HTML document string.
 */
export function buildExportHtml(
  profileId: ExportProfileId,
  content?: string,
  title?: string,
): string {
  const profile = findProfile(profileId);
  if (!profile) {
    throw `Unknown export profile: "${profileId}"`;
  }

  // Capture body HTML — either from caller or from the live DOM.
  const bodyHtml = content ?? captureMarkdownBody();

  const theme = currentTheme();
  const layoutVars = currentLayoutVars();

  // For email-html we inline CSS onto elements rather than relying on a <style>
  // block (many email clients strip <style>).  We do a best-effort inline pass
  // for the most impactful properties.
  const processedBody =
    profileId === "email-html" ? inlineEmailStyles(bodyHtml) : bodyHtml;

  return `<!doctype html>
<html lang="${escapeHtml(openDocumentLang())}" data-theme="${theme}" data-export-profile="${escapeHtml(profileId)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
${EXPORT_CSP_META}
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
${title === undefined ? "" : `<title>${escapeHtml(title)}</title>\n`}<style>
/* ── Reset ── */
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}

/* ── Layout vars ── */
:root{${layoutVars}}

/* ── Themes (paper/sepia/midnight tokens) ── */
${themesCss}

/* ── Markdown typography ── */
${markdownCss}

/* ── KaTeX ── */
${katexCssForExport(katexCss, katexFonts, content === undefined ? usedKatexFaces() : null)}

/* ── Export profile: ${escapeHtml(profile.name)} ── */
${profile.css}
</style>
</head>
<body>
<article class="reading-surface">
${processedBody}
</article>
</body>
</html>`;
}

/**
 * Best-effort inline CSS pass for email-html profile.
 *
 * Email clients like Outlook strip or ignore <style> blocks, so the most
 * critical layout properties must live directly on HTML elements.  This
 * function applies inline style strings to common block elements.
 *
 * This is intentionally conservative — it only touches elements that widely
 * used email clients are known to reset: headings, paragraphs, links, tables.
 * It does NOT attempt to replicate the full cascade (that would require a real
 * CSS parser + CSSOM).
 *
 * An element that has a `style` (a Shiki code block, raw HTML) or a table
 * that has a `class` gets these merged into it: they used to be added as a
 * second attribute, which browsers drop, so the email lost them.
 */
function inlineEmailStyles(html: string): string {
  // Tables: add the class for the email profile table rules + a
  // cellpadding/spacing reset. A table with a class of its own keeps it.
  let out = html.replace(
    openingTag("table", false),
    (tag, attrs: string, close: string) => {
      const cls = attributeValue(attrs, "class");
      if (cls?.value.split(/\s+/).includes("content-table")) return tag;
      const classed = cls
        ? replaceAttribute(attrs, cls, "class", `content-table ${cls.value.trim()}`)
        : attrs;
      const added = cls ? "" : ' class="content-table"';
      const reset = /\scellpadding\s*=/i.test(attrs)
        ? ""
        : ' cellpadding="0" cellspacing="0"';
      return `<table${added}${reset}${classed}${close}>`;
    },
  );
  for (const { tag, css, withAttributes } of EMAIL_INLINE_STYLES) {
    const styled = (html: string, css: string) =>
      html.replace(
        openingTag(tag, withAttributes ?? false),
        (_, attrs: string, close: string) => {
          const style = attributeValue(attrs, "style");
          // The element's own style comes after, so it still wins where both
          // set a property (a Shiki block's colours, an image's width).
          const merged = style
            ? replaceAttribute(attrs, style, "style", `${css}${style.value.trim()}`)
            : ` style="${css}"${attrs}`;
          return `<${tag}${merged}${close}>`;
        },
      );
    // The `<code>` of a code block is reset, as the stylesheet's `pre code`
    // rule says: the inline-code style (pink text on a grey box with a
    // border) used to land on it too, and an inline style beats the rule.
    out =
      tag === "code"
        ? out.replace(
            /(<pre\b[\s\S]*?<\/pre\s*>)|[\s\S]+?(?=<pre\b|$)/gi,
            (part, pre?: string) =>
              styled(part, pre === undefined ? css : EMAIL_PRE_CODE_CSS),
          )
        : styled(out, css);
  }
  return out;
}

/** The inline style of a `<code>` inside a `<pre>` in an email export. */
const EMAIL_PRE_CODE_CSS =
  "font-family:inherit;font-size:inherit;background:none;border:none;border-radius:0;padding:0;color:inherit;";

/**
 * The inline styles {@link inlineEmailStyles} gives each element, in order;
 * `withAttributes`: only an element that has an attribute (a link with its
 * `href`, an image with its `src`).
 */
const EMAIL_INLINE_STYLES: readonly {
  tag: string;
  css: string;
  withAttributes?: boolean;
}[] = [
  {
    tag: "h1",
    css: "font-size:28px;font-weight:700;color:#111111;margin:0 0 16px;line-height:1.2;",
  },
  {
    tag: "h2",
    css: "font-size:22px;font-weight:700;color:#222222;margin:24px 0 12px;border-bottom:2px solid #eeeeee;padding-bottom:6px;",
  },
  { tag: "h3", css: "font-size:18px;font-weight:600;color:#333333;margin:20px 0 8px;" },
  { tag: "h4", css: "font-size:16px;font-weight:600;color:#444444;margin:16px 0 6px;" },
  { tag: "h5", css: "font-size:16px;font-weight:600;color:#444444;margin:16px 0 6px;" },
  { tag: "h6", css: "font-size:16px;font-weight:600;color:#444444;margin:16px 0 6px;" },
  { tag: "p", css: "margin:0 0 16px;color:#333333;font-size:16px;line-height:1.6;" },
  { tag: "a", css: "color:#0066cc;text-decoration:underline;", withAttributes: true },
  {
    tag: "code",
    css: "font-family:'Courier New',Courier,monospace;font-size:14px;background-color:#f5f5f5;border:1px solid #e0e0e0;border-radius:3px;padding:2px 5px;color:#c7254e;",
  },
  {
    tag: "pre",
    css: "background-color:#f8f8f8;border:1px solid #e0e0e0;border-radius:4px;padding:16px;overflow-x:auto;margin:0 0 16px;font-family:'Courier New',Courier,monospace;font-size:13px;line-height:1.5;",
  },
  {
    tag: "blockquote",
    css: "border-left:4px solid #cccccc;margin:0 0 16px;padding:8px 16px;color:#666666;font-style:italic;background-color:#fafafa;",
  },
  {
    tag: "img",
    css: "max-width:100%;height:auto;display:block;margin:0 0 16px;",
    withAttributes: true,
  },
];

/** One attribute of an HTML start tag, with or without a value. */
const TAG_ATTRIBUTE = String.raw`[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?`;

/**
 * Start tags `<tag ...>` of `tag` (any case): group 1 is the attributes,
 * with their leading space, group 2 a self-closing `/`. With `withAttributes`,
 * only a tag that has one.
 */
function openingTag(tag: string, withAttributes: boolean): RegExp {
  return new RegExp(
    `<${tag}((?:\\s+${TAG_ATTRIBUTE})${withAttributes ? "+" : "*"})\\s*(/?)>`,
    "gi",
  );
}

/** An attribute found in a start tag's attributes. */
interface FoundAttribute {
  /** Where it starts (at its leading space) and ends in the attributes. */
  start: number;
  end: number;
  value: string;
}

/** The first `name` attribute in `attrs` (a start tag's attributes), its value decoded of `&quot;`. */
function attributeValue(attrs: string, name: string): FoundAttribute | null {
  const re = new RegExp(String.raw`\s+(${TAG_ATTRIBUTE})`, "gy");
  for (let m = re.exec(attrs); m; m = re.exec(attrs)) {
    const eq = m[1].indexOf("=");
    const key = (eq === -1 ? m[1] : m[1].slice(0, eq)).trim().toLowerCase();
    if (key !== name) continue;
    let value = eq === -1 ? "" : m[1].slice(eq + 1).trim();
    if (/^(["']).*\1$/s.test(value)) value = value.slice(1, -1);
    return {
      start: m.index,
      end: re.lastIndex,
      value: value.replaceAll("&quot;", '"'),
    };
  }
  return null;
}

/** `attrs` with `found` replaced by `name="value"`, where it was. */
function replaceAttribute(
  attrs: string,
  found: FoundAttribute,
  name: string,
  value: string,
): string {
  return `${attrs.slice(0, found.start)} ${name}="${value.replaceAll('"', "&quot;")}"${attrs.slice(found.end)}`;
}

/**
 * Export a document using a named format profile.
 *
 * Triggers a native save dialog with the profile's recommended extension
 * (`.html` for Notion/Email, `.txt` for Slack). The Slack file is Slack
 * mrkdwn text ({@link slackMrkdwn}); every other profile is an HTML page.
 *
 * @param profileId  The profile to use — one of `"notion-html"`, `"slack-html"`,
 *                   `"email-html"`.
 * @param title      Document title used for the default save filename.
 */
export async function exportWithProfile(
  profileId: ExportProfileId,
  title: string,
): Promise<boolean> {
  const profile = findProfile(profileId);
  if (!profile) throw `Unknown export profile: "${profileId}"`;
  await waitForRenderedImages();
  await fontsForMath();

  // A text profile (Slack) is the text it promises, not a page: the Slack
  // .txt used to hold a whole HTML document, which pasted as markup.
  // Either throws if not in Read view.
  const content =
    profile.extension === "txt"
      ? slackMrkdwn(captureMarkdownElement())
      : buildExportHtml(profileId, undefined, exportMetadata(title).title);

  const ext = profile.extension;
  const filterName = ext === "txt" ? "Text / Markdown" : "HTML Document";

  const dest = await exportDestination(undefined, {}, title, ext, filterName);
  if (!dest) return false; // user cancelled — no toast
  const { path } = dest;

  try {
    await writeExportBytes(path, new TextEncoder().encode(content), dest.opts);
  } catch (e) {
    toast.error(`Export failed: ${errMsg(e)}`);
    throw new ShownExportError(errMsg(e));
  }
  toast.success(`Exported to ${baseName(path)}`);
  return true;
}

// ─── util ────────────────────────────────────────────────────────────────────

/**
 * Where an export goes: `outputPath` (an agent's, no dialog), else the file
 * picked in the save dialog, offered as `title` with `ext`. A picked name
 * with no extension gets `.ext`: the Linux save dialogs do not add it, so
 * `report` typed there was saved as a file named `report` that no app
 * opened as HTML (or Word, or EPUB). The dialog asked about replacing
 * `report`, not `report.ext`, so that file is written only if it is new.
 * Null when the dialog was cancelled.
 */
async function exportDestination(
  outputPath: string | undefined,
  opts: WriteOptions,
  title: string,
  ext: string,
  filterName: string,
): Promise<{ path: string; opts: WriteOptions } | null> {
  if (outputPath) return { path: outputPath, opts };
  const picked = await save({
    defaultPath: `${sanitizeFileName(title)}.${ext}`,
    filters: [{ name: filterName, extensions: [ext] }],
  });
  if (!picked) return null;
  const named = withExtension(picked, ext);
  return named === picked
    ? { path: picked, opts }
    : { path: named, opts: { ...opts, newFile: true } };
}

/** `path`, with `.ext` added when its file name has no extension. */
export function withExtension(path: string, ext: string): string {
  const name = baseName(path);
  return /[^.]\.[^.]+$/.test(name) ? path : `${path}.${ext}`;
}

/**
 * Write `bytes` to `path` through `write_file_bytes` (src-tauri/src/export.rs):
 * the bytes are the request's raw body and the path a percent-encoded
 * header. They used to cross the IPC as a JSON array of numbers
 * (`Array.from(bytes)`), about 3.6 bytes of JSON per byte, built and parsed
 * on both sides: a 32 MiB EPUB sent 114 MiB of JSON.
 */
export interface WriteOptions {
  /**
   * Refuse a file already at the path, in the write itself (the Rust side
   * publishes a temp file with a hard link), so nothing there is replaced.
   */
  newFile?: boolean;
}

export async function writeExportBytes(
  path: string,
  bytes: Uint8Array,
  opts: WriteOptions = {},
): Promise<void> {
  const headers: Record<string, string> = { "x-export-path": encodeURIComponent(path) };
  if (opts.newFile) headers["x-export-new"] = "1";
  await invoke("write_file_bytes", bytes, { headers });
}

/** Normalise an unknown error into a user-readable string. */
function errMsg(e: unknown): string {
  return typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
}

/** Basename of a saved path for the "Exported to …" toast. */
function baseName(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx === -1 ? p : p.slice(idx + 1);
}

/** Names Windows reserves for devices, whatever the extension. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * The default file name of an export for a document titled `name`: no
 * characters a file name cannot hold (`/\\:*?"<>|` and control
 * characters), spaces as hyphens, no leading dot (a hidden file) and no
 * trailing dot, at most 80 characters, and never a Windows device name.
 * The cut used to count UTF-16 units, so a title with emoji or other
 * characters past U+FFFF could end in half a character, which the save
 * dialog's IPC refused, failing the export; a title like `.env` named a
 * hidden `.env.html`.
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/\s+/g, "-")
    .replace(/[/\\:*?"<>|\p{Cc}]/gu, "")
    .replace(/^[.-]+/, "");
  const cut = Array.from(cleaned)
    .slice(0, 80)
    .join("")
    .replace(/[.\s]+$/, "");
  if (cut === "") return "export";
  return RESERVED_NAME.test(cut) ? `${cut}-export` : cut;
}
