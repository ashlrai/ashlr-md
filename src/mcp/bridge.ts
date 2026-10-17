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
 *   - export.ts      — PDF/DOCX/HTML/EPUB
 *   - edit.ts        — set-content, edit, stream-edit, stream-edit-apply
 *   - review.ts      — request_review
 *   - conversation.ts — open, present
 *
 * This file is responsible only for:
 *   1. PUSH sync subscriptions (documentStore → Rust, vault → Rust, session → Rust)
 *   2. Wiring all handler Promises into the unlisteners array and cleanup
 */

import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { useActivityStore } from "../store/activityStore";
import { useDocumentStore } from "../store/documentStore";
import { useConversationStore } from "../store/memoryStore";
import { useRecentStore } from "../store/recentStore";
import { syncDocToSession } from "../store/sessionPersistenceStore";
// ── Handler modules ───────────────────────────────────────────────────────────
import { handleOpen, handlePresent } from "./handlers/conversation";
import {
  handleAtomicEdit,
  handleSetContent,
  handleStreamEdit,
  handleStreamEditApply,
} from "./handlers/edit";
import { handleExportPayload } from "./handlers/export";
import { handleRequestReview } from "./handlers/review";

// ── Re-exports (public API surface unchanged) ─────────────────────────────────

export type {
  StreamEditApplyPayload,
  StreamEditCandidateResult,
  StreamEditPayload,
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
      const { watchedDir, files, truncated } = useActivityStore.getState();
      invoke("mcp_sync_vault", {
        watchedDir: watchedDir ?? null,
        files: files.map((f) => ({ path: f.path, name: f.name, dir: f.dir })),
        truncated,
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

    // review
    unlisteners.push(handleRequestReview());

    // edit
    unlisteners.push(handleSetContent(syncNow));
    unlisteners.push(handleAtomicEdit(syncNow));
    unlisteners.push(handleStreamEdit(syncNow));
    unlisteners.push(handleStreamEditApply(syncNow));

    // export
    unlisteners.push(handleExportPayload());

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
