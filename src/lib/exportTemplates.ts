/**
 * exportTemplates.ts — built-in named export templates and template utilities.
 *
 * A template defines custom CSS that layers on top of the base export styles.
 * The cascade order is:
 *   1. Theme tokens (paper / sepia / midnight CSS vars)  — widest scope
 *   2. Markdown typography (markdown.css)                — element defaults
 *   3. KaTeX / Shiki inline styles                       — content-specific
 *   4. Template CSS (this file's entries)                — user override layer
 *
 * User-defined templates are stored in settingsStore and serialised to
 * localStorage; they follow the same shape.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExportTemplate {
  /** Machine-stable identifier used as the Map key and persisted value. */
  id: string;
  /** Human-readable name shown in the settings UI. */
  name: string;
  /** Raw CSS injected after the base styles in the exported document. */
  css: string;
  /** When true, this is a read-only built-in — users may duplicate but not edit. */
  builtin?: boolean;
}

// ─── Built-in templates ───────────────────────────────────────────────────────

/**
 * GitHub-flavoured documentation style.
 * Clean inter-UI font, flat heading borders, GH accent blue.
 */
const GITHUB_TEMPLATE_CSS = `
/* ── GitHub Readme style ── */
:root {
  --tpl-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --tpl-code-bg: #f6f8fa;
  --tpl-border: #d0d7de;
  --tpl-heading-border: #d0d7de;
  --tpl-accent: #0969da;
  --tpl-text: #1f2328;
  --tpl-bg: #ffffff;
}
body {
  font-family: var(--tpl-font);
  font-size: 16px;
  line-height: 1.6;
  color: var(--tpl-text);
  background: var(--tpl-bg);
}
.reading-surface { max-width: 800px; padding: 32px 40px 64px; }
h1, h2 { padding-bottom: 0.4em; border-bottom: 1px solid var(--tpl-heading-border); }
h1 { font-size: 2em; }
h2 { font-size: 1.5em; }
h3 { font-size: 1.25em; }
code { font-size: 85%; background: var(--tpl-code-bg); border: 1px solid var(--tpl-border); border-radius: 6px; padding: 0.2em 0.4em; }
pre { background: var(--tpl-code-bg); border: 1px solid var(--tpl-border); border-radius: 6px; padding: 16px; overflow-x: auto; }
pre code { background: none; border: none; padding: 0; font-size: 100%; }
blockquote { border-left: 4px solid var(--tpl-border); color: #656d76; margin: 0 0 16px; padding: 0 16px; }
table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
th, td { border: 1px solid var(--tpl-border); padding: 6px 13px; }
tr:nth-child(even) { background: #f6f8fa; }
a { color: var(--tpl-accent); text-decoration: none; }
a:hover { text-decoration: underline; }
`.trim();

/**
 * Notion-inspired documentation style.
 * Soft serif font, generous whitespace, subtle card-style code blocks.
 */
const NOTION_TEMPLATE_CSS = `
/* ── Notion-style ── */
@import url('data:text/css,');
:root {
  --tpl-font: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif;
  --tpl-heading-color: #37352f;
  --tpl-text: #37352f;
  --tpl-secondary: #787774;
  --tpl-bg: #ffffff;
  --tpl-code-bg: rgba(135, 131, 120, 0.15);
  --tpl-border: rgba(55, 53, 47, 0.09);
  --tpl-callout-bg: rgba(241, 241, 239, 1);
}
body {
  font-family: var(--tpl-font);
  font-size: 16px;
  line-height: 1.7;
  color: var(--tpl-text);
  background: var(--tpl-bg);
  -webkit-font-smoothing: antialiased;
}
.reading-surface { max-width: 720px; padding: 96px 96px 180px; }
h1 { font-size: 2.5em; font-weight: 700; color: var(--tpl-heading-color); margin-bottom: 0.3em; }
h2 { font-size: 1.5em; font-weight: 600; color: var(--tpl-heading-color); margin-top: 1.5em; }
h3 { font-size: 1.17em; font-weight: 600; color: var(--tpl-heading-color); }
code { background: var(--tpl-code-bg); border-radius: 4px; padding: 0.2em 0.4em; font-size: 85%; }
pre { background: var(--tpl-code-bg); border-radius: 4px; padding: 20px 24px; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: 100%; }
blockquote { border-left: 3px solid var(--tpl-secondary); padding-left: 20px; color: var(--tpl-secondary); margin: 1em 0; }
table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
th { background: var(--tpl-callout-bg); font-weight: 600; }
th, td { border: 1px solid var(--tpl-border); padding: 8px 12px; text-align: left; }
a { color: inherit; border-bottom: 1px solid var(--tpl-border); text-decoration: none; }
a:hover { border-bottom-color: var(--tpl-secondary); }
`.trim();

/**
 * Academic paper style — strict serif typography, numbered-like look,
 * tight margins for print.
 */
const ACADEMIC_TEMPLATE_CSS = `
/* ── Academic Paper ── */
:root {
  --tpl-font: "Georgia", "Times New Roman", Times, serif;
  --tpl-mono: "Courier New", Courier, monospace;
  --tpl-text: #111111;
  --tpl-secondary: #444444;
  --tpl-bg: #ffffff;
  --tpl-code-bg: #f4f4f4;
  --tpl-border: #cccccc;
}
body {
  font-family: var(--tpl-font);
  font-size: 12pt;
  line-height: 1.8;
  color: var(--tpl-text);
  background: var(--tpl-bg);
}
.reading-surface { max-width: 680px; padding: 60px 48px 80px; }
h1 { font-size: 18pt; font-weight: bold; text-align: center; margin-bottom: 6pt; }
h2 { font-size: 14pt; font-weight: bold; border-bottom: 1px solid var(--tpl-border); padding-bottom: 2pt; }
h3 { font-size: 12pt; font-weight: bold; font-style: italic; }
p { text-align: justify; text-indent: 1.5em; margin-bottom: 0; }
p:first-child, h1 + p, h2 + p, h3 + p, blockquote + p { text-indent: 0; }
code { font-family: var(--tpl-mono); font-size: 10pt; background: var(--tpl-code-bg); padding: 1px 4px; }
pre { font-family: var(--tpl-mono); font-size: 10pt; background: var(--tpl-code-bg); border: 1px solid var(--tpl-border); padding: 10pt; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { border-left: 2px solid var(--tpl-border); font-style: italic; color: var(--tpl-secondary); padding-left: 16pt; margin: 8pt 0; }
table { border-collapse: collapse; width: 100%; font-size: 11pt; margin: 12pt 0; }
th { border-top: 2px solid var(--tpl-text); border-bottom: 1px solid var(--tpl-text); font-weight: bold; padding: 4pt 8pt; }
td { border-bottom: 1px solid var(--tpl-border); padding: 4pt 8pt; }
a { color: var(--tpl-text); text-decoration: underline; }
@media print { body { font-size: 11pt; } .reading-surface { max-width: 100%; padding: 0; } }
`.trim();

/**
 * Dark technical / developer documentation.
 * Opinionated dark background, monospaced feel, VS Code-adjacent palette.
 */
const DEVDOCS_TEMPLATE_CSS = `
/* ── Dev Docs (dark) ── */
:root {
  --tpl-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --tpl-text: #d4d4d4;
  --tpl-heading: #e6e6e6;
  --tpl-bg: #1e1e1e;
  --tpl-code-bg: #252526;
  --tpl-border: #3c3c3c;
  --tpl-accent: #4ec9b0;
  --tpl-link: #9cdcfe;
}
html { color-scheme: dark; }
body {
  font-family: var(--tpl-font);
  font-size: 14px;
  line-height: 1.65;
  color: var(--tpl-text);
  background: var(--tpl-bg);
}
.reading-surface { max-width: 900px; padding: 40px 48px 80px; }
h1, h2, h3, h4 { color: var(--tpl-heading); font-weight: 600; }
h1 { font-size: 1.75em; border-bottom: 1px solid var(--tpl-border); padding-bottom: 0.4em; }
h2 { font-size: 1.3em; color: var(--tpl-accent); }
h3 { font-size: 1.1em; }
code { background: var(--tpl-code-bg); border: 1px solid var(--tpl-border); border-radius: 4px; padding: 0.15em 0.4em; font-size: 90%; }
pre { background: var(--tpl-code-bg); border: 1px solid var(--tpl-border); border-radius: 6px; padding: 16px; overflow-x: auto; }
pre code { background: none; border: none; padding: 0; font-size: 100%; }
blockquote { border-left: 3px solid var(--tpl-accent); color: #9d9d9d; margin: 0; padding: 0 16px; font-style: italic; }
table { border-collapse: collapse; width: 100%; }
th { background: #252526; color: var(--tpl-accent); font-weight: 600; }
th, td { border: 1px solid var(--tpl-border); padding: 8px 12px; }
a { color: var(--tpl-link); text-decoration: none; }
a:hover { text-decoration: underline; }
`.trim();

/**
 * Clean business / newsletter style.
 * Wide margins, humanist sans, gentle background tint.
 */
const NEWSLETTER_TEMPLATE_CSS = `
/* ── Newsletter / Email ── */
:root {
  --tpl-font: "Inter", "Helvetica Neue", Arial, sans-serif;
  --tpl-text: #1a1a2e;
  --tpl-secondary: #555577;
  --tpl-bg: #f5f5f7;
  --tpl-card-bg: #ffffff;
  --tpl-border: #e0e0e8;
  --tpl-accent: #6a5acd;
  --tpl-accent-light: #f0eeff;
}
body {
  font-family: var(--tpl-font);
  font-size: 16px;
  line-height: 1.7;
  color: var(--tpl-text);
  background: var(--tpl-bg);
}
.reading-surface {
  max-width: 640px;
  padding: 32px 24px 60px;
  background: var(--tpl-card-bg);
  border-radius: 12px;
  box-shadow: 0 2px 20px rgba(0,0,0,0.06);
  margin: 32px auto;
}
h1 { font-size: 1.9em; font-weight: 800; letter-spacing: -0.02em; }
h2 { font-size: 1.35em; font-weight: 700; color: var(--tpl-accent); margin-top: 1.8em; }
h3 { font-size: 1.1em; font-weight: 600; }
code { background: var(--tpl-accent-light); color: var(--tpl-accent); border-radius: 4px; padding: 0.15em 0.4em; font-size: 88%; }
pre { background: #1a1a2e; color: #e0e0f8; border-radius: 8px; padding: 16px 20px; overflow-x: auto; }
pre code { background: none; color: inherit; }
blockquote { border-left: 4px solid var(--tpl-accent); background: var(--tpl-accent-light); border-radius: 0 8px 8px 0; margin: 0; padding: 12px 16px; color: var(--tpl-secondary); }
table { border-collapse: collapse; width: 100%; border-radius: 8px; overflow: hidden; }
th { background: var(--tpl-accent); color: #ffffff; font-weight: 600; padding: 10px 14px; }
td { border: 1px solid var(--tpl-border); padding: 8px 14px; }
tr:nth-child(even) td { background: #fafafa; }
a { color: var(--tpl-accent); text-decoration: none; font-weight: 500; }
a:hover { text-decoration: underline; }
`.trim();

// ─── Export profile types ─────────────────────────────────────────────────────

/**
 * A named export profile that controls how HTML is post-processed for a
 * specific destination (Notion, Slack, Email).  Unlike ExportTemplate (which
 * is purely additive CSS), a profile can also specify structural transformations
 * applied by buildExportHtml() in export.ts.
 */
export type ExportProfileId = "notion-html" | "slack-html" | "email-html";

export interface ExportProfile {
  /** Stable machine id used in UI and routing logic. */
  id: ExportProfileId;
  /** Human-readable label shown in the export dialog. */
  name: string;
  /** Short description for the tooltip / dialog subtitle. */
  description: string;
  /**
   * Suggested file extension for the save dialog.
   * Notion and email produce `.html`; Slack produces `.txt`.
   */
  extension: "html" | "txt";
  /** CSS that is injected into the document when building profile HTML. */
  css: string;
}

// ─── Profile CSS ──────────────────────────────────────────────────────────────

/**
 * notion-html profile CSS.
 *
 * Goals:
 *  - No absolute/fixed positioning (Notion strips position:absolute).
 *  - Simplified table handling — Notion imports tables as database-like blocks;
 *    we ensure clean cell borders and no complex merged-cell tricks.
 *  - max-width constraint that matches Notion's default page width (~900px).
 *  - Clean semantic HTML output — no heavy box-shadows, no ::before/::after
 *    generated content that Notion's parser ignores.
 */
const NOTION_PROFILE_CSS = `
/* ── notion-html export profile ── */
:root {
  --np-font: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --np-text: #37352f;
  --np-secondary: #787774;
  --np-bg: #ffffff;
  --np-code-bg: rgba(135,131,120,0.15);
  --np-border: rgba(55,53,47,0.16);
  --np-heading: #37352f;
}
/* Override any position:absolute/fixed — Notion cannot handle them */
* { position: static !important; box-shadow: none !important; text-shadow: none !important; }
body {
  font-family: var(--np-font);
  font-size: 16px;
  line-height: 1.65;
  color: var(--np-text);
  background: var(--np-bg);
  max-width: 900px;
  margin: 0 auto;
  padding: 32px 24px;
}
.reading-surface { max-width: 900px; padding: 0; margin: 0; }
/* Headings — use semantic weight, no decorative borders */
h1 { font-size: 2em; font-weight: 700; color: var(--np-heading); margin: 0 0 0.5em; }
h2 { font-size: 1.5em; font-weight: 600; color: var(--np-heading); margin: 1.4em 0 0.4em; }
h3 { font-size: 1.2em; font-weight: 600; color: var(--np-heading); margin: 1.2em 0 0.3em; }
h4, h5, h6 { font-size: 1em; font-weight: 600; color: var(--np-heading); margin: 1em 0 0.2em; }
p { margin: 0.5em 0 0.8em; }
/* Links — Notion preserves href so keep them clean */
a { color: #0f7b6c; text-decoration: underline; }
/* Inline code */
code { font-size: 85%; background: var(--np-code-bg); border-radius: 3px; padding: 0.15em 0.4em; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; }
/* Block code */
pre { background: var(--np-code-bg); border-radius: 4px; padding: 16px; overflow-x: auto; margin: 1em 0; }
pre code { background: none; padding: 0; font-size: 100%; }
/* Blockquote */
blockquote { border-left: 3px solid var(--np-border); margin: 1em 0; padding: 4px 16px; color: var(--np-secondary); }
/* Tables — simplified for Notion import compatibility */
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th { background: #f7f6f3; font-weight: 600; text-align: left; }
th, td { border: 1px solid var(--np-border); padding: 8px 12px; vertical-align: top; }
/* Lists */
ul, ol { margin: 0.5em 0 0.8em; padding-left: 1.6em; }
li { margin: 0.2em 0; }
/* Images */
img { max-width: 100%; height: auto; display: block; border-radius: 4px; margin: 1em 0; }
`.trim();

/**
 * slack-html profile CSS.
 *
 * Slack's message renderer supports a constrained subset of Markdown.
 * This profile produces plaintext-friendly output with preserved inline
 * Markdown formatting so the result can be pasted as-is into Slack threads.
 * Width is constrained to ~520px (Slack thread column width).
 *
 * Since the output is `.txt` / Markdown-ish, the CSS is minimal and primarily
 * serves the HTML preview; the actual Slack paste comes from the text content.
 */
const SLACK_PROFILE_CSS = `
/* ── slack-html export profile ── */
:root {
  --sp-font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --sp-text: #1d1c1d;
  --sp-code-bg: #f8f8f8;
  --sp-code-border: #e8e8e8;
  --sp-link: #1264a3;
}
body {
  font-family: var(--sp-font);
  font-size: 15px;
  line-height: 1.5;
  color: var(--sp-text);
  background: #ffffff;
  max-width: 520px;
  margin: 0 auto;
  padding: 16px;
}
.reading-surface { max-width: 520px; padding: 0; margin: 0; }
/* Headings — Slack does not render HTML headings; use bold + newline style */
h1, h2, h3, h4, h5, h6 { font-weight: 700; margin: 0.8em 0 0.2em; font-size: 1em; }
h1 { font-size: 1.1em; }
/* Paragraphs */
p { margin: 0 0 0.6em; }
/* Links */
a { color: var(--sp-link); text-decoration: none; }
a::after { content: " (" attr(href) ")"; font-size: 0.85em; color: #888; }
/* Inline code — Slack uses backtick formatting */
code { font-family: "Slack-Lato", "appleLogo", sans-serif; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--sp-code-bg); border: 1px solid var(--sp-code-border); border-radius: 3px; padding: 0.1em 0.3em; font-size: 87%; }
/* Code blocks — Slack uses triple-backtick blocks */
pre { background: var(--sp-code-bg); border: 1px solid var(--sp-code-border); border-radius: 4px; padding: 12px; overflow-x: auto; margin: 0.6em 0; }
pre code { background: none; border: none; padding: 0; font-size: 100%; }
/* Blockquote — Slack uses > prefix */
blockquote { border-left: 3px solid #ddd; margin: 0.4em 0; padding: 0 12px; color: #555; }
/* Tables — Slack does not support tables; show as simple bordered grid */
table { border-collapse: collapse; width: 100%; margin: 0.6em 0; font-size: 0.9em; }
th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
th { background: #f4f4f4; font-weight: 600; }
/* Lists */
ul, ol { margin: 0.2em 0 0.6em; padding-left: 1.4em; }
li { margin: 0.15em 0; }
/* Images — show dimensions hint since Slack embeds as links */
img { max-width: 100%; height: auto; border: 1px solid #eee; border-radius: 3px; margin: 0.4em 0; display: block; }
`.trim();

/**
 * email-html profile CSS.
 *
 * Email clients have highly variable CSS support.  This profile:
 *  - Uses only inline-compatible CSS (no CSS custom properties — many clients
 *    don't support them; the CSS here defines fallbacks that buildExportHtml
 *    will inline onto elements).
 *  - Responsive: table-based outer wrapper with a max-width center column.
 *  - Dark-mode media query fallback for clients that support it (Apple Mail,
 *    Outlook.com web).
 *  - No external references; all assets must be embedded as data URIs.
 *  - .png image embedding support — images with data URI src are preserved.
 */
const EMAIL_PROFILE_CSS = `
/* ── email-html export profile ── */
/* Base reset for email clients */
body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
img { -ms-interpolation-mode: bicubic; }
/* Remove default styling */
body { margin: 0 !important; padding: 0 !important; background-color: #f4f4f4 !important; }
/* Email wrapper */
.email-wrapper {
  max-width: 600px;
  margin: 0 auto;
  background-color: #ffffff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  color: #333333;
}
.reading-surface {
  max-width: 600px;
  margin: 0 auto;
  padding: 32px 24px 40px;
  background-color: #ffffff;
}
/* Headings — inline-friendly */
h1 { font-size: 28px; font-weight: 700; color: #111111; margin: 0 0 16px; line-height: 1.2; }
h2 { font-size: 22px; font-weight: 700; color: #222222; margin: 24px 0 12px; border-bottom: 2px solid #eeeeee; padding-bottom: 6px; }
h3 { font-size: 18px; font-weight: 600; color: #333333; margin: 20px 0 8px; }
h4, h5, h6 { font-size: 16px; font-weight: 600; color: #444444; margin: 16px 0 6px; }
/* Body text */
p { margin: 0 0 16px; color: #333333; font-size: 16px; line-height: 1.6; }
/* Links */
a { color: #0066cc; text-decoration: underline; }
/* Inline code */
code { font-family: "Courier New", Courier, monospace; font-size: 14px; background-color: #f5f5f5; border: 1px solid #e0e0e0; border-radius: 3px; padding: 2px 5px; color: #c7254e; }
/* Code blocks */
pre { background-color: #f8f8f8; border: 1px solid #e0e0e0; border-radius: 4px; padding: 16px; overflow-x: auto; margin: 0 0 16px; font-family: "Courier New", Courier, monospace; font-size: 13px; line-height: 1.5; }
pre code { background: none; border: none; padding: 0; color: #333333; font-size: 100%; }
/* Blockquote */
blockquote { border-left: 4px solid #cccccc; margin: 0 0 16px; padding: 8px 16px; color: #666666; font-style: italic; background-color: #fafafa; }
/* Tables — use inline styles for max email client compatibility */
table.content-table { border-collapse: collapse; width: 100%; margin: 0 0 16px; }
table.content-table th { background-color: #f0f0f0; font-weight: 700; color: #333333; padding: 10px 14px; border: 1px solid #dddddd; text-align: left; }
table.content-table td { padding: 10px 14px; border: 1px solid #dddddd; color: #333333; vertical-align: top; }
table.content-table tr:nth-child(even) td { background-color: #fafafa; }
/* Lists */
ul, ol { margin: 0 0 16px; padding-left: 24px; color: #333333; }
li { margin: 4px 0; font-size: 16px; }
/* Images — embedded data URIs (.png, .jpg) are preserved; max-width for responsive */
img { max-width: 100% !important; height: auto; display: block; margin: 0 0 16px; }
/* Horizontal rule */
hr { border: none; border-top: 1px solid #eeeeee; margin: 24px 0; }
/* Dark mode media query — supported by Apple Mail, Outlook.com */
@media (prefers-color-scheme: dark) {
  body { background-color: #1a1a1a !important; }
  .email-wrapper, .reading-surface { background-color: #2a2a2a !important; }
  p, li, td, th, blockquote, code { color: #e0e0e0 !important; }
  h1, h2, h3, h4, h5, h6 { color: #f0f0f0 !important; }
  a { color: #66aaff !important; }
  pre, code { background-color: #333333 !important; border-color: #555555 !important; }
  table.content-table th { background-color: #3a3a3a !important; }
  table.content-table td { border-color: #555555 !important; }
  blockquote { background-color: #333333 !important; border-left-color: #888888 !important; }
}
/* Responsive: stack on mobile */
@media only screen and (max-width: 640px) {
  .email-wrapper, .reading-surface { width: 100% !important; max-width: 100% !important; padding: 16px !important; }
  h1 { font-size: 22px !important; }
  h2 { font-size: 18px !important; }
  table.content-table, table.content-table tbody, table.content-table tr, table.content-table td, table.content-table th { display: block; width: 100% !important; }
  table.content-table tr { margin-bottom: 8px; }
}
`.trim();

// ─── Profile registry ─────────────────────────────────────────────────────────

export const EXPORT_PROFILES: readonly ExportProfile[] = [
  {
    id: "notion-html",
    name: "Notion",
    description: "Optimised HTML for pasting into Notion — clean semantic markup, no absolute positioning, Notion-compatible table layout.",
    extension: "html",
    css: NOTION_PROFILE_CSS,
  },
  {
    id: "slack-html",
    name: "Slack",
    description: "Plaintext + Markdown formatting constrained to Slack thread width (~520px). Save as .txt and paste into Slack.",
    extension: "txt",
    css: SLACK_PROFILE_CSS,
  },
  {
    id: "email-html",
    name: "Email HTML",
    description: "Fully inlined HTML for email clients — responsive, dark-mode aware, no external refs, supports embedded PNG images.",
    extension: "html",
    css: EMAIL_PROFILE_CSS,
  },
] as const;

/**
 * Look up an export profile by id.
 * Returns `undefined` if the id is not a known profile.
 */
export function findProfile(id: string): ExportProfile | undefined {
  return EXPORT_PROFILES.find((p) => p.id === id);
}

// ─── Built-in template registry ───────────────────────────────────────────────

export const BUILTIN_TEMPLATES: readonly ExportTemplate[] = [
  {
    id: "builtin-github",
    name: "GitHub Readme",
    css: GITHUB_TEMPLATE_CSS,
    builtin: true,
  },
  {
    id: "builtin-notion",
    name: "Notion-style",
    css: NOTION_TEMPLATE_CSS,
    builtin: true,
  },
  {
    id: "builtin-academic",
    name: "Academic Paper",
    css: ACADEMIC_TEMPLATE_CSS,
    builtin: true,
  },
  {
    id: "builtin-devdocs",
    name: "Dev Docs",
    css: DEVDOCS_TEMPLATE_CSS,
    builtin: true,
  },
  {
    id: "builtin-newsletter",
    name: "Newsletter",
    css: NEWSLETTER_TEMPLATE_CSS,
    builtin: true,
  },
] as const;

/** ID sentinel meaning "no template — use base styles only". */
export const NO_TEMPLATE_ID = "none";

// ─── Template utilities ───────────────────────────────────────────────────────

/**
 * Look up a template by id in the combined built-in + user list.
 * Returns `undefined` if not found (callers treat this as "no template").
 */
export function findTemplate(
  id: string,
  userTemplates: ExportTemplate[],
): ExportTemplate | undefined {
  if (id === NO_TEMPLATE_ID) return undefined;
  return (
    BUILTIN_TEMPLATES.find((t) => t.id === id) ??
    userTemplates.find((t) => t.id === id)
  );
}

/**
 * Validate a user-provided CSS string for obvious injection risks.
 *
 * Rules enforced:
 *  - No `<script` or `</script` tags (prevents XSS in exported HTML).
 *  - No `@import url(http` (keeps exports offline-capable).
 *  - No `javascript:` URI schemes.
 *
 * Returns `null` when valid, or a user-visible error string.
 */
export function validateTemplateCss(css: string): string | null {
  if (/<\/?script/i.test(css)) return "CSS must not contain <script> tags.";
  if (/javascript:/i.test(css)) return "CSS must not contain javascript: URIs.";
  if (/@import\s+url\s*\(\s*['"]?https?:/i.test(css)) {
    return "CSS must not import external URLs (keeps exports offline-ready).";
  }
  return null;
}

/**
 * Generate a new unique id for a user-created template.
 * Uses crypto.randomUUID when available, falls back to Date.now() + Math.random().
 */
export function newTemplateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `user-${crypto.randomUUID()}`;
  }
  return `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
