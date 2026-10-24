/**
 * What an export throws when the document is not rendered in Read view (the
 * `.markdown-body` it captures is absent in Edit and Source view). Shared
 * with the MCP export handler, which tells an agent how to get there.
 */
export const READ_VIEW_REQUIRED = "Switch to Read view before exporting.";

/**
 * An export failure the export has already shown in a toast. Its callers
 * (the command palette, the MCP export) show only the others: a failed
 * write was toasted twice, once with "Export failed:" and once without.
 */
export class ShownExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShownExportError";
  }
}

/** A thrown export failure as text to show. */
export function exportErrorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error && e.message) return e.message;
  return String(e);
}
