/**
 * MCP edit handlers — set-content, edit (find/replace), stream-edit, and
 * stream-edit-apply.
 *
 * Each exported function registers a single `listen()` call and returns the
 * resulting Promise<UnlistenFn> so the bridge can collect them for cleanup.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useDocumentStore } from "../../store/documentStore";
import {
  applyEditAtOccurrence,
  applyUniqueEdit,
  computeStreamEditDiff,
} from "../applyEdit";
import type {
  EditPayload,
  SetContentPayload,
  StreamEditApplyPayload,
  StreamEditCandidateResult,
  StreamEditPayload,
} from "./types";

/**
 * Save the open document for an edit that asked for `save: true`. Returns
 * `null` when it reached disk, or the reason it did not. `save()` reports a
 * failed write only through a toast and `error`, and does nothing for a
 * document with no file, so its success is read back from `diskContent`.
 */
async function saveForAgent(): Promise<string | null> {
  const doc = useDocumentStore.getState();
  if (!doc.path) return "the document has no file yet; save it from the app first";
  const target = doc.content;
  await doc.save();
  const after = useDocumentStore.getState();
  if (after.diskContent === target) return null;
  return after.error ?? "the write failed";
}

function notSaved(reason: string, what = "Edit applied to"): string {
  return `${what} the open document but not saved: ${reason}`;
}

/**
 * What the stream edits answer when `path` names another document. It used
 * to stop at "is not the currently open document." with no next step; the
 * Rust check for `edit_document` names `open_file`, and so does this.
 */
function pathMismatch(path: string): string {
  return `Path mismatch: '${path}' is not the currently open document. Open it first with open_file.`;
}

/** What set-content and the edits answer when no document is open. */
const NO_DOCUMENT_OPEN = "No document is open in Ashlr MD; open one first (open_file).";

/**
 * The welcome screen: no file and an empty buffer. The find/replace edits
 * check this, so the agent is told to open a document rather than that its
 * `find` text was not found.
 */
function noDocumentOpen(): boolean {
  const { path, content } = useDocumentStore.getState();
  return !path && content === "";
}

// ── mcp://set-content ─────────────────────────────────────────────────────────

/**
 * Replace the open document's content, saving it when asked, and report the
 * outcome on `mcp_edit_result` (the IPC `/content` round-trip waits for it).
 */
export function handleSetContent(syncNow: () => void): Promise<UnlistenFn> {
  return listen<SetContentPayload>("mcp://set-content", async (e) => {
    const { editId, content, save } = e.payload;
    let error: string | null = null;
    if (!useDocumentStore.getState().path) {
      // With no document open the window shows its welcome screen, so the
      // content would land in a buffer nobody sees and still read as ok.
      error = NO_DOCUMENT_OPEN;
    } else {
      try {
        useDocumentStore.getState().setContent(content);
        if (save) {
          const reason = await saveForAgent();
          if (reason !== null) error = notSaved(reason, "Content replaced in");
        }
        syncNow();
      } catch (err) {
        error = `Replacing the content failed in app: ${String(err)}`;
      }
    }
    if (editId === undefined) return;
    await invoke("mcp_edit_result", {
      editId,
      ok: error === null,
      replaced: error === null ? 1 : 0,
      error,
    }).catch((e2) => {
      console.error("[mcp bridge] mcp_edit_result reply for set-content failed:", e2);
    });
  });
}

// ── mcp://edit ────────────────────────────────────────────────────────────────

export function handleAtomicEdit(syncNow: () => void): Promise<UnlistenFn> {
  return listen<EditPayload>("mcp://edit", async (e) => {
    const { editId, find, replace, save } = e.payload;
    let reply: { ok: boolean; replaced: number; error: string | null };
    try {
      const liveContent = useDocumentStore.getState().content;
      if (noDocumentOpen()) {
        // The edit used to be refused as "`find` string not found", which
        // sent the agent looking for its text instead of opening a document.
        reply = { ok: false, replaced: 0, error: NO_DOCUMENT_OPEN };
      } else {
        const outcome = applyUniqueEdit(liveContent, find, replace);
        let saveError: string | null = null;
        if (outcome.ok && outcome.content !== undefined) {
          useDocumentStore.getState().setContent(outcome.content);
          if (save) {
            saveError = await saveForAgent();
          }
          syncNow();
        }
        reply = {
          ok: outcome.ok && saveError === null,
          replaced: outcome.replaced,
          error: saveError !== null ? notSaved(saveError) : (outcome.error ?? null),
        };
      }
    } catch (err) {
      reply = { ok: false, replaced: 0, error: `Edit failed in app: ${String(err)}` };
    }
    // One reply only. When sending it fails, a second "Edit failed" reply
    // would tell the agent an edit that was applied did not happen, and a
    // retry would apply it twice.
    await invoke("mcp_edit_result", { editId, ...reply }).catch((e2) => {
      console.error("[mcp bridge] mcp_edit_result reply for edit failed:", e2);
    });
  });
}

// ── mcp://stream-edit ─────────────────────────────────────────────────────────

export function handleStreamEdit(syncNow: () => void): Promise<UnlistenFn> {
  return listen<StreamEditPayload>("mcp://stream-edit", async (e) => {
    const {
      editId,
      path: assertPath,
      find,
      replace,
      preview = true,
      previewLines = 5,
    } = e.payload;

    if (assertPath) {
      const openPath = useDocumentStore.getState().path;
      if (!openPath || openPath !== assertPath) {
        await invoke("mcp_stream_edit_preview", {
          editId,
          ok: false,
          diff: "",
          candidates: null,
          matchCount: 0,
          previewLines,
          error: pathMismatch(assertPath),
        }).catch(() => {
          /* non-fatal */
        });
        return;
      }
    }

    if (noDocumentOpen()) {
      await invoke("mcp_stream_edit_preview", {
        editId,
        ok: false,
        diff: "",
        candidates: null,
        matchCount: 0,
        previewLines,
        error: NO_DOCUMENT_OPEN,
      }).catch(() => {
        /* non-fatal */
      });
      return;
    }

    // Any throw below still gets a reply, so the agent sees the reason
    // instead of waiting out the round-trip timeout.
    try {
      const liveContent = useDocumentStore.getState().content;

      if (!preview) {
        const outcome = applyUniqueEdit(liveContent, find, replace);
        if (outcome.ok && outcome.content !== undefined) {
          useDocumentStore.getState().setContent(outcome.content);
          syncNow();
        }
        await invoke("mcp_stream_edit_preview", {
          editId,
          ok: outcome.ok,
          diff: "",
          candidates: null,
          matchCount: outcome.ok ? 1 : 0,
          previewLines,
          error: outcome.error ?? null,
        }).catch(() => {
          /* non-fatal */
        });
        return;
      }

      const label = useDocumentStore.getState().path ?? "document";
      const result = computeStreamEditDiff(
        liveContent,
        find,
        replace,
        previewLines,
        label,
      );

      const candidates: StreamEditCandidateResult[] | null = result.candidates
        ? result.candidates.map((c) => ({
            matchIndex: c.matchIndex,
            startLine: c.startLine,
            diff: c.diff,
            rank: c.rank,
          }))
        : null;

      await invoke("mcp_stream_edit_preview", {
        editId,
        ok: result.ok,
        diff: result.diff ?? "",
        candidates,
        matchCount: result.matchCount,
        previewLines,
        error: result.error ?? null,
      }).catch(() => {
        /* non-fatal */
      });
    } catch (err) {
      await invoke("mcp_stream_edit_preview", {
        editId,
        ok: false,
        diff: "",
        candidates: null,
        matchCount: 0,
        previewLines,
        error: `stream-edit failed in app: ${String(err)}`,
      }).catch(() => {
        /* non-fatal */
      });
    }
  });
}

// ── mcp://stream-edit-apply ───────────────────────────────────────────────────

export function handleStreamEditApply(syncNow: () => void): Promise<UnlistenFn> {
  return listen<StreamEditApplyPayload>("mcp://stream-edit-apply", async (e) => {
    const { editId, matchIndex = 0, save = false, path: assertPath } = e.payload;

    if (assertPath) {
      const openPath = useDocumentStore.getState().path;
      if (!openPath || openPath !== assertPath) {
        await invoke("mcp_stream_edit_apply_result", {
          editId,
          ok: false,
          replaced: 0,
          matchIndex,
          error: pathMismatch(assertPath),
        }).catch(() => {
          /* non-fatal */
        });
        return;
      }
    }

    const applyPayload = e.payload as StreamEditApplyPayload & {
      find?: string;
      replace?: string;
    };
    const find = applyPayload.find ?? "";
    const replace = applyPayload.replace ?? "";

    if (!find) {
      await invoke("mcp_stream_edit_apply_result", {
        editId,
        ok: false,
        replaced: 0,
        matchIndex,
        error: "`find` is required in stream-edit-apply payload.",
      }).catch(() => {
        /* non-fatal */
      });
      return;
    }

    if (noDocumentOpen()) {
      await invoke("mcp_stream_edit_apply_result", {
        editId,
        ok: false,
        replaced: 0,
        matchIndex,
        error: NO_DOCUMENT_OPEN,
      }).catch(() => {
        /* non-fatal */
      });
      return;
    }

    const liveContent = useDocumentStore.getState().content;

    try {
      const outcome = applyEditAtOccurrence(liveContent, find, replace, matchIndex);
      let saveError: string | null = null;
      if (outcome.ok && outcome.content !== undefined) {
        useDocumentStore.getState().setContent(outcome.content);
        if (save) {
          saveError = await saveForAgent();
        }
        syncNow();
      }
      await invoke("mcp_stream_edit_apply_result", {
        editId,
        ok: outcome.ok && saveError === null,
        replaced: outcome.replaced,
        matchIndex,
        error: saveError !== null ? notSaved(saveError) : (outcome.error ?? null),
      }).catch(() => {
        /* non-fatal */
      });
    } catch (err) {
      await invoke("mcp_stream_edit_apply_result", {
        editId,
        ok: false,
        replaced: 0,
        matchIndex,
        error: `stream-edit-apply failed: ${String(err)}`,
      }).catch(() => {
        /* non-fatal */
      });
    }
  });
}
