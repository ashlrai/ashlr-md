/**
 * MCP navigation handlers — open and present.
 *
 * Each exported function registers a single `listen()` call and returns the
 * resulting Promise<UnlistenFn> so the bridge can collect them for cleanup.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useDocumentStore } from "../../store/documentStore";
import { useUiStore } from "../../store/uiStore";
import type { OpenPayload, PresentPayload } from "./types";

/**
 * Open `path` for an agent. Returns `null` once it is open, or the reason it
 * is not. `openPath()` never rejects: it clears `error` before reading and
 * reports a failed read only by setting it (leaving the previous document
 * open), so the outcome is read back from the store.
 */
async function openForAgent(path: string): Promise<string | null> {
  await useDocumentStore.getState().openPath(path);
  const after = useDocumentStore.getState();
  if (after.error !== null && after.path !== path) return after.error;
  return null;
}

/**
 * Report an open or present to the IPC round-trip waiting on
 * `mcp_edit_result`. A payload with no `editId` (a review opening its file)
 * has nobody waiting, so the failure is only logged.
 */
async function replyToAgent(
  editId: string | undefined,
  error: string | null,
  what: string,
): Promise<void> {
  if (editId === undefined) {
    if (error !== null) console.warn(`[mcp bridge] ${what} failed:`, error);
    return;
  }
  await invoke("mcp_edit_result", {
    editId,
    ok: error === null,
    replaced: error === null ? 1 : 0,
    error,
  }).catch((e2) => {
    console.error(`[mcp bridge] mcp_edit_result reply for ${what} failed:`, e2);
  });
}

// ── mcp://open ────────────────────────────────────────────────────────────────

export function handleOpen(): Promise<UnlistenFn> {
  return listen<OpenPayload>("mcp://open", async (e) => {
    const { editId, path, mode } = e.payload;
    let error: string | null;
    try {
      error = await openForAgent(path);
      if (error === null && (mode === "edit" || mode === "read")) {
        useDocumentStore.getState().setViewMode(mode);
      }
    } catch (err) {
      error = `Opening ${path} failed in app: ${String(err)}`;
    }
    await replyToAgent(editId, error, "mcp://open");
  });
}

// ── mcp://present ─────────────────────────────────────────────────────────────

export function handlePresent(): Promise<UnlistenFn> {
  return listen<PresentPayload>("mcp://present", async (e) => {
    const { editId, path } = e.payload;
    let error: string | null;
    try {
      if (path) {
        error = await openForAgent(path);
      } else {
        error = useDocumentStore.getState().path
          ? null
          : "No document is open to present.";
      }
      if (error === null) {
        useDocumentStore.getState().setViewMode("read");
        useUiStore.getState().openZen();
      }
    } catch (err) {
      error = `Presenting failed in app: ${String(err)}`;
    }
    await replyToAgent(editId, error, "mcp://present");
  });
}
