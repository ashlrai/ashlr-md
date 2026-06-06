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
 *   Subscribes to the Zustand documentStore and recentStore.  On every change
 *   (debounced 200 ms) it calls `mcp_sync_state` so the IPC `/content` and
 *   `/recent` endpoints always return fresh data.
 *
 * PULL (Rust → frontend):
 *   Listens for three Tauri events emitted by the IPC server (or deep-link
 *   handler) and routes them to the appropriate store action:
 *     - `mcp://open`        → documentStore.openPath()
 *     - `mcp://set-content` → documentStore.setContent() [+ optional save]
 *     - `mcp://export`      → uiStore.openExport() after optionally switching doc
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { useDocumentStore } from "../store/documentStore";
import { useRecentStore } from "../store/recentStore";
import { useReviewStore } from "../store/reviewStore";
import { useUiStore } from "../store/uiStore";

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

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMcpBridge(): void {
  // Keep a ref to the debounce timer so we can clear it on cleanup.
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    // Subscribe to both stores.  Zustand subscribe returns an unsubscribe fn.
    const unsubDoc = useDocumentStore.subscribe(scheduleSync);
    const unsubRecent = useRecentStore.subscribe(scheduleSync);

    // Push the current state immediately on mount.
    syncNow();

    // ── 2. Listen for Tauri events from the IPC server ──────────────────────
    const unlisteners: Promise<UnlistenFn>[] = [];

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

    // mcp://export — open the export dialog (format hint passed along)
    unlisteners.push(
      listen<ExportPayload>("mcp://export", () => {
        // The export dialog is owned by uiStore; open it. (The payload's
        // format hint is reserved for future programmatic pre-selection.)
        if (useDocumentStore.getState().path) {
          useUiStore.getState().openExport();
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

    // ── Cleanup ──────────────────────────────────────────────────────────────
    return () => {
      unsubDoc();
      unsubRecent();
      if (syncTimer.current !== null) clearTimeout(syncTimer.current);
      // Resolve all unlisten promises and call each one.
      Promise.all(unlisteners).then((fns) => {
        for (const fn of fns) fn();
      });
    };
  }, []); // Mount once — stores are singletons, no deps needed.
}
