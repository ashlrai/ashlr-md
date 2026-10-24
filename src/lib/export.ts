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
import { READ_VIEW_REQUIRED } from "./exportErrors";
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
  return clone;
}

/** How long an export waits for the read view's images and embeds to load. */
export const EXPORT_IMAGE_WAIT_MS = 5000;

/**
 * Resolves once the read view shows no image or embed still loading (a
 * local image is read through Rust, so it shows "Loading x…" first), or
 * after `timeoutMs`, whichever comes first. An export taken while one was
 * loading used to contain the placeholder text instead of the image.
 */
export function waitForRenderedImages(timeoutMs = EXPORT_IMAGE_WAIT_MS): Promise<void> {
  const loading = () =>
    document.querySelector(".markdown-body .wikiembed--loading") !== null;
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
<html lang="en" data-theme="${theme}"${template ? ` data-export-template="${escapeHtml(template.id)}"` : ""}>
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
${katexCss}

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
} {
  const content = useDocumentStore.getState().content ?? "";
  return {
    title: frontmatterText(content, "title") ?? fallbackTitle,
    author: frontmatterText(content, "author") ?? "",
  };
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
 * `~/.bashrc` replaced the shell profile.
 */
export async function exportHtml(title: string, outputPath?: string): Promise<void> {
  await waitForRenderedImages();
  // throws if not in read view
  const html = buildStandaloneHtmlWithActiveTemplate(exportMetadata(title).title);

  // An agent-supplied destination (MCP `export` with `output_path`) skips the dialog.
  const path =
    outputPath ??
    (await save({
      defaultPath: `${sanitizeFileName(title)}.html`,
      filters: [{ name: "HTML", extensions: ["html"] }],
    }));
  if (!path) return; // user cancelled — no toast

  try {
    await writeExportBytes(path, new TextEncoder().encode(html));
  } catch (e) {
    toast.error(`Export failed: ${errMsg(e)}`);
    throw e;
  }
  toast.success(`Exported to ${baseName(path)}`);
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
export async function exportDocx(title: string, outputPath?: string): Promise<void> {
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

  const path =
    outputPath ??
    (await save({
      defaultPath: `${sanitizeFileName(title)}.docx`,
      filters: [{ name: "Word Document", extensions: ["docx"] }],
    }));
  if (!path) return; // user cancelled — no toast

  const meta = exportMetadata(title);
  const result = await HTMLtoDOCX(bodyHtml, null, {
    title: meta.title,
    ...(meta.author ? { creator: meta.author } : {}),
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
    await writeExportBytes(path, bytes);
  } catch (e) {
    toast.error(`Export failed: ${errMsg(e)}`);
    throw e;
  }
  toast.success(`Exported to ${baseName(path)}`);
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
        // Wait one tick for images/fonts inside the iframe to settle.
        setTimeout(() => {
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
export async function exportEpub(title: string, outputPath?: string): Promise<void> {
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

  const path =
    outputPath ??
    (await save({
      defaultPath: `${sanitizeFileName(title)}.epub`,
      filters: [{ name: "EPUB eBook", extensions: ["epub"] }],
    }));
  if (!path) return; // user cancelled — no toast

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
    await writeExportBytes(path, bytes);
  } catch (e) {
    toast.error(`Export failed: ${errMsg(e)}`);
    throw e;
  }
  toast.success(`Exported to ${baseName(path)}`);
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
<html lang="en" data-theme="${theme}" data-export-profile="${escapeHtml(profileId)}">
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
${katexCss}

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
 */
function inlineEmailStyles(html: string): string {
  // Replace the body fragment via regex-based inline style injection.
  // Order: most specific patterns first.
  return (
    html
      // Tables: add class for the email profile table rules + cellpadding/spacing reset
      .replace(
        /<table(?![^>]*class="content-table")/gi,
        '<table class="content-table" cellpadding="0" cellspacing="0"',
      )
      // Headings
      .replace(
        /<h1(\s|>)/gi,
        '<h1 style="font-size:28px;font-weight:700;color:#111111;margin:0 0 16px;line-height:1.2;"$1',
      )
      .replace(
        /<h2(\s|>)/gi,
        '<h2 style="font-size:22px;font-weight:700;color:#222222;margin:24px 0 12px;border-bottom:2px solid #eeeeee;padding-bottom:6px;"$1',
      )
      .replace(
        /<h3(\s|>)/gi,
        '<h3 style="font-size:18px;font-weight:600;color:#333333;margin:20px 0 8px;"$1',
      )
      .replace(
        /<h4(\s|>)/gi,
        '<h4 style="font-size:16px;font-weight:600;color:#444444;margin:16px 0 6px;"$1',
      )
      .replace(
        /<h5(\s|>)/gi,
        '<h5 style="font-size:16px;font-weight:600;color:#444444;margin:16px 0 6px;"$1',
      )
      .replace(
        /<h6(\s|>)/gi,
        '<h6 style="font-size:16px;font-weight:600;color:#444444;margin:16px 0 6px;"$1',
      )
      // Paragraphs
      .replace(
        /<p(\s|>)/gi,
        '<p style="margin:0 0 16px;color:#333333;font-size:16px;line-height:1.6;"$1',
      )
      // Links
      .replace(/<a(\s)/gi, '<a style="color:#0066cc;text-decoration:underline;"$1')
      // Inline code (not inside pre)
      .replace(
        /<code(\s|>)/gi,
        "<code style=\"font-family:'Courier New',Courier,monospace;font-size:14px;background-color:#f5f5f5;border:1px solid #e0e0e0;border-radius:3px;padding:2px 5px;color:#c7254e;\"$1",
      )
      // Pre blocks (reset code inside pre)
      .replace(
        /<pre(\s|>)/gi,
        "<pre style=\"background-color:#f8f8f8;border:1px solid #e0e0e0;border-radius:4px;padding:16px;overflow-x:auto;margin:0 0 16px;font-family:'Courier New',Courier,monospace;font-size:13px;line-height:1.5;\"$1",
      )
      // Blockquotes
      .replace(
        /<blockquote(\s|>)/gi,
        '<blockquote style="border-left:4px solid #cccccc;margin:0 0 16px;padding:8px 16px;color:#666666;font-style:italic;background-color:#fafafa;"$1',
      )
      // Images — preserve data URIs, add responsive max-width
      .replace(
        /<img(\s)/gi,
        '<img style="max-width:100%;height:auto;display:block;margin:0 0 16px;"$1',
      )
  );
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
): Promise<void> {
  const profile = findProfile(profileId);
  if (!profile) throw `Unknown export profile: "${profileId}"`;
  await waitForRenderedImages();

  // A text profile (Slack) is the text it promises, not a page: the Slack
  // .txt used to hold a whole HTML document, which pasted as markup.
  // Either throws if not in Read view.
  const content =
    profile.extension === "txt"
      ? slackMrkdwn(captureMarkdownElement())
      : buildExportHtml(profileId, undefined, exportMetadata(title).title);

  const ext = profile.extension;
  const filterName = ext === "txt" ? "Text / Markdown" : "HTML Document";

  const path = await save({
    defaultPath: `${sanitizeFileName(title)}.${ext}`,
    filters: [{ name: filterName, extensions: [ext] }],
  });
  if (!path) return; // user cancelled — no toast

  try {
    await writeExportBytes(path, new TextEncoder().encode(content));
  } catch (e) {
    toast.error(`Export failed: ${errMsg(e)}`);
    throw e;
  }
  toast.success(`Exported to ${baseName(path)}`);
}

// ─── util ────────────────────────────────────────────────────────────────────

/**
 * Write `bytes` to `path` through `write_file_bytes` (src-tauri/src/export.rs):
 * the bytes are the request's raw body and the path a percent-encoded
 * header. They used to cross the IPC as a JSON array of numbers
 * (`Array.from(bytes)`), about 3.6 bytes of JSON per byte, built and parsed
 * on both sides: a 32 MiB EPUB sent 114 MiB of JSON.
 */
export async function writeExportBytes(path: string, bytes: Uint8Array): Promise<void> {
  await invoke("write_file_bytes", bytes, {
    headers: { "x-export-path": encodeURIComponent(path) },
  });
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
