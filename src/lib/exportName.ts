/**
 * exportName.ts: the name an export of a document starts from.
 */

/**
 * The export title of a document named `fileName`: the name without its
 * Markdown extension, or "export" for none. Exports name their default
 * file after it (`notes.md` gives `notes.html`) and title the page with it
 * when the front matter has no `title`. The palette's export commands used
 * the file name as it was, so they offered `notes.md.html` and titled the
 * page "notes.md"; the dialog and the MCP export stripped it.
 */
export function exportTitle(fileName: string | null | undefined): string {
  return (fileName ?? "").replace(/\.(md|markdown|mdown|mkd|mdx)$/i, "") || "export";
}
