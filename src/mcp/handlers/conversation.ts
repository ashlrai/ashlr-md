/**
 * MCP navigation handlers — open and present.
 *
 * Each exported function registers a single `listen()` call and returns the
 * resulting Promise<UnlistenFn> so the bridge can collect them for cleanup.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useDocumentStore } from "../../store/documentStore";
import { useUiStore } from "../../store/uiStore";
import type { OpenPayload, PresentPayload } from "./types";

// ── mcp://open ────────────────────────────────────────────────────────────────

export function handleOpen(): Promise<UnlistenFn> {
  return listen<OpenPayload>("mcp://open", (e) => {
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
  });
}

// ── mcp://present ─────────────────────────────────────────────────────────────

export function handlePresent(): Promise<UnlistenFn> {
  return listen<PresentPayload>("mcp://present", (e) => {
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
  });
}
