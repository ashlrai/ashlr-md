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
  findAllOccurrences,
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

// ── stream_edit previews ──────────────────────────────────────────────────────

/** What a `stream_edit` preview was made from, keyed by its `editId`. */
interface StreamEditPreview {
  path: string | null;
  find: string;
  replace: string;
}

/**
 * The previews this window made and has not applied yet. `stream_edit_apply`
 * used to forward its `editId` without looking at it, so an apply of a
 * preview made for another document (or by an app that has since restarted)
 * re-found `find` in whatever document was open. Bounded: the oldest preview
 * goes first.
 */
const streamEditPreviews = new Map<string, StreamEditPreview>();
const MAX_STREAM_EDIT_PREVIEWS = 64;

function rememberPreview(editId: string, preview: StreamEditPreview): void {
  streamEditPreviews.set(editId, preview);
  while (streamEditPreviews.size > MAX_STREAM_EDIT_PREVIEWS) {
    const oldest = streamEditPreviews.keys().next().value;
    if (oldest === undefined) break;
    streamEditPreviews.delete(oldest);
  }
}

const FRESH_PREVIEW =
  "Call stream_edit again for a fresh preview, then stream_edit_apply with its editId.";

/**
 * Why the preview `originalEditId` names cannot be applied to the open
 * document, or `null` when it can. An omitted editId is not checked: the
 * apply then re-finds `find` in the open document, as it always did.
 */
function stalePreview(
  originalEditId: string | undefined,
  find: string,
  replace: string,
): string | null {
  if (!originalEditId) return null;
  const preview = streamEditPreviews.get(originalEditId);
  if (!preview) {
    return (
      `Unknown or stale editId '${originalEditId}': this Ashlr MD window has no pending ` +
      "stream_edit preview with that id (it was already applied, was made before the app " +
      `last started, or was never made). ${FRESH_PREVIEW}`
    );
  }
  const openPath = useDocumentStore.getState().path;
  if (preview.path !== openPath) {
    const was = preview.path ?? "an unsaved document";
    const now = openPath ?? "an unsaved document";
    return (
      `Stale editId '${originalEditId}': it previews '${was}', but the open document is ` +
      `now '${now}'. ${FRESH_PREVIEW}`
    );
  }
  if (preview.find !== find || preview.replace !== replace) {
    return (
      `editId '${originalEditId}' previewed a different find or replace. Send the find ` +
      `and replace of that preview, or call stream_edit again for a fresh preview.`
    );
  }
  return null;
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
          // The occurrences, as a preview counts them: a `find` that is not
          // unique used to answer 0.
          matchCount: outcome.ok ? 1 : findAllOccurrences(liveContent, find).length,
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

      if (result.ok) {
        rememberPreview(editId, {
          path: useDocumentStore.getState().path,
          find,
          replace,
        });
      }

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

    const stale = stalePreview(applyPayload.originalEditId, find, replace);
    if (stale !== null) {
      await invoke("mcp_stream_edit_apply_result", {
        editId,
        ok: false,
        replaced: 0,
        matchIndex,
        error: stale,
      }).catch(() => {
        /* non-fatal */
      });
      return;
    }

    const liveContent = useDocumentStore.getState().content;

    try {
      const outcome = applyEditAtOccurrence(liveContent, find, replace, matchIndex);
      // A preview applies once: a second apply would edit the document again.
      if (outcome.ok && applyPayload.originalEditId) {
        streamEditPreviews.delete(applyPayload.originalEditId);
      }
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
