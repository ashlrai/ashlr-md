/**
 * Shared payload type definitions used across MCP handler modules.
 *
 * These are extracted from bridge.ts to avoid circular dependencies and to
 * give each handler module a single place to import its payload shapes from.
 */

// ── Open / set-content / edit ─────────────────────────────────────────────────

export interface OpenPayload {
  /** Round-trip id the reply on `mcp_edit_result` carries back; absent when
   * a review opens its file and nobody waits on the outcome. */
  editId?: string;
  path: string;
  mode?: "read" | "edit";
}

export interface SetContentPayload {
  /** Round-trip id the reply on `mcp_edit_result` carries back. */
  editId?: string;
  content: string;
  save?: boolean;
}

export interface EditPayload {
  editId: string;
  find: string;
  replace: string;
  save?: boolean;
}

// ── Export ────────────────────────────────────────────────────────────────────

export interface ExportPayload {
  format: "pdf" | "docx" | "html" | "epub";
  outputPath?: string | null;
}

// ── Review / present ──────────────────────────────────────────────────────────

export interface ReviewPayload {
  reviewId: string;
  path: string | null;
  content: string | null;
  timeoutMs: number;
}

export interface PresentPayload {
  /** Round-trip id the reply on `mcp_edit_result` carries back. */
  editId?: string;
  path: string | null;
}

// ── Stream-edit ───────────────────────────────────────────────────────────────

export interface StreamEditPayload {
  editId: string;
  path?: string;
  find: string;
  replace: string;
  preview?: boolean;
  previewLines?: number;
}

export interface StreamEditApplyPayload {
  editId: string;
  matchIndex?: number;
  save?: boolean;
  path?: string;
}

export interface StreamEditCandidateResult {
  matchIndex: number;
  startLine: number;
  diff: string;
  rank: number;
}
