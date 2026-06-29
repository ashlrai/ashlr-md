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
import { findTemplate } from "./exportTemplates";
import type { ExportTemplate } from "./exportTemplates";
import { useSettingsStore } from "../store/settingsStore";
import { parseHeadings } from "./outline";
import { buildOutlineTree, buildOpml } from "./exportOutline";
export type { OutlineNode } from "./exportOutline";

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
