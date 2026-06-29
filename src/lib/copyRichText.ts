/**
 * copyRichText.ts — copy the current document to the clipboard as rich text.
 *
 * Goal: pasting into Gmail / Slack / Word / Notion preserves formatting
 * (headings, bold, lists, links, code, tables) while pasting into a plain
 * editor yields the Markdown source.
 *
 * How: write a single `ClipboardItem` carrying BOTH MIME types —
 *   • `text/html`  → the rendered, sanitized document body (rich targets use it)
 *   • `text/plain` → the Markdown source (plain targets use it)
 * Rich-text targets pick the HTML flavour; plain targets pick the text flavour.
 * When `ClipboardItem`/`navigator.clipboard.write` is unavailable we fall back
 * to `writeText(markdown)`.
 *
 * HTML source of truth: the already-rendered `.markdown-body` DOM (same element
 * the HTML/PDF/DOCX exports capture). Its `innerHTML` has already passed through
 * the Renderer's rehype-sanitize pipeline; we re-sanitize with DOMPurify as a
 * defensive second pass and wrap it with a few inline base styles, since many
 * mail/chat clients strip `<style>` blocks and class-based CSS.
 *
 * copyAsRichText(format) — theme-aware standalone HTML clipboard export.
 *
 * Unlike copyDocumentAsRichText (which just wraps the inner HTML with minimal
 * inline styles), copyAsRichText('html') embeds all theme + markdown CSS into a
 * fully self-contained HTML document and places that as the `text/html` clipboard
 * payload. When pasted into Slack, Gmail, or Notion the rendered output respects
 * the active theme's colour palette. The `format` parameter controls how the
 * `text/plain` side-channel is populated:
 *   • 'html'     — plain channel always contains the standalone HTML
 *   • 'markdown' — plain channel contains the raw Markdown source
 *   • 'auto'     — plain channel contains Markdown (most useful default)
 */

import DOMPurify from "dompurify";
import { useDocumentStore } from "../store/documentStore";
import { toast } from "../store/toastStore";
import { buildStandaloneHtml, cloneWithoutInjectedChrome } from "./export";
import { waitForElement } from "./waitForElement";
// Vite ?raw imports for theme-aware HTML generation (mirrors export.ts).
import katexCss from "katex/dist/katex.min.css?raw";
import markdownCss from "../styles/markdown.css?raw";
import themesCss from "../styles/themes.css?raw";

/**
 * A tiny set of inline styles applied to the wrapping <div>. Kept intentionally
 * minimal: rich-text paste targets honour inline styles far more reliably than
 * `<style>` blocks or CSS classes, but most of them already render semantic HTML
 * (h1–h6, strong, ul/ol, a, code, pre, table) acceptably on their own. We just
 * nudge the typographic defaults so the pasted block reads as prose.
 */
const WRAPPER_STYLE = [
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  "font-size:15px",
  "line-height:1.6",
  "color:#1a1a1a",
].join(";");

/**
 * Wrap already-sanitized body markup in the inline-styled <div> that becomes the
 * `text/html` clipboard payload. Pure string logic — no DOM, no environment
 * dependence — so it is the unit-testable core. Returns an empty string when the
 * body is empty/whitespace (nothing meaningful to copy).
 *
 * Exported for tests.
 */
export function wrapRichTextBody(cleanBodyHtml: string): string {
  const trimmed = cleanBodyHtml.trim();
  if (!trimmed) return "";
  return `<div style="${WRAPPER_STYLE}">${trimmed}</div>`;
}

/**
 * Assemble the `text/html` payload from a rendered body's inner HTML: sanitize
 * defensively with DOMPurify (the input is already rehype-sanitized at render
 * time, so this is belt-and-suspenders), then wrap it via {@link wrapRichTextBody}.
 */
export function buildRichTextHtml(bodyInnerHtml: string): string {
  const clean = DOMPurify.sanitize(bodyInnerHtml, {
    USE_PROFILES: { html: true },
  });
  return wrapRichTextBody(clean);
}

/**
 * Read the rendered document body's inner HTML, preferring the live
 * `.markdown-body` element. Falls back to generating export HTML and pulling the
 * `.reading-surface` body out of it (covers the rare case where the element
 * isn't mounted yet). Returns an empty string when neither source yields markup.
 */
function captureRenderedBodyHtml(): string {
  const el = document.querySelector(".markdown-body");
  // Strip injected chrome (the review card) so the clipboard gets the document,
  // not Ashlr's rendering overlay. The fallback below routes through
  // buildStandaloneHtml → captureMarkdownBody, which already strips it.
  if (el) return cloneWithoutInjectedChrome(el).innerHTML;

  // Fallback: reuse the export pipeline, then extract just the rendered body.
  try {
    const standalone = buildStandaloneHtml("document");
    const parsed = new DOMParser().parseFromString(standalone, "text/html");
    const body =
      parsed.querySelector(".markdown-body") ??
      parsed.querySelector(".reading-surface");
    return body?.innerHTML ?? "";
  } catch {
    return "";
  }
}

/**
 * Copy the current document to the clipboard as rich text.
 *
 * - No/empty document → `toast.info` and return.
 * - Ensures the read view is mounted (so `.markdown-body` exists) the same way
 *   the export commands do, then builds the dual-MIME clipboard item.
 * - Falls back to plain-text copy of the Markdown when `ClipboardItem`/`write`
 *   is unavailable, or on any write error.
 */
export async function copyDocumentAsRichText(): Promise<void> {
  const doc = useDocumentStore.getState();
  const markdown = doc.content;

  if (!doc.path || !markdown.trim()) {
    toast.info("Open a document first");
    return;
  }

  // The rendered body only exists in read view; switch + wait if needed.
  if (doc.viewMode !== "read") {
    doc.setViewMode("read");
    await waitForElement(".markdown-body");
  }

  const html = buildRichTextHtml(captureRenderedBodyHtml());

  // Fallback path: no rich-clipboard support (or no HTML to write).
  const canWriteRich =
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.clipboard?.write;

  if (!html || !canWriteRich) {
    try {
      await navigator.clipboard.writeText(markdown);
      toast.success("Copied as rich text");
    } catch (e) {
      toast.error("Couldn't copy to the clipboard");
      console.warn("[copyRichText] writeText fallback failed", e);
    }
    return;
  }

  try {
    const item = new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([markdown], { type: "text/plain" }),
    });
    await navigator.clipboard.write([item]);
    toast.success("Copied as rich text");
  } catch (e) {
    // Some environments reject ClipboardItem writes (focus, permissions);
    // degrade to a plain-text copy rather than failing outright.
    try {
      await navigator.clipboard.writeText(markdown);
      toast.success("Copied as rich text");
    } catch (inner) {
      toast.error("Couldn't copy to the clipboard");
      console.warn("[copyRichText] clipboard write failed", e, inner);
    }
  }
}

// ─── Theme-aware rich HTML clipboard export ────────────────────────────────

/**
 * Theme colour palettes baked into the standalone HTML so the document renders
 * correctly in rich-text paste targets that honour inline CSS (Gmail, Notion,
 * Apple Mail) and `<style>` blocks (most modern editors).
 *
 * Values are taken directly from themes.css so they stay in sync with the live
 * theme tokens — any update to themes.css should be reflected here too.
 */
export const THEME_PALETTES: Record<string, Record<string, string>> = {
  paper: {
    "--bg": "#ffffff",
    "--text": "#1f2328",
    "--text-secondary": "#4a5159",
    "--text-muted": "#6b727b",
    "--accent": "#0969da",
    "--border": "#e4e8ec",
    "--border-strong": "#d0d7de",
    "--code-bg": "#f6f8fa",
    "--code-border": "#e4e8ec",
    "--inline-code-bg": "#eef1f4",
    "--inline-code-text": "#1f2328",
    "--quote-border": "#d0d7de",
    "--quote-text": "#59636e",
    "--table-header-bg": "#f6f8fa",
    "--table-row-alt": "#fafbfc",
    "--mark-bg": "#fff3c4",
  },
  sepia: {
    "--bg": "#f5edda",
    "--text": "#43382a",
    "--text-secondary": "#6a5b45",
    "--text-muted": "#76674f",
    "--accent": "#9a5b34",
    "--border": "#ddd0b3",
    "--border-strong": "#cdbf9d",
    "--code-bg": "#ece1c8",
    "--code-border": "#ddd0b3",
    "--inline-code-bg": "#e6d9bd",
    "--inline-code-text": "#43382a",
    "--quote-border": "#cdbf9d",
    "--quote-text": "#6a5b45",
    "--table-header-bg": "#ece1c8",
    "--table-row-alt": "#f0e7d2",
    "--mark-bg": "#ecd98a",
  },
  midnight: {
    "--bg": "#16181d",
    "--text": "#e6e8eb",
    "--text-secondary": "#a9b1ba",
    "--text-muted": "#888f99",
    "--accent": "#6ba8ff",
    "--border": "#2a2f3a",
    "--border-strong": "#3a4150",
    "--code-bg": "#1b1f27",
    "--code-border": "#2a2f3a",
    "--inline-code-bg": "#262b35",
    "--inline-code-text": "#e6e8eb",
    "--quote-border": "#3a4150",
    "--quote-text": "#a9b1ba",
    "--table-header-bg": "#1e2128",
    "--table-row-alt": "#1a1d23",
    "--mark-bg": "#57451f",
  },
} as const;

/**
 * Build a fully self-contained, offline HTML document that is suitable for
 * writing to the clipboard as `text/html`.
 *
 * Compared with {@link buildRichTextHtml} (which produces a minimal `<div>`
 * fragment), this function embeds the full CSS bundle (themes + markdown +
 * KaTeX) so the pasted result renders with the correct colour palette in
 * Gmail, Notion, Apple Mail, and other rich-text targets.
 *
 * Syntax-highlighted code blocks from Shiki already carry their colour as
 * inline `style` attributes on each `<span>`, so they survive paste without
 * any extra CSS.  Mermaid diagrams are already rendered to inline `<svg>`.
 * KaTeX math is rendered HTML + the KaTeX stylesheet which is inlined here.
 *
 * @param bodyHtml  The `.markdown-body` inner HTML (already sanitized).
 * @param theme     One of `"paper"`, `"sepia"`, or `"midnight"`.
 * @returns A complete HTML document string ready for the clipboard.
 */
export function buildThemeAwareRichHtml(bodyHtml: string, theme: string): string {
  const trimmed = bodyHtml.trim();
  if (!trimmed) return "";

  // Resolve the palette — fall back to paper for unknown themes.
  const palette = THEME_PALETTES[theme] ?? THEME_PALETTES["paper"];
  const paletteVars = Object.entries(palette)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");

  return `<!doctype html>
<html lang="en" data-theme="${escapeAttr(theme)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
/* ── Reset ── */
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}

/* ── Theme colour tokens (${escapeAttr(theme)}) ── */
:root{${paletteVars};--content-font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;--mono-font:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;--content-font-size:15px;--content-width:720px}

/* ── Full themes bundle (all theme selectors) ── */
${themesCss}

/* ── Markdown typography ── */
${markdownCss}

/* ── KaTeX math ── */
${katexCss}

/* ── Page shell ── */
body{background:var(--bg);color:var(--text);font-family:var(--content-font);-webkit-font-smoothing:antialiased}
.reading-surface{max-width:var(--content-width);margin:0 auto;padding:32px 24px 64px}
</style>
</head>
<body>
<article class="reading-surface">
<div class="markdown-body">
${trimmed}
</div>
</article>
</body>
</html>`;
}

/** Minimal attribute-value escaping (no quotes, no angle brackets). */
function escapeAttr(s: string): string {
  return s.replace(/[&"<>]/g, (c) =>
    c === "&" ? "&amp;" : c === '"' ? "&quot;" : c === "<" ? "&lt;" : "&gt;",
  );
}

/**
 * Copy the current document to the clipboard as theme-aware standalone HTML.
 *
 * Unlike {@link copyDocumentAsRichText} (which wraps the inner HTML with
 * minimal inline styles), this function:
 *   - Embeds the full CSS bundle (themes + markdown + KaTeX) so the pasted
 *     result renders correctly in Gmail, Slack, Notion, and Apple Mail.
 *   - Reads the active theme from `document.documentElement.dataset.theme`.
 *   - Supplies a `text/plain` fallback according to `format`:
 *       • `'html'`     — plain channel = standalone HTML
 *       • `'markdown'` — plain channel = raw Markdown source
 *       • `'auto'`     — same as `'markdown'` (most useful for paste targets)
 *
 * When `ClipboardItem`/`navigator.clipboard.write` is unavailable the function
 * falls back to `writeText(markdown)` so the call is never a hard failure.
 *
 * @param format  Controls the `text/plain` clipboard side-channel.
 */
export async function copyAsRichText(
  format: "html" | "markdown" | "auto" = "auto",
): Promise<void> {
  const doc = useDocumentStore.getState();
  const markdown = doc.content;

  if (!doc.path || !markdown.trim()) {
    toast.info("Open a document first");
    return;
  }

  // Ensure the read view is mounted so `.markdown-body` is in the DOM.
  if (doc.viewMode !== "read") {
    doc.setViewMode("read");
    await waitForElement(".markdown-body");
  }

  // Capture and sanitize the rendered body.
  const rawBodyHtml = captureRenderedBodyHtmlForRichCopy();
  if (!rawBodyHtml) {
    toast.info("Nothing to copy — switch to Read view first.");
    return;
  }

  const cleanBodyHtml = DOMPurify.sanitize(rawBodyHtml, {
    USE_PROFILES: { html: true },
  });

  // Detect active theme from the document root attribute.
  const theme =
    (typeof document !== "undefined"
      ? document.documentElement.dataset.theme
      : undefined) ?? "paper";

  const standaloneHtml = buildThemeAwareRichHtml(cleanBodyHtml, theme);
  if (!standaloneHtml) {
    toast.info("Nothing to copy.");
    return;
  }

  // Determine the plain-text payload.
  const plainText = format === "html" ? standaloneHtml : markdown;

  const canWriteRich =
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.clipboard?.write;

  if (!canWriteRich) {
    try {
      await navigator.clipboard.writeText(plainText);
      toast.success("Copied as rich HTML");
    } catch (e) {
      toast.error("Couldn't copy to the clipboard");
      console.warn("[copyAsRichText] writeText fallback failed", e);
    }
    return;
  }

  try {
    const item = new ClipboardItem({
      "text/html": new Blob([standaloneHtml], { type: "text/html" }),
      "text/plain": new Blob([plainText], { type: "text/plain" }),
    });
    await navigator.clipboard.write([item]);
    toast.success("Copied as rich HTML");
  } catch (e) {
    // Degrade to plain-text copy rather than failing outright.
    try {
      await navigator.clipboard.writeText(plainText);
      toast.success("Copied as rich HTML");
    } catch (inner) {
      toast.error("Couldn't copy to the clipboard");
      console.warn("[copyAsRichText] clipboard write failed", e, inner);
    }
  }
}

/**
 * Capture the rendered `.markdown-body` inner HTML for the rich-copy path.
 * Strips injected UI chrome (review card) before returning.
 * Returns an empty string when the element is not in the DOM.
 */
function captureRenderedBodyHtmlForRichCopy(): string {
  const el = document.querySelector(".markdown-body");
  if (el) return cloneWithoutInjectedChrome(el).innerHTML;

  // Fallback: reuse the export pipeline (same strategy as captureRenderedBodyHtml).
  try {
    const standalone = buildStandaloneHtml("document");
    const parsed = new DOMParser().parseFromString(standalone, "text/html");
    const body =
      parsed.querySelector(".markdown-body") ??
      parsed.querySelector(".reading-surface");
    return body?.innerHTML ?? "";
  } catch {
    return "";
  }
}
