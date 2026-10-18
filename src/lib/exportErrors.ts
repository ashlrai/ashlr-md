/**
 * What an export throws when the document is not rendered in Read view (the
 * `.markdown-body` it captures is absent in Edit and Source view). Shared
 * with the MCP export handler, which tells an agent how to get there.
 */
export const READ_VIEW_REQUIRED = "Switch to Read view before exporting.";
