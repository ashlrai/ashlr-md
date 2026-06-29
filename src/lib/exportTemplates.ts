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
