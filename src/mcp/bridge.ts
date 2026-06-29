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
 *
 * ## Architecture
 *
 * Handler implementations live in src/mcp/handlers/:
 *   - export.ts      — PDF/DOCX/HTML/EPUB/archive/canvas-graph/outline/batch-export/profiles
 *   - edit.ts        — set-content, edit, batch-edit, atomic-edits, stream-edit, stream-edit-apply
 *   - search.ts      — batch-read, semantic-search, diff-docs
 *   - review.ts      — request_review
 *   - canvas.ts      — edit-canvas
 *   - conversation.ts — open, present, ot-op, copy-rich-text, lint-document, apply-diff-hunk
 *
 * This file is responsible only for:
 *   1. PUSH sync subscriptions (documentStore → Rust, vault → Rust, session → Rust)
 *   2. Wiring all handler Promises into the unlisteners array and cleanup
 */

import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { useActivityStore } from "../store/activityStore";
import { useConversationStore } from "../store/memoryStore";
import { useDocumentStore } from "../store/documentStore";
import { useRecentStore } from "../store/recentStore";
import { syncDocToSession } from "../store/sessionPersistenceStore";

// ── Handler modules ───────────────────────────────────────────────────────────
import {
  handleExportPayload,
  handleMarkdownArchive,
  handleCanvasGraphExport,
  handleOutlineExport,
  handleBatchExport,
  handleBatchExportProfiles,
} from "./handlers/export";
import {
  handleSetContent,
  handleAtomicEdit,
  handleBatchEdit,
  handleAtomicEdits,
  handleStreamEdit,
  handleStreamEditApply,
} from "./handlers/edit";
import {
  handleBatchRead,
  handleSemanticSearch,
  handleDiffDocs,
} from "./handlers/search";
import { handleRequestReview } from "./handlers/review";
import { handleEditCanvas } from "./handlers/canvas";
import {
  handleOpen,
  handlePresent,
  handleOtOp,
  handleCopyRichText,
  handleLintDocument,
  handleApplyDiffHunk,
} from "./handlers/conversation";

// ── Re-exports (public API surface unchanged) ─────────────────────────────────

export type {
  AtomicEditEntry,
  AtomicEditFileResult,
  BatchExportEntry,
  BatchExportFileResult,
  BatchExportProfileResult,
  BatchReadFileResult,
  BatchEditOpResult,
  ExportEpubPayload,
  StreamEditPayload,
  StreamEditApplyPayload,
  StreamEditCandidateResult,
} from "./handlers/types";

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

    const existing = useConversationStore.getState().messages;
    const existingIds = new Set(existing.map((m) => m.id));
    const newMessages = messages.filter((m) => !existingIds.has(m.id));
    if (newMessages.length > 0) {
      useConversationStore.setState((s) => ({
        messages: [...s.messages, ...newMessages],
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
        console.warn("[mcp bridge] mcp_sync_state failed:", e);
      });
    };

    const scheduleSync = () => {
      if (syncTimer.current !== null) clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(syncNow, 200);
    };

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

    const schedulePersistenceSync = () => {
      const { path, content } = useDocumentStore.getState();
      if (path && content) {
        syncDocToSession(path, content).catch(() => {
          // Non-fatal — persistence is best-effort.
        });
      }
    };

    const unsubDoc = useDocumentStore.subscribe(scheduleSync);
    const unsubDocPersistence = useDocumentStore.subscribe(schedulePersistenceSync);
    const unsubRecent = useRecentStore.subscribe(scheduleSync);
    const unsubActivity = useActivityStore.subscribe(scheduleVaultSync);
    const unsubConversation = useConversationStore.subscribe(scheduleSessionSync);

    syncNow();
    syncVaultNow();

    // ── 2. Wire all handler modules into the unlisteners array ──────────────
    const unlisteners: Promise<UnlistenFn>[] = [];
    let disposed = false;
    const live: UnlistenFn[] = [];

    // conversation / navigation
    unlisteners.push(handleOpen());
    unlisteners.push(handlePresent());
    unlisteners.push(handleOtOp(syncNow));
    unlisteners.push(handleCopyRichText());
    unlisteners.push(handleLintDocument(syncNow));
    unlisteners.push(handleApplyDiffHunk(syncNow));

    // review
    unlisteners.push(handleRequestReview());

    // edit
    unlisteners.push(handleSetContent(syncNow));
    unlisteners.push(handleAtomicEdit(syncNow));
    unlisteners.push(handleBatchEdit(syncNow));
    unlisteners.push(handleAtomicEdits(syncNow));
    unlisteners.push(handleStreamEdit(syncNow));
    unlisteners.push(handleStreamEditApply(syncNow));

    // search
    unlisteners.push(handleBatchRead());
    unlisteners.push(handleSemanticSearch());
    unlisteners.push(handleDiffDocs());

    // export
    unlisteners.push(handleExportPayload());
    unlisteners.push(handleMarkdownArchive());
    unlisteners.push(handleCanvasGraphExport());
    unlisteners.push(handleOutlineExport());
    unlisteners.push(handleBatchExport());
    unlisteners.push(handleBatchExportProfiles());

    // canvas
    unlisteners.push(handleEditCanvas());

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
      unsubDocPersistence();
      unsubRecent();
      unsubActivity();
      unsubConversation();
      if (syncTimer.current !== null) clearTimeout(syncTimer.current);
      if (vaultTimer.current !== null) clearTimeout(vaultTimer.current);
      if (sessionTimer.current !== null) clearTimeout(sessionTimer.current);
      for (const fn of live) fn();
    };
  }, []); // Mount once — stores are singletons, no deps needed.
}
