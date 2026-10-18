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
 * is not, as `openPath()` resolves it. The outcome used to be read back from
 * the store (`error` set and another document open), so a failed read of the
 * path that was already open counted as opened.
 */
async function openForAgent(path: string): Promise<string | null> {
  return useDocumentStore.getState().openPath(path);
}

/**
 * What `present_document` without `path` answers when no document is open.
 * It used to stop at "No document is open to present." with no next step.
 */
export const NO_DOCUMENT_TO_PRESENT =
  "No document is open to present. Pass `path` to present_document, or call open_file with the document's `path` first.";

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
        error = useDocumentStore.getState().path ? null : NO_DOCUMENT_TO_PRESENT;
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
