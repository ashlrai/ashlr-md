/**
 * Shared payload type definitions used across MCP handler modules.
 *
 * These are extracted from bridge.ts to avoid circular dependencies and to
 * give each handler module a single place to import its payload shapes from.
 */

import type { CanvasEditOp } from "../../lib/canvas";
import type { ExportProfileId } from "../../lib/exportTemplates";
import type { OtComponent, VectorClock } from "../../lib/ot";

// ── Atomic-edits ─────────────────────────────────────────────────────────────

export interface AtomicEditEntry {
  path: string;
  find: string;
  replace: string;
  metadata?: {
    dependsOn?: string[];
    [key: string]: unknown;
  };
}

export interface AtomicEditFileResult {
  path: string;
  ok: boolean;
  replaced: number;
  error?: string;
}

export interface AtomicEditsPayload {
  atomicId: string;
  entries: AtomicEditEntry[];
  save?: boolean;
}

// ── Open / set-content / edit ─────────────────────────────────────────────────

export interface OpenPayload {
  path: string;
  mode?: "read" | "edit";
}

export interface SetContentPayload {
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

export interface ExportEpubPayload {
  format: "epub";
  outputPath?: string | null;
}

export interface MarkdownArchivePayload {
  outputPath?: string | null;
  includeAssets?: boolean;
}

export interface CanvasGraphPayload {
  outputPath?: string | null;
  includeIsolated?: boolean;
}

export interface OutlineExportPayload {
  format: "json" | "opml";
  outputPath?: string | null;
}

export interface BatchExportEntry {
  path: string;
  format: "pdf" | "docx" | "html" | "epub";
  outputDir?: string;
}

export interface BatchExportFileResult {
  path: string;
  format: string;
  ok: boolean;
  outputPath?: string;
  error?: string;
}

export interface BatchExportPayload {
  batchId: string;
  exports: BatchExportEntry[];
}

export interface BatchExportProfilesPayload {
  batchId: string;
  profileIds?: ExportProfileId[];
  content?: string;
}

export interface BatchExportProfileResult {
  profileId: ExportProfileId;
  ok: boolean;
  html: string | null;
  error?: string;
}

// ── Review / present ──────────────────────────────────────────────────────────

export interface ReviewPayload {
  reviewId: string;
  path: string | null;
  content: string | null;
  timeoutMs: number;
}

export interface PresentPayload {
  path: string | null;
}

// ── Canvas ────────────────────────────────────────────────────────────────────

export interface EditCanvasPayload {
  editId: string;
  path: string;
  ops: CanvasEditOp[];
  undo?: number;
  redo?: number;
  save?: boolean;
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface BatchReadPayload {
  batchId: string;
  paths: string[];
}

export interface BatchReadFileResult {
  path: string;
  ok: boolean;
  content?: string;
  headers?: Record<string, unknown>;
  metadata?: { sizeBytes: number; mtimeMs: number };
  error?: string;
}

export interface BatchEditPayload {
  batchId: string;
  ops: Array<{ path: string; find: string; replace: string; save?: boolean }>;
}

export interface BatchEditOpResult {
  path: string;
  ok: boolean;
  replaced: number;
  error?: string;
  conflict?: string;
}

export interface SemanticSearchPayload {
  searchId: string;
  query: string;
  k?: number;
  rerank?: boolean;
}

export interface DiffDocsPayload {
  diffId: string;
  pathA: string;
  pathB: string;
  contextLines?: number;
}

// ── Conversation / memory ─────────────────────────────────────────────────────

export interface OtOpPayload {
  opId: string;
  agentId: string;
  seq: number;
  clock: VectorClock;
  components: OtComponent[];
  save?: boolean;
}

export interface CopyRichTextPayload {
  format?: "html" | "markdown" | "auto";
}

export interface ApplyDiffHunkPayload {
  diffId: string;
  diffText: string;
  hunkIndex: number;
  save?: boolean;
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
