/** Offline export themes, layered through the existing template selector.
 * Use only installed fonts; CSS is embedded in both HTML and PDF exports.
 */

export const ACADEMIC_THEME_CSS = `
/* ── Academic Paper ── */
:root, :root[data-theme] {
  --content-font: var(--tpl-font);
  --content-font-size: 12pt;
  color-scheme: light;
  --text: #111111;
  --text-secondary: #444444;
  --accent: #111111;
  --bg: #ffffff;
  --tpl-font: "Georgia", "Times New Roman", Times, serif;
  --tpl-mono: "Courier New", Courier, monospace;
  --tpl-text: #111111;
  --tpl-secondary: #444444;
  --tpl-bg: #ffffff;
  --tpl-code-bg: #f4f4f4;
  --tpl-border: #cccccc;
}
.markdown-body { line-height: 1.8; }
body {
  font-family: var(--tpl-font);
  font-size: 12pt;
  line-height: 1.8;
  color: var(--tpl-text);
  background: var(--tpl-bg);
}
.reading-surface { max-width: 680px; padding: 60px 48px 80px; }
.markdown-body h1 { font-size: 18pt; font-weight: bold; text-align: center; margin-bottom: 6pt; }
.markdown-body h2 { font-size: 14pt; font-weight: bold; border-bottom: 1px solid var(--tpl-border); padding-bottom: 2pt; }
.markdown-body h3 { font-size: 12pt; font-weight: bold; font-style: italic; }
.markdown-body p { text-align: justify; text-indent: 1.5em; margin-bottom: 0; }
.markdown-body p:first-child, .markdown-body h1 + p, .markdown-body h2 + p, .markdown-body h3 + p, .markdown-body blockquote + p { text-indent: 0; }
.markdown-body code { font-family: var(--tpl-mono); font-size: 10pt; background: var(--tpl-code-bg); padding: 1px 4px; }
.markdown-body pre { font-family: var(--tpl-mono); font-size: 10pt; background: var(--tpl-code-bg); border: 1px solid var(--tpl-border); padding: 10pt; overflow-x: auto; }
.markdown-body pre code { background: none; padding: 0; }
.markdown-body blockquote { border-left: 2px solid var(--tpl-border); font-style: italic; color: var(--tpl-secondary); padding-left: 16pt; margin: 8pt 0; }
.markdown-body table { border-collapse: collapse; width: 100%; font-size: 11pt; margin: 12pt 0; }
.markdown-body th { border-top: 2px solid var(--tpl-text); border-bottom: 1px solid var(--tpl-text); font-weight: bold; padding: 4pt 8pt; }
.markdown-body td { border-bottom: 1px solid var(--tpl-border); padding: 4pt 8pt; }
.markdown-body a { color: var(--tpl-text); text-decoration: underline; }
@media print { .markdown-body { font-size: 11pt; } .reading-surface { max-width: 100%; padding: 0; } }
`.trim();

export const EDITORIAL_THEME_CSS = `
/* ── Editorial ── */
:root, :root[data-theme] {
  --content-font: Georgia, "Times New Roman", serif;
  --content-font-size: 17px;
  color-scheme: light;
  --text: #292524;
  --text-secondary: #57534e;
  --bg: #fffdf8;
  --accent: #9a3412;
  --border: #d6cfc4;
}
body { background: var(--bg); color: var(--text); }
.markdown-body { line-height: 1.75; }
.reading-surface { max-width: 760px; padding: 48px 40px 72px; }
.markdown-body h1, .markdown-body h2, .markdown-body h3 {
  font-family: "Helvetica Neue", Arial, sans-serif;
  color: var(--text);
  letter-spacing: -0.025em;
}
.markdown-body h1 { font-size: 2.6em; border-bottom: 3px solid var(--accent); }
.markdown-body h2 { font-size: 1.65em; border-bottom: none; }
.markdown-body blockquote { border-left: 3px solid var(--accent); font-style: italic; color: var(--text-secondary); }
.markdown-body a { color: var(--accent); text-decoration: underline; }
.markdown-body pre, .markdown-body code { font-family: "Courier New", Courier, monospace; background: #f3eee6; }
.markdown-body table { border-collapse: collapse; width: 100%; }
.markdown-body th, .markdown-body td { border: 1px solid var(--border); padding: 8px 12px; }
.markdown-body th { background: #f3eee6; }
@media print {
  :root, :root[data-theme] { --bg: #ffffff; --text: #000000; --content-font-size: 12pt; }
  .reading-surface { max-width: 100%; padding: 0; }
  .markdown-body { orphans: 3; widows: 3; }
}
`.trim();
