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
import { toast } from "../store/toastStore";
import markdownCss from "../styles/markdown.css?raw";
import themesCss from "../styles/themes.css?raw";
import { findTemplate } from "./exportTemplates";
import type { ExportTemplate } from "./exportTemplates";
import { useSettingsStore } from "../store/settingsStore";

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
