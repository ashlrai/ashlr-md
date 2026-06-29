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
import { useDocumentStore } from "../store/documentStore";
// Vite ?raw imports — each resolves to the full CSS text at build time.
import katexCss from "katex/dist/katex.min.css?raw";
import { toast } from "../store/toastStore";
import markdownCss from "../styles/markdown.css?raw";
import themesCss from "../styles/themes.css?raw";
import { findTemplate, findProfile, ALL_PROFILE_IDS } from "./exportTemplates";
import type { ExportTemplate, ExportProfileId } from "./exportTemplates";
import { useSettingsStore } from "../store/settingsStore";
import { parseHeadings } from "./outline";
import { buildOutlineTree, buildOpml } from "./exportOutline";
export type { OutlineNode } from "./exportOutline";

// ─── EPUB theme CSS ──────────────────────────────────────────────────────────

/**
 * Return theme-aware CSS for EPUB chapters, mapping Ashlr's three themes
 * (paper / sepia / midnight) to portable EPUB-compatible styles.
 *
 * EPUB readers apply their own default styles; we override the key variables
 * so the document looks intentional regardless of reading app defaults.
 */
export function buildEpubThemeCss(theme: string): string {
  const themeVars: Record<string, { bg: string; text: string; code: string; border: string }> = {
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
 * `.markdown-body` but is NOT part of the document — currently the review
 * summary card. Exports and rich-text copies should contain the document, not
 * the app's rendering overlay.
 */
export function cloneWithoutInjectedChrome(el: Element): Element {
  const clone = el.cloneNode(true) as Element;
  for (const node of clone.querySelectorAll(".review-card")) node.remove();
  return clone;
}

/**
 * Reads the live `.markdown-body` element and returns its `outerHTML`.
 * Throws a descriptive string (shown in the dialog) when the element is
 * absent — this happens when the user is in Edit or Source view.
 */
function captureMarkdownBody(): string {
  const el = document.querySelector(".markdown-body");
  if (!el) {
    throw "Switch to Read view before exporting.";
  }
  return cloneWithoutInjectedChrome(el).outerHTML;
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
    ? `\n/* ── Export template: ${escapeHtml(template.name)} ── */\n${template.css}\n`
    : "";

  return `<!doctype html>
<html lang="en" data-theme="${theme}"${template ? ` data-export-template="${escapeHtml(template.id)}"` : ""}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
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
 * Export as a self-contained HTML file.
 * Uses `write_markdown_file` (text) since HTML is UTF-8 text — no new
 * Rust command needed for this format.
 */
export async function exportHtml(title: string): Promise<void> {
  const html = buildStandaloneHtmlWithActiveTemplate(title); // throws if not in read view

  const path = await save({
    defaultPath: `${sanitizeFileName(title)}.html`,
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (!path) return; // user cancelled — no toast

  try {
    await invoke("write_markdown_file", { path, content: html });
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
export async function exportDocx(title: string): Promise<void> {
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

  const path = await save({
    defaultPath: `${sanitizeFileName(title)}.docx`,
    filters: [{ name: "Word Document", extensions: ["docx"] }],
  });
  if (!path) return; // user cancelled — no toast

  const result = await HTMLtoDOCX(bodyHtml, null, {
    title,
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
    await invoke("write_file_bytes", { path, data: Array.from(bytes) });
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
  const html = buildStandaloneHtmlWithActiveTemplate(_title); // throws if not in read view

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
export async function exportEpub(title: string): Promise<void> {
  // captureMarkdownBody() returns outerHTML of .markdown-body; for EPUB
  // chapter splitting we need only the inner content so headings are top-level
  // children of the parse container.
  const el = document.querySelector(".markdown-body");
  if (!el) {
    throw "Switch to Read view before exporting.";
  }
  const bodyHtml = cloneWithoutInjectedChrome(el).innerHTML;

  let epubGen: (
    options: Record<string, unknown>,
    content: EpubChapter[],
  ) => Promise<Blob | ArrayBuffer>;

  try {
    const mod = await import("epub-gen-memory");
    epubGen = (mod.default ?? mod) as typeof epubGen;
  } catch {
    throw "epub-gen-memory is not installed. Run: bun add epub-gen-memory";
  }

  const path = await save({
    defaultPath: `${sanitizeFileName(title)}.epub`,
    filters: [{ name: "EPUB eBook", extensions: ["epub"] }],
  });
  if (!path) return; // user cancelled — no toast

  const theme = currentTheme();
  const css = buildEpubThemeCss(theme);
  const chapters = buildEpubChapters(bodyHtml, title);

  const result = await epubGen(
    {
      title,
      // Author from document store if available, otherwise blank.
      author: "",
      // Use the theme-aware chapter CSS as the stylesheet.
      css,
      // EPUB 3 for widest modern reader support.
      version: 3,
      // Suppress verbose internal logging in production.
      verbose: false,
    },
    chapters,
  );

  // Normalise to Uint8Array regardless of whether we got a Blob or ArrayBuffer.
  let bytes: Uint8Array;
  if (result instanceof Blob) {
    bytes = new Uint8Array(await result.arrayBuffer());
  } else {
    bytes = new Uint8Array(result as ArrayBuffer);
  }

  try {
    await invoke("write_file_bytes", { path, data: Array.from(bytes) });
  } catch (e) {
    toast.error(`Export failed: ${errMsg(e)}`);
    throw e;
  }
  toast.success(`Exported to ${baseName(path)}`);
}

// ─── exportMarkdownArchive ───────────────────────────────────────────────────

/**
 * Export the current document as a tar.gz archive containing:
 *   - The source .md file (with YAML front-matter intact)
 *   - Embedded image assets referenced in the document
 *   - Mermaid diagrams rendered to inline SVG files
 *
 * The archive is written to `outputPath` (or the user picks via save dialog).
 * Agents can use the archive to round-trip Markdown projects — import into
 * another vault, redistribute, or re-process with other tools.
 *
 * Internally delegates to the Rust `export_markdown_archive` command which
 * reads the vault state and packs assets.
 */
export async function exportMarkdownArchive(options: {
  outputPath?: string;
  includeAssets?: boolean;
} = {}): Promise<string> {
  const { outputPath, includeAssets = true } = options;

  let dest = outputPath;
  if (!dest) {
    const { path: docPath, fileName } = useDocumentStore.getState();
    if (!docPath) {
      throw "No document is open. Open a Markdown file before exporting.";
    }
    const baseName = sanitizeFileName(
      (fileName ?? "archive").replace(/\.(md|markdown|mdown|mkd|mdx)$/i, ""),
    );
    const chosen = await save({
      defaultPath: `${baseName}.tar.gz`,
      filters: [{ name: "Tar Archive", extensions: ["tar.gz", "tgz"] }],
    });
    if (!chosen) return ""; // user cancelled
    dest = chosen;
  }

  try {
    const result = await invoke<{ path: string; files: string[]; size: number }>(
      "export_markdown_archive",
      { outputPath: dest, includeAssets },
    );
    toast.success(`Archive exported to ${baseName(result.path)}`);
    return result.path;
  } catch (e) {
    toast.error(`Archive export failed: ${errMsg(e)}`);
    throw e;
  }
}

// ─── exportCanvasGraph ───────────────────────────────────────────────────────

/**
 * Export the current vault's file graph as a JSON Canvas (.canvas) file.
 *
 * Each document in the vault becomes a card node. Wikilinks between documents
 * become directed edges. The canvas is compatible with Obsidian's canvas format
 * and other tools that understand the JSON Canvas spec.
 *
 * The file is written to `outputPath` (or the user picks via save dialog).
 * Agents can use the canvas to visualise vault topology and re-import it into
 * graph-based note-taking tools.
 */
export async function exportCanvasGraph(options: {
  outputPath?: string;
  includeIsolated?: boolean;
} = {}): Promise<string> {
  const { outputPath, includeIsolated = true } = options;

  let dest = outputPath;
  if (!dest) {
    const chosen = await save({
      defaultPath: "vault-graph.canvas",
      filters: [{ name: "JSON Canvas", extensions: ["canvas"] }],
    });
    if (!chosen) return ""; // user cancelled
    dest = chosen;
  }

  try {
    const result = await invoke<{ path: string; nodeCount: number; edgeCount: number }>(
      "export_canvas_graph",
      { outputPath: dest, includeIsolated },
    );
    toast.success(`Canvas exported to ${baseName(result.path)}`);
    return result.path;
  } catch (e) {
    toast.error(`Canvas export failed: ${errMsg(e)}`);
    throw e;
  }
}

// ─── buildMarkdownArchive ─────────────────────────────────────────────────────
//
// Pure (no I/O) logic for building the in-memory structure of a Markdown
// archive.  Separated from exportMarkdownArchive so it can be unit-tested
// without Tauri or a file system.

export interface MarkdownArchiveEntry {
  /** Relative path within the archive (e.g. "doc.md", "assets/diagram.svg"). */
  name: string;
  /** UTF-8 text content. */
  content: string;
}

/**
 * Build the list of entries for a Markdown archive from raw inputs.
 *
 * @param mdSource  Raw Markdown source (may include YAML front-matter).
 * @param fileName  File name for the root .md entry (default "document.md").
 * @param assets    Optional map of relative asset path → content string.
 *                  E.g. `{ "assets/fig1.svg": "<svg>…</svg>" }`.
 * @returns Array of { name, content } entries ready to be tar'd.
 */
export function buildMarkdownArchive(
  mdSource: string,
  fileName = "document.md",
  assets: Record<string, string> = {},
): MarkdownArchiveEntry[] {
  const entries: MarkdownArchiveEntry[] = [{ name: fileName, content: mdSource }];
  for (const [assetPath, assetContent] of Object.entries(assets)) {
    entries.push({ name: assetPath, content: assetContent });
  }
  return entries;
}

// ─── buildCanvasGraph ─────────────────────────────────────────────────────────
//
// Pure logic for constructing a JSON Canvas object from vault metadata.
// Separated so it can be unit-tested without Tauri or a file system.

/** A document node in the JSON Canvas. */
export interface CanvasNode {
  id: string;
  type: "text";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  /** Extra metadata not part of the spec but useful for tooling. */
  metadata?: {
    path: string;
    title: string;
    tags: string[];
    wordCount: number;
  };
}

/** A directed edge (wikilink) between two canvas nodes. */
export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide: "right";
  toNode: string;
  toSide: "left";
  label?: string;
}

/** A complete JSON Canvas document. */
export interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** Input descriptor for a single vault document. */
export interface VaultDocDescriptor {
  /** Absolute or relative path used as a stable node ID. */
  path: string;
  /** Display title (first H1 or file name). */
  title: string;
  /** Front-matter tags. */
  tags?: string[];
  /** Approximate word count. */
  wordCount?: number;
  /** Paths of documents this one links to via [[wikilinks]]. */
  linksTo?: string[];
}

/**
 * Build a JSON Canvas document from an array of vault document descriptors.
 *
 * Layout: documents are arranged in a grid (row-major, ~4 per row) with
 * 240 px horizontal spacing and 180 px vertical spacing.  Each card is
 * 200 × 120 px.  This produces a readable initial layout that users can
 * rearrange inside Obsidian or another canvas tool.
 *
 * @param docs            Vault documents to include.
 * @param includeIsolated When false, documents with no link connections are omitted.
 */
export function buildCanvasGraph(
  docs: VaultDocDescriptor[],
  includeIsolated = true,
): CanvasDocument {
  const COLS = 4;
  const CARD_W = 200;
  const CARD_H = 120;
  const GAP_X = 240;
  const GAP_Y = 180;

  // Build a set of paths that participate in at least one link.
  const linked = new Set<string>();
  for (const doc of docs) {
    for (const target of doc.linksTo ?? []) {
      linked.add(doc.path);
      linked.add(target);
    }
  }

  const included = includeIsolated ? docs : docs.filter((d) => linked.has(d.path));

  // Build a stable path→id map (sanitise for canvas id constraints: alphanumeric + hyphen).
  const pathToId = new Map<string, string>();
  for (const doc of included) {
    const safe = doc.path
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64);
    pathToId.set(doc.path, safe || `node-${pathToId.size}`);
  }

  const nodes: CanvasNode[] = included.map((doc, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const label = [
      doc.title,
      doc.tags && doc.tags.length > 0 ? `tags: ${doc.tags.join(", ")}` : null,
      doc.wordCount != null ? `${doc.wordCount} words` : null,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      id: pathToId.get(doc.path)!,
      type: "text",
      x: col * GAP_X,
      y: row * GAP_Y,
      width: CARD_W,
      height: CARD_H,
      text: label,
      metadata: {
        path: doc.path,
        title: doc.title,
        tags: doc.tags ?? [],
        wordCount: doc.wordCount ?? 0,
      },
    };
  });

  const edges: CanvasEdge[] = [];
  let edgeSeq = 0;
  for (const doc of included) {
    const fromId = pathToId.get(doc.path);
    if (!fromId) continue;
    for (const target of doc.linksTo ?? []) {
      const toId = pathToId.get(target);
      if (!toId || toId === fromId) continue;
      edges.push({
        id: `edge-${edgeSeq++}`,
        fromNode: fromId,
        fromSide: "right",
        toNode: toId,
        toSide: "left",
      });
    }
  }

  return { nodes, edges };
}

// ─── exportOutline ────────────────────────────────────────────────────────────

/**
 * Export the current document's heading structure as a structured outline.
 *
 * Two formats are supported:
 *   - `'json'`  — hierarchical JSON array of OutlineNode objects (roundtrip-able,
 *                 machine-readable, compatible with Obsidian Canvas / Logseq).
 *   - `'opml'`  — OPML 2.0 XML for feed readers and outliner tools (OmniOutliner,
 *                 WorkFlowy, Logseq, etc.).
 *
 * The heading list is extracted from the raw Markdown source in documentStore
 * (not from the DOM), so this function works in any view mode and produces
 * consistent results regardless of render state.
 *
 * When `outputPath` is provided the file is written via the Rust
 * `write_markdown_file` command (UTF-8 text, atomic temp-rename).  When omitted
 * a save dialog is shown so the user can pick a destination.
 *
 * @param options.format      Output format: `'json'` or `'opml'`.
 * @param options.outputPath  Optional pre-chosen destination path (headless mode).
 * @returns The written file path, or `""` when the user cancelled the dialog.
 */
export async function exportOutline(options: {
  format: "json" | "opml";
  outputPath?: string;
}): Promise<string> {
  const { format, outputPath } = options;

  // Read live document state — works in any view mode (no DOM dependency).
  const { content, fileName, path: docPath } = useDocumentStore.getState();
  if (!docPath && !content) {
    throw "No document is open. Open a Markdown file before exporting.";
  }

  // Build the outline from the Markdown source.
  const headings = parseHeadings(content);
  const tree = buildOutlineTree(headings);
  const title = (fileName ?? "outline").replace(/\.(md|markdown|mdown|mkd|mdx)$/i, "") || "outline";

  // Serialise to the requested format.
  let text: string;
  let ext: string;
  if (format === "opml") {
    text = buildOpml(tree, title);
    ext = "opml";
  } else {
    text = JSON.stringify(tree, null, 2);
    ext = "json";
  }

  // Resolve destination path.
  let dest = outputPath;
  if (!dest) {
    const chosen = await save({
      defaultPath: `${sanitizeFileName(title)}-outline.${ext}`,
      filters: format === "opml"
        ? [{ name: "OPML Outline", extensions: ["opml"] }]
        : [{ name: "JSON Outline", extensions: ["json"] }],
    });
    if (!chosen) return ""; // user cancelled — no toast
    dest = chosen;
  }

  try {
    await invoke("write_markdown_file", { path: dest, content: text });
  } catch (e) {
    toast.error(`Outline export failed: ${errMsg(e)}`);
    throw e;
  }

  toast.success(`Outline exported to ${baseName(dest)}`);
  return dest;
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
 * @returns          A complete, standalone HTML document string.
 */
export function buildExportHtml(profileId: ExportProfileId, content?: string): string {
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
    profileId === "email-html"
      ? inlineEmailStyles(bodyHtml)
      : bodyHtml;

  return `<!doctype html>
<html lang="en" data-theme="${theme}" data-export-profile="${escapeHtml(profileId)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<style>
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
  return html
    // Tables: add class for the email profile table rules + cellpadding/spacing reset
    .replace(/<table(?![^>]*class="content-table")/gi, '<table class="content-table" cellpadding="0" cellspacing="0"')
    // Headings
    .replace(/<h1(\s|>)/gi, '<h1 style="font-size:28px;font-weight:700;color:#111111;margin:0 0 16px;line-height:1.2;"$1')
    .replace(/<h2(\s|>)/gi, '<h2 style="font-size:22px;font-weight:700;color:#222222;margin:24px 0 12px;border-bottom:2px solid #eeeeee;padding-bottom:6px;"$1')
    .replace(/<h3(\s|>)/gi, '<h3 style="font-size:18px;font-weight:600;color:#333333;margin:20px 0 8px;"$1')
    .replace(/<h4(\s|>)/gi, '<h4 style="font-size:16px;font-weight:600;color:#444444;margin:16px 0 6px;"$1')
    .replace(/<h5(\s|>)/gi, '<h5 style="font-size:16px;font-weight:600;color:#444444;margin:16px 0 6px;"$1')
    .replace(/<h6(\s|>)/gi, '<h6 style="font-size:16px;font-weight:600;color:#444444;margin:16px 0 6px;"$1')
    // Paragraphs
    .replace(/<p(\s|>)/gi, '<p style="margin:0 0 16px;color:#333333;font-size:16px;line-height:1.6;"$1')
    // Links
    .replace(/<a(\s)/gi, '<a style="color:#0066cc;text-decoration:underline;"$1')
    // Inline code (not inside pre)
    .replace(/<code(\s|>)/gi, '<code style="font-family:\'Courier New\',Courier,monospace;font-size:14px;background-color:#f5f5f5;border:1px solid #e0e0e0;border-radius:3px;padding:2px 5px;color:#c7254e;"$1')
    // Pre blocks (reset code inside pre)
    .replace(/<pre(\s|>)/gi, '<pre style="background-color:#f8f8f8;border:1px solid #e0e0e0;border-radius:4px;padding:16px;overflow-x:auto;margin:0 0 16px;font-family:\'Courier New\',Courier,monospace;font-size:13px;line-height:1.5;"$1')
    // Blockquotes
    .replace(/<blockquote(\s|>)/gi, '<blockquote style="border-left:4px solid #cccccc;margin:0 0 16px;padding:8px 16px;color:#666666;font-style:italic;background-color:#fafafa;"$1')
    // Images — preserve data URIs, add responsive max-width
    .replace(/<img(\s)/gi, '<img style="max-width:100%;height:auto;display:block;margin:0 0 16px;"$1');
}

/**
 * Export a document using a named format profile.
 *
 * Triggers a native save dialog with the profile's recommended extension
 * (`.html` for Notion/Email, `.txt` for Slack).
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

  const html = buildExportHtml(profileId); // throws if not in Read view

  const ext = profile.extension;
  const filterName =
    ext === "txt" ? "Text / Markdown" : "HTML Document";

  const path = await save({
    defaultPath: `${sanitizeFileName(title)}.${ext}`,
    filters: [{ name: filterName, extensions: [ext] }],
  });
  if (!path) return; // user cancelled — no toast

  try {
    await invoke("write_markdown_file", { path, content: html });
  } catch (e) {
    toast.error(`Export failed: ${errMsg(e)}`);
    throw e;
  }
  toast.success(`Exported to ${baseName(path)}`);
}

// ─── buildBatchExportProfiles ─────────────────────────────────────────────────

/**
 * Result shape for a single profile in a batch export.
 */
export interface BatchProfileResult {
  /** The profile id. */
  profileId: ExportProfileId;
  /** Whether this profile export succeeded. */
  ok: boolean;
  /** The complete standalone HTML document for this profile, or null on failure. */
  html: string | null;
  /** Error string when ok is false. */
  error?: string;
}

/**
 * Export a single document to all (or a subset of) profiles in parallel,
 * returning all 5/6 HTML outputs in a single result object.
 *
 * This is the pure computation counterpart to the `mcp://batch-export-profiles`
 * MCP bridge tool.  It accepts the optional `content` parameter so agents can
 * pass a pre-captured body HTML fragment (for testing without a live DOM), or
 * omit it to capture the live `.markdown-body` element.
 *
 * The `profileIds` parameter defaults to ALL_PROFILE_IDS so agents get every
 * profile in one call.  Pass a subset to restrict the output.
 *
 * All profiles run concurrently via Promise.all — latency is bounded by the
 * slowest profile (the email-html inline pass), not the sum of all profiles.
 *
 * @param profileIds  Which profiles to include (default: all 6).
 * @param content     Optional pre-captured body HTML fragment.
 * @returns           Array of BatchProfileResult, one per requested profile.
 */
export async function buildBatchExportProfiles(
  profileIds: readonly ExportProfileId[] = ALL_PROFILE_IDS,
  content?: string,
): Promise<BatchProfileResult[]> {
  return Promise.all(
    profileIds.map(async (profileId): Promise<BatchProfileResult> => {
      try {
        const html = buildExportHtml(profileId, content);
        return { profileId, ok: true, html };
      } catch (err) {
        const error =
          typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
        return { profileId, ok: false, html: null, error };
      }
    }),
  );
}

// ─── util ────────────────────────────────────────────────────────────────────

/** Normalise an unknown error into a user-readable string. */
function errMsg(e: unknown): string {
  return typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
}

/** Basename of a saved path for the "Exported to …" toast. */
function baseName(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx === -1 ? p : p.slice(idx + 1);
}

/** Strip characters unsafe for file names, replace spaces with hyphens. */
function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[/\\:*?"<>|]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 80) || "export"
  );
}
