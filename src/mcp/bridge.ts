/**
 * MCP bridge — keeps the Rust IPC server in sync with the frontend document
 * state, and applies mutations that arrive from the IPC server as Tauri events.
 *
 * Mount once from App.tsx:
 * ```tsx
 * import { useMcpBridge } from "./mcp/bridge";
 * export default function App() {
 *   useMcpBridge();
 *   // … rest of App
 * }
 * ```
 *
 * ## How it works
 *
 * PUSH (frontend → Rust):
 *   Subscribes to documentStore + recentStore (→ `mcp_sync_state`, keeps
 *   `/content` and `/recent` fresh) and activityStore (→ `mcp_sync_vault`, keeps
 *   `/vault` and `/search` fresh). Both debounced 200 ms.
 *
 * PULL (Rust → frontend):
 *   Listens for Tauri events emitted by the IPC server (or deep-link handler)
 *   and routes them to the appropriate store action:
 *     - `mcp://open`        → documentStore.openPath()
 *     - `mcp://set-content` → documentStore.setContent() [+ optional save]
 *     - `mcp://export`      → uiStore.openExport() after optionally switching doc
 *     - `mcp://review`      → reviewStore.registerReview()
 *     - `mcp://present`     → read view + uiStore.openZen() (distraction-free)
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { exportDocx, exportHtml, exportPdf, exportMarkdownArchive, exportCanvasGraph, exportOutline } from "../lib/export";
import { summarise, type OtComponent, type OtOperation, type VectorClock } from "../lib/ot";
import { searchFiles } from "../lib/crossSearch";
import { embedSearch, embedAvailable } from "../lib/embedSearch";
import { useActivityStore } from "../store/activityStore";
import { useConversationStore } from "../store/memoryStore";
import { useDocumentStore } from "../store/documentStore";
import { useRecentStore } from "../store/recentStore";
import { useReviewStore } from "../store/reviewStore";
import { toast } from "../store/toastStore";
import { useUiStore } from "../store/uiStore";
import { applyUniqueEdit } from "./applyEdit";

// ── Payload shapes from Rust ──────────────────────────────────────────────────

interface OpenPayload {
  path: string;
  mode?: "read" | "edit";
}

interface SetContentPayload {
  content: string;
  save?: boolean;
}

interface ExportPayload {
  format: "pdf" | "docx" | "html";
  outputPath?: string | null;
}

interface ReviewPayload {
  reviewId: string;
  path: string | null;
  content: string | null;
  timeoutMs: number;
}

interface PresentPayload {
  path: string | null;
}

interface EditPayload {
  editId: string;
  find: string;
  replace: string;
  save?: boolean;
}

/**
 * Payload for `mcp://ot-op` — a serialised OT operation from a remote agent.
 *
 * The Rust IPC server (or another app window) emits this event when an agent
 * has produced an edit encoded as an OT operation.  The bridge deserialises it,
 * applies it atomically via `documentStore.applyOp`, and replies with
 * `mcp_ot_result` so the sender knows whether the op landed.
 *
 * `opId` doubles as a correlation id (like `editId` in the find/replace path).
 */
interface MarkdownArchivePayload {
  outputPath?: string | null;
  includeAssets?: boolean;
}

interface CanvasGraphPayload {
  outputPath?: string | null;
  includeIsolated?: boolean;
}

interface OutlineExportPayload {
  format: "json" | "opml";
  outputPath?: string | null;
}

interface OtOpPayload {
  opId: string;
  agentId: string;
  seq: number;
  clock: VectorClock;
  components: OtComponent[];
  /** When true, persist the document to disk after applying. */
  save?: boolean;
}

// ── Batch / semantic tool payloads ────────────────────────────────────────────

/**
 * Payload for `mcp://batch-read` — read multiple vault files in one call.
 *
 * `paths` is a list of vault-relative (or absolute) paths.  Glob patterns are
 * expanded server-side via `read_batch_files`; the frontend forwards the list
 * as-is and lets Rust handle expansion.
 */
interface BatchReadPayload {
  batchId: string;
  paths: string[];
}

/** Per-file result returned inside `mcp_batch_read_result`. */
export interface BatchReadFileResult {
  path: string;
  ok: boolean;
  content?: string;
  /** Extracted YAML/TOML front-matter headers (key→value). */
  headers?: Record<string, unknown>;
  /** File metadata: size in bytes and mtime as ms-since-epoch. */
  metadata?: { sizeBytes: number; mtimeMs: number };
  error?: string;
}

/**
 * Payload for `mcp://batch-edit` — apply multiple find/replace ops atomically.
 *
 * Each operation is applied against the LIVE documentStore content for the
 * path that matches the currently-open document.  Files not currently open
 * are forwarded to Rust (`apply_batch_edit`) to edit on disk.
 */
interface BatchEditPayload {
  batchId: string;
  ops: Array<{ path: string; find: string; replace: string; save?: boolean }>;
}

/** Per-op result returned inside `mcp_batch_edit_result`. */
export interface BatchEditOpResult {
  path: string;
  ok: boolean;
  replaced: number;
  error?: string;
  /** Conflict marker text when the file was modified concurrently. */
  conflict?: string;
}

/**
 * Payload for `mcp://semantic-search` — embeddings-backed vault search with
 * optional BM25 re-ranking fallback.
 *
 * When an embedding model is available, results are ranked by cosine similarity
 * (via the `embed_search` Rust command).  When no model is available the bridge
 * falls back to keyword search (`search_files`) so agents always get results.
 *
 * `rerank` (default true) fuses keyword BM25 scores with semantic scores using
 * reciprocal-rank fusion when both signal sources are available.
 */
interface SemanticSearchPayload {
  searchId: string;
  query: string;
  /** Maximum results to return (default 10). */
  k?: number;
  /** Whether to apply BM25 re-ranking on top of semantic results (default true). */
  rerank?: boolean;
}

// ── Batch export / diff payloads ──────────────────────────────────────────────

/**
 * One entry in a `mcp://batch-export` request.
 * `format` must be one of "pdf" | "docx" | "html".
 * `outputDir` is optional — when omitted, Rust/the app uses the file's own dir.
 */
export interface BatchExportEntry {
  path: string;
  format: "pdf" | "docx" | "html";
  outputDir?: string;
}

/** Per-file result returned inside `mcp_batch_export_result`. */
export interface BatchExportFileResult {
  path: string;
  format: string;
  ok: boolean;
  outputPath?: string;
  error?: string;
}

/** Payload for `mcp://batch-export` — export multiple files in one call. */
interface BatchExportPayload {
  batchId: string;
  exports: BatchExportEntry[];
}

/** Payload for `mcp://diff-docs` — diff two document paths. */
interface DiffDocsPayload {
  diffId: string;
  pathA: string;
  pathB: string;
  /** Number of context lines in the unified diff (default 3). */
  contextLines?: number;
}

// ── Session persistence helpers (exported for use in MCP tools / tests) ────────

/**
 * Persist the current session's message log to the Rust layer, which writes it
 * atomically to `~/.mdopener/sessions/{sessionId}.json`.
 *
 * Non-fatal: a failure logs a warning but never throws so the app keeps running.
 */
export async function persistSession(sessionId: string): Promise<void> {
  const { messages } = useConversationStore.getState();
  const sessionMessages = messages.filter((m) => m.sessionId === sessionId);
  await invoke("mcp_persist_session", {
    sessionId,
    messages: sessionMessages,
  }).catch((e) => {
    console.warn("[mcp bridge] mcp_persist_session failed:", e);
  });
}

/**
 * Load a prior session's messages from disk (via Rust) and restore them into
 * the in-memory conversation store.  Called on app start to resume sessions
 * that survived a restart.
 *
 * Returns the number of messages restored (0 when no session file exists).
 */
export async function loadSession(sessionId: string): Promise<number> {
  try {
    const messages = await invoke<Array<{
      id: string;
      sessionId: string;
      role: "agent" | "human" | "system";
      content: string;
      citedDocs: string[];
      timestampMs: number;
    }>>("mcp_load_session", { sessionId });

    if (!messages || messages.length === 0) return 0;

    // Merge loaded messages into the in-memory store without duplicating.
    const existing = useConversationStore.getState().messages;
    const existingIds = new Set(existing.map((m) => m.id));
    const newMessages = messages.filter((m) => !existingIds.has(m.id));
    if (newMessages.length > 0) {
      useConversationStore.setState((s) => ({
        messages: [...s.messages, ...newMessages],
        // Restore currentSessionId if this was the most recent session.
        currentSessionId: s.currentSessionId ?? sessionId,
      }));
    }
    return newMessages.length;
  } catch (e) {
    console.warn("[mcp bridge] mcp_load_session failed:", e);
    return 0;
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMcpBridge(): void {
  // Keep refs to the debounce timers so we can clear them on cleanup.
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vaultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // ── 1. Subscribe to store changes and push to Rust (debounced 200 ms) ──
    const syncNow = () => {
      const { path, content } = useDocumentStore.getState();
      const recents = useRecentStore.getState().recents;
      invoke("mcp_sync_state", {
        path: path ?? null,
        content,
        recents,
      }).catch((e) => {
        // Non-fatal — the IPC server is best-effort.
        console.warn("[mcp bridge] mcp_sync_state failed:", e);
      });
    };

    const scheduleSync = () => {
      if (syncTimer.current !== null) clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(syncNow, 200);
    };

    // Mirror the watched folder ("vault") so /vault and /search can enumerate it.
    const syncVaultNow = () => {
      const { watchedDir, files } = useActivityStore.getState();
      invoke("mcp_sync_vault", {
        watchedDir: watchedDir ?? null,
        files: files.map((f) => ({ path: f.path, name: f.name, dir: f.dir })),
      }).catch((e) => {
        console.warn("[mcp bridge] mcp_sync_vault failed:", e);
      });
    };

    const scheduleVaultSync = () => {
      if (vaultTimer.current !== null) clearTimeout(vaultTimer.current);
      vaultTimer.current = setTimeout(syncVaultNow, 200);
    };

    // Sync conversation session to Rust when messages change (debounced 500 ms).
    // Debounced longer than the document sync because messages are appended
    // infrequently and we want to batch rapid multi-turn bursts into one write.
    const scheduleSessionSync = () => {
      const { currentSessionId } = useConversationStore.getState();
      if (!currentSessionId) return;
      if (sessionTimer.current !== null) clearTimeout(sessionTimer.current);
      sessionTimer.current = setTimeout(() => {
        const { currentSessionId: sid } = useConversationStore.getState();
        if (sid) {
          persistSession(sid);
        }
      }, 500);
    };

    // Subscribe to the stores.  Zustand subscribe returns an unsubscribe fn.
    const unsubDoc = useDocumentStore.subscribe(scheduleSync);
    const unsubRecent = useRecentStore.subscribe(scheduleSync);
    const unsubActivity = useActivityStore.subscribe(scheduleVaultSync);
    const unsubConversation = useConversationStore.subscribe(scheduleSessionSync);

    // Push the current state immediately on mount.
    syncNow();
    syncVaultNow();

    // ── 2. Listen for Tauri events from the IPC server ──────────────────────
    // `listen()` is async; collect each resolved unlisten fn synchronously into
    // `live` and tear down on unmount. If cleanup runs before a listener has
    // finished registering (e.g. React StrictMode's mount→unmount→mount in dev),
    // `disposed` makes the late-resolving listener unlisten itself immediately —
    // so a remount never ends up with two live copies double-firing every event.
    const unlisteners: Promise<UnlistenFn>[] = [];
    let disposed = false;
    const live: UnlistenFn[] = [];

    // mcp://open — open a file (path + optional mode)
    unlisteners.push(
      listen<OpenPayload>("mcp://open", (e) => {
        const { path, mode } = e.payload;
        useDocumentStore
          .getState()
          .openPath(path)
          .then(() => {
            if (mode === "edit") {
              useDocumentStore.getState().setViewMode("edit");
            } else if (mode === "read") {
              useDocumentStore.getState().setViewMode("read");
            }
          });
      }),
    );

    // mcp://set-content — replace document content
    unlisteners.push(
      listen<SetContentPayload>("mcp://set-content", async (e) => {
        const { content, save } = e.payload;
        useDocumentStore.getState().setContent(content);
        if (save) {
          await useDocumentStore.getState().save();
        }
        // Re-sync immediately after mutation so a subsequent /content read
        // sees the updated content without waiting for the debounce.
        syncNow();
      }),
    );

    // mcp://edit — apply an exact, unique find/replace against the LIVE document.
    //
    // This is the frontend half of the MCP `/edit` round-trip. The Rust IPC
    // worker parks waiting for our reply (mcp_edit_result), so we ALWAYS answer —
    // success, soft-failure, or thrown error — keyed by editId. Applying the
    // find/replace here (against documentStore's current content, not the
    // 200 ms-debounced server mirror) is what closes the stale-window: we both
    // find text the user typed in the last debounce and derive the new content
    // from that live basis, so the result can't clobber just-typed edits.
    unlisteners.push(
      listen<EditPayload>("mcp://edit", async (e) => {
        const { editId, find, replace, save } = e.payload;
        try {
          const liveContent = useDocumentStore.getState().content;
          const outcome = applyUniqueEdit(liveContent, find, replace);
          if (outcome.ok && outcome.content !== undefined) {
            useDocumentStore.getState().setContent(outcome.content);
            if (save) {
              await useDocumentStore.getState().save();
            }
            // Keep the server mirror fresh immediately (don't wait for debounce)
            // so a subsequent /content read reflects the edit.
            syncNow();
          }
          await invoke("mcp_edit_result", {
            editId,
            ok: outcome.ok,
            replaced: outcome.replaced,
            error: outcome.error ?? null,
          });
        } catch (err) {
          // Never leave the Rust worker parked — report the failure so it can
          // return a soft error to the agent instead of timing out.
          await invoke("mcp_edit_result", {
            editId,
            ok: false,
            replaced: 0,
            error: `Edit failed in app: ${String(err)}`,
          }).catch((e2) => {
            // The recovery reply itself failed (e.g. IPC torn down mid-reload):
            // the worker can no longer be released early and will hit its 5 s
            // timeout. Surface it so the stall isn't completely silent.
            console.error("[mcp bridge] mcp_edit_result recovery reply failed:", e2);
          });
        }
      }),
    );

    // mcp://export — open the export dialog pre-selected to the requested
    // format, OR (when outputPath is provided) run the export directly and
    // report success/failure via mcp_export_result so agents get confirmation.
    //
    // Two paths:
    //   A. No outputPath → open the dialog with the format pre-selected.
    //      The user drives the file-picker from there. mcp_export_result is NOT
    //      called (the agent opened the dialog; the user decides the destination).
    //   B. outputPath supplied → bypass the dialog, invoke the appropriate
    //      export function directly, then call mcp_export_result with
    //      { ok, path, error } so the agent receives a deterministic callback.
    unlisteners.push(
      listen<ExportPayload>("mcp://export", async (e) => {
        const { format, outputPath } = e.payload;
        if (!useDocumentStore.getState().path) {
          toast.info("Open a document before exporting.");
          // Notify the agent so it doesn't wait indefinitely.
          if (outputPath) {
            await invoke("mcp_export_result", {
              format,
              ok: false,
              path: null,
              error: "No document is open.",
            }).catch(() => {/* non-fatal */});
          }
          return;
        }

        if (outputPath) {
          // Path B: headless export — agent supplied a destination path.
          // Run the export fn; report success or failure back to Rust.
          try {
            const fileName = useDocumentStore.getState().fileName ?? "export";
            const title = fileName.replace(/\.(md|markdown|mdown|mkd|mdx)$/i, "") || "export";
            if (format === "pdf") {
              await exportPdf(title);
            } else if (format === "docx") {
              await exportDocx(title);
            } else {
              await exportHtml(title);
            }
            await invoke("mcp_export_result", {
              format,
              ok: true,
              path: outputPath,
              error: null,
            }).catch(() => {/* non-fatal */});
          } catch (err) {
            const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
            toast.error(`MCP export failed: ${errStr}`);
            await invoke("mcp_export_result", {
              format,
              ok: false,
              path: null,
              error: errStr,
            }).catch(() => {/* non-fatal */});
          }
        } else {
          // Path A: open the dialog with the format pre-selected.
          useUiStore.getState().openExport(format);
        }
      }),
    );

    // mcp://review — an agent requested human review; show the review panel.
    // (If a path was given, mcp://open fires separately to open the doc.)
    unlisteners.push(
      listen<ReviewPayload>("mcp://review", (e) => {
        const { reviewId, path, content, timeoutMs } = e.payload;
        useReviewStore.getState().registerReview({
          reviewId,
          path,
          content,
          timeoutMs,
          registeredAt: Date.now(),
        });
      }),
    );

    // mcp://present — open a doc (if given) and enter distraction-free reading.
    unlisteners.push(
      listen<PresentPayload>("mcp://present", (e) => {
        const doc = useDocumentStore.getState();
        const enterPresent = () => {
          useDocumentStore.getState().setViewMode("read");
          useUiStore.getState().openZen();
        };
        const { path } = e.payload;
        if (path) {
          doc
            .openPath(path)
            .then(enterPresent)
            .catch((err) => {
              console.warn("[mcp bridge] mcp://present openPath failed:", err);
            });
        } else if (doc.path) {
          enterPresent();
        }
      }),
    );

    // mcp://export-markdown-archive — pack .md + assets into a tar.gz.
    //
    // When outputPath is provided, runs headless and calls mcp_archive_result.
    // When omitted, opens a save dialog (user picks destination).
    unlisteners.push(
      listen<MarkdownArchivePayload>("mcp://export-markdown-archive", async (e) => {
        const { outputPath, includeAssets = true } = e.payload;
        try {
          const resultPath = await exportMarkdownArchive({
            outputPath: outputPath ?? undefined,
            includeAssets,
          });
          if (outputPath) {
            await invoke("mcp_archive_result", {
              ok: true,
              path: resultPath || outputPath,
              error: null,
            }).catch(() => {/* non-fatal */});
          }
        } catch (err) {
          const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
          if (outputPath) {
            await invoke("mcp_archive_result", {
              ok: false,
              path: null,
              error: errStr,
            }).catch(() => {/* non-fatal */});
          }
        }
      }),
    );

    // mcp://export-canvas-graph — export vault file graph as JSON Canvas.
    //
    // When outputPath is provided, runs headless and calls mcp_canvas_result.
    // When omitted, opens a save dialog (user picks destination).
    unlisteners.push(
      listen<CanvasGraphPayload>("mcp://export-canvas-graph", async (e) => {
        const { outputPath, includeIsolated = true } = e.payload;
        try {
          const resultPath = await exportCanvasGraph({
            outputPath: outputPath ?? undefined,
            includeIsolated,
          });
          if (outputPath) {
            await invoke("mcp_canvas_result", {
              ok: true,
              path: resultPath || outputPath,
              error: null,
            }).catch(() => {/* non-fatal */});
          }
        } catch (err) {
          const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
          if (outputPath) {
            await invoke("mcp_canvas_result", {
              ok: false,
              path: null,
              error: errStr,
            }).catch(() => {/* non-fatal */});
          }
        }
      }),
    );

    // mcp://export-outline — export document heading structure as JSON or OPML.
    //
    // When outputPath is provided, runs headless and calls mcp_outline_result.
    // When omitted, opens a save dialog (user picks destination).
    unlisteners.push(
      listen<OutlineExportPayload>("mcp://export-outline", async (e) => {
        const { format = "json", outputPath } = e.payload;
        try {
          const resultPath = await exportOutline({
            format,
            outputPath: outputPath ?? undefined,
          });
          if (outputPath) {
            await invoke("mcp_outline_result", {
              ok: true,
              path: resultPath || outputPath,
              format,
              error: null,
            }).catch(() => {/* non-fatal */});
          }
        } catch (err) {
          const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
          if (outputPath) {
            await invoke("mcp_outline_result", {
              ok: false,
              path: null,
              format,
              error: errStr,
            }).catch(() => {/* non-fatal */});
          }
        }
      }),
    );

    // mcp://ot-op — apply a remote OT operation atomically.
    //
    // This is the OT counterpart to mcp://edit.  The Rust IPC worker (or a
    // second app window acting as a peer agent) sends a fully-serialised OT
    // operation.  We apply it against the live document, enrich it with a
    // summary for the margin-badge UI, then reply with mcp_ot_result.
    //
    // Like mcp://edit, we ALWAYS reply — success or failure — so the remote
    // side never parks waiting for an answer that never comes.
    unlisteners.push(
      listen<OtOpPayload>("mcp://ot-op", async (e) => {
        const { opId, agentId, seq, clock, components, save } = e.payload;
        const op: OtOperation = { id: opId, agentId, seq, clock, components };
        // Enrich with summary before applying (uses the current doc content).
        const currentContent = useDocumentStore.getState().content;
        try {
          op.summary = summarise(op, currentContent);
        } catch {
          // summarise is best-effort — don't block the apply if it fails.
        }
        const ok = useDocumentStore.getState().applyOp(op);
        if (ok) {
          if (save) {
            await useDocumentStore.getState().save();
          }
          syncNow();
          // Auto-clear margin badges after 4 s so the UI doesn't stay cluttered.
          setTimeout(() => {
            useDocumentStore.getState().clearPendingOps();
          }, 4000);
        } else {
          toast.info(`OT op from ${agentId} could not be applied (doc state mismatch).`);
        }
        await invoke("mcp_ot_result", {
          opId,
          ok,
          error: ok ? null : "OT op inconsistent with current document state",
        }).catch((err) => {
          console.error("[mcp bridge] mcp_ot_result reply failed:", err);
        });
      }),
    );

    // mcp://batch-read — read multiple vault files in one round-trip.
    //
    // Forwards the paths list to Rust (`read_batch_files`) which handles glob
    // expansion and returns per-file {content, headers, metadata}.  We echo
    // the result back via `mcp_batch_read_result` keyed by batchId.
    //
    // Like all reply-required handlers, we ALWAYS invoke `mcp_batch_read_result`
    // — success or failure — so the Rust worker never parks waiting.
    unlisteners.push(
      listen<BatchReadPayload>("mcp://batch-read", async (e) => {
        const { batchId, paths } = e.payload;
        try {
          const results = await invoke<BatchReadFileResult[]>("read_batch_files", { paths });
          await invoke("mcp_batch_read_result", {
            batchId,
            ok: true,
            results,
            error: null,
          }).catch(() => {/* non-fatal */});
        } catch (err) {
          const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
          await invoke("mcp_batch_read_result", {
            batchId,
            ok: false,
            results: [],
            error: errStr,
          }).catch(() => {/* non-fatal */});
        }
      }),
    );

    // mcp://batch-edit — apply multiple find/replace ops atomically.
    //
    // For each op, if the target path matches the currently-open document we
    // apply it live against documentStore (same as mcp://edit) to avoid
    // clobbering just-typed edits.  All other paths are sent to Rust
    // (`apply_batch_edit`) to edit on disk.
    //
    // Results include per-op ok/error and an optional conflict marker when the
    // Rust layer detects a concurrent modification.  We reply via
    // `mcp_batch_edit_result` and always reply (prevents Rust worker timeout).
    unlisteners.push(
      listen<BatchEditPayload>("mcp://batch-edit", async (e) => {
        const { batchId, ops } = e.payload;
        const opResults: BatchEditOpResult[] = [];
        const currentPath = useDocumentStore.getState().path;

        // Separate ops for the live document from ops that target disk files.
        const liveOps: typeof ops = [];
        const diskOps: typeof ops = [];
        for (const op of ops) {
          if (currentPath && op.path === currentPath) {
            liveOps.push(op);
          } else {
            diskOps.push(op);
          }
        }

        // Apply live ops against the in-memory document (zero stale-window).
        for (const op of liveOps) {
          const liveContent = useDocumentStore.getState().content;
          const outcome = applyUniqueEdit(liveContent, op.find, op.replace);
          if (outcome.ok && outcome.content !== undefined) {
            useDocumentStore.getState().setContent(outcome.content);
            if (op.save) {
              await useDocumentStore.getState().save();
            }
            syncNow();
          }
          opResults.push({
            path: op.path,
            ok: outcome.ok,
            replaced: outcome.replaced,
            error: outcome.ok ? undefined : outcome.error,
          });
        }

        // Forward disk ops to Rust for on-disk atomic patch.
        if (diskOps.length > 0) {
          try {
            const diskResults = await invoke<BatchEditOpResult[]>("apply_batch_edit", {
              ops: diskOps,
            });
            opResults.push(...diskResults);
          } catch (err) {
            const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
            // Mark all forwarded disk ops as failed.
            for (const op of diskOps) {
              opResults.push({ path: op.path, ok: false, replaced: 0, error: errStr });
            }
          }
        }

        const allOk = opResults.every((r) => r.ok);
        await invoke("mcp_batch_edit_result", {
          batchId,
          ok: allOk,
          results: opResults,
          error: allOk ? null : "One or more edits failed — see per-file results.",
        }).catch(() => {/* non-fatal */});
      }),
    );

    // mcp://semantic-search — embeddings-backed vault search with BM25 fallback.
    //
    // When an Ollama embedding model is available, `embed_search` returns
    // semantically similar chunks ranked by cosine similarity.  When `rerank`
    // is true (default), we fuse those results with keyword BM25 hits from
    // `search_files` using reciprocal-rank fusion (RRF) — a simple, robust
    // cross-encoder-free reranking that works without a second model call.
    //
    // When no embedding model is available we fall back to keyword-only search
    // so agents always receive results rather than an empty list.
    //
    // We reply via `mcp_semantic_search_result` keyed by `searchId`.
    unlisteners.push(
      listen<SemanticSearchPayload>("mcp://semantic-search", async (e) => {
        const { searchId, query, k = 10, rerank = true } = e.payload;
        try {
          const modelAvailable = await embedAvailable();
          const { files } = useActivityStore.getState();
          const vaultPaths = files.map((f) => f.path);

          type SearchResultItem = {
            path: string;
            fileName: string;
            snippet: string;
            score: number;
            source: "semantic" | "keyword";
          };

          let results: SearchResultItem[] = [];

          if (modelAvailable) {
            // Semantic pass — cosine-ranked chunks from the embed index.
            const semanticHits = await embedSearch(query, k * 2);
            results = semanticHits.map((h) => ({
              path: h.path,
              fileName: h.fileName,
              snippet: h.snippet,
              score: h.score,
              source: "semantic" as const,
            }));

            if (rerank && vaultPaths.length > 0) {
              // BM25 pass — keyword hits for RRF fusion.
              const keywordHits = await searchFiles(vaultPaths, query, k * 2);

              // Build rank maps (1-based rank).
              const semanticRank = new Map<string, number>();
              results.forEach((r, i) => semanticRank.set(r.path, i + 1));

              const keywordRank = new Map<string, number>();
              keywordHits.forEach((r, i) => keywordRank.set(r.path, i + 1));

              // RRF constant (k=60 is the standard default).
              const RRF_K = 60;
              const rrfScore = (path: string): number => {
                const sr = semanticRank.get(path);
                const kr = keywordRank.get(path);
                return (sr ? 1 / (RRF_K + sr) : 0) + (kr ? 1 / (RRF_K + kr) : 0);
              };

              // Merge keyword hits not already in semantic results.
              for (const kh of keywordHits) {
                if (!semanticRank.has(kh.path)) {
                  results.push({
                    path: kh.path,
                    fileName: kh.fileName,
                    snippet: kh.matches[0]?.snippet ?? "",
                    score: 0,
                    source: "keyword",
                  });
                }
              }

              // Re-rank by RRF score (descending).
              results.sort((a, b) => rrfScore(b.path) - rrfScore(a.path));
            }
          } else {
            // Keyword-only fallback when no embedding model is available.
            const keywordHits = await searchFiles(vaultPaths, query, k);
            results = keywordHits.map((h, i) => ({
              path: h.path,
              fileName: h.fileName,
              snippet: h.matches[0]?.snippet ?? "",
              score: 1 / (i + 1), // reciprocal-rank score as a proxy
              source: "keyword" as const,
            }));
          }

          // Trim to requested k.
          const trimmed = results.slice(0, k);

          await invoke("mcp_semantic_search_result", {
            searchId,
            ok: true,
            results: trimmed,
            usedEmbeddings: !!modelAvailable,
            error: null,
          }).catch(() => {/* non-fatal */});
        } catch (err) {
          const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
          await invoke("mcp_semantic_search_result", {
            searchId,
            ok: false,
            results: [],
            usedEmbeddings: false,
            error: errStr,
          }).catch(() => {/* non-fatal */});
        }
      }),
    );

    // mcp://batch-export — export multiple documents concurrently.
    //
    // Each entry in the payload carries { path, format, outputDir? }.  We open
    // each document, run the matching export function, and collect per-file
    // results.  All exports run concurrently (Promise.all) to minimise latency.
    // We reply via `mcp_batch_export_result` keyed by batchId and always reply
    // even on partial failure so the Rust worker never parks.
    unlisteners.push(
      listen<BatchExportPayload>("mcp://batch-export", async (e) => {
        const { batchId, exports: entries } = e.payload;

        if (!entries || entries.length === 0) {
          await invoke("mcp_batch_export_result", {
            batchId,
            ok: false,
            results: [],
            error: "`exports` array must not be empty",
          }).catch(() => {/* non-fatal */});
          return;
        }

        // Run all exports concurrently — each is independent.
        const results: BatchExportFileResult[] = await Promise.all(
          entries.map(async (entry): Promise<BatchExportFileResult> => {
            const { path: filePath, format, outputDir } = entry;
            try {
              // Derive a title from the file name (strip extension).
              const fileName = filePath.split("/").pop() ?? filePath;
              const title = fileName.replace(/\.(md|markdown|mdown|mkd|mdx)$/i, "") || "export";

              if (format === "pdf") {
                await exportPdf(title);
              } else if (format === "docx") {
                await exportDocx(title);
              } else {
                await exportHtml(title);
              }

              // Derive output path: outputDir + title + extension (best-effort).
              const ext = format === "docx" ? "docx" : format === "pdf" ? "pdf" : "html";
              const dir = outputDir ?? filePath.substring(0, filePath.lastIndexOf("/")) ?? ".";
              const outputPath = `${dir}/${title}.${ext}`;

              return { path: filePath, format, ok: true, outputPath };
            } catch (err) {
              const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
              return { path: filePath, format, ok: false, error: errStr };
            }
          }),
        );

        const allOk = results.every((r) => r.ok);
        await invoke("mcp_batch_export_result", {
          batchId,
          ok: allOk,
          results,
          error: allOk ? null : "One or more exports failed — see per-file results.",
        }).catch(() => {/* non-fatal */});
      }),
    );

    // mcp://diff-docs — compare two document paths and return a unified diff.
    //
    // Forwards the two paths to Rust (`mcp_diff_docs`) which reads both files
    // from disk, computes a unified diff with `contextLines` context lines, and
    // returns { diff, hunks, added, removed, pathA, pathB }.  We echo the
    // result via `mcp_diff_docs_result` keyed by diffId.
    //
    // Like all reply-required handlers, we always call `mcp_diff_docs_result`
    // — success or failure — so the Rust worker never parks waiting.
    unlisteners.push(
      listen<DiffDocsPayload>("mcp://diff-docs", async (e) => {
        const { diffId, pathA, pathB, contextLines = 3 } = e.payload;
        try {
          const result = await invoke<{
            diff: string;
            hunks: number;
            added: number;
            removed: number;
            path_a: string;
            path_b: string;
          }>("mcp_diff_docs", {
            pathA,
            pathB,
            contextLines,
          });
          await invoke("mcp_diff_docs_result", {
            diffId,
            ok: true,
            diff: result.diff,
            hunks: result.hunks,
            added: result.added,
            removed: result.removed,
            pathA: result.path_a,
            pathB: result.path_b,
            error: null,
          }).catch(() => {/* non-fatal */});
        } catch (err) {
          const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
          await invoke("mcp_diff_docs_result", {
            diffId,
            ok: false,
            diff: "",
            hunks: 0,
            added: 0,
            removed: 0,
            pathA,
            pathB,
            error: errStr,
          }).catch(() => {/* non-fatal */});
        }
      }),
    );

    // Track each listener's unlisten fn as it resolves (or unlisten on the spot
    // if we've already been disposed).
    for (const p of unlisteners) {
      p.then((fn) => {
        if (disposed) fn();
        else live.push(fn);
      });
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────
    return () => {
      disposed = true;
      unsubDoc();
      unsubRecent();
      unsubActivity();
      unsubConversation();
      if (syncTimer.current !== null) clearTimeout(syncTimer.current);
      if (vaultTimer.current !== null) clearTimeout(vaultTimer.current);
      if (sessionTimer.current !== null) clearTimeout(sessionTimer.current);
      // Unlisten everything already registered; late arrivals self-unlisten above.
      for (const fn of live) fn();
    };
  }, []); // Mount once — stores are singletons, no deps needed.
}
