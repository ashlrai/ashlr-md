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
 * failed write only through a toast and `error`, so its success is read
 * back from `diskContent`. Every caller has already refused a state with no
 * file (see `openDocumentPath`), so there is always a file to write: the
 * reason this used to give for a document with no file was never reached.
 */
async function saveForAgent(): Promise<string | null> {
  const doc = useDocumentStore.getState();
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
 * The open document's file, or `null` when no document is open: the window
 * shows its welcome screen. The app opens only files, so a state with no
 * path has no document, whatever its buffer holds. set-content and the
 * find/replace edits refuse it with `NO_DOCUMENT_OPEN`, so the agent is
 * told to open a document rather than that its `find` text was not found.
 * They used to refuse a path-less buffer only when it was also empty, so an
 * edit to one was applied out of sight and, with `save: true`, reported as
 * "applied but not saved".
 */
function openDocumentPath(): string | null {
  return useDocumentStore.getState().path || null;
}

// ── stream_edit previews ──────────────────────────────────────────────────────

/** What a `stream_edit` preview was made from, keyed by its `editId`. */
interface StreamEditPreview {
  /** Always a file: a stream edit with no document open is refused first. */
  path: string;
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
 * Why the preview `originalEditId` names cannot be applied to the document
 * open at `openPath`, or `null` when it can. An omitted editId is not
 * checked: the apply then re-finds `find` in the open document, as it always
 * did. Both paths are files (a preview is made, and an apply checked, only
 * with a document open), so the name this used to put in for a document
 * with no file was never reached.
 */
function stalePreview(
  originalEditId: string | undefined,
  find: string,
  replace: string,
  openPath: string,
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
  if (preview.path !== openPath) {
    return (
      `Stale editId '${originalEditId}': it previews '${preview.path}', but the open document is ` +
      `now '${openPath}'. ${FRESH_PREVIEW}`
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
    if (openDocumentPath() === null) {
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
      if (openDocumentPath() === null) {
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

    const docPath = openDocumentPath();
    if (docPath === null) {
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

      const result = computeStreamEditDiff(
        liveContent,
        find,
        replace,
        previewLines,
        docPath,
      );

      if (result.ok) {
        rememberPreview(editId, {
          path: docPath,
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

    const docPath = openDocumentPath();
    if (docPath === null) {
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

    const stale = stalePreview(applyPayload.originalEditId, find, replace, docPath);
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
        // A refusal from the search (`find` not found, or `matchIndex` past
        // its last occurrence) says how many occurrences there are, as a
        // stream_edit refusal does. The refusals above did not search, so
        // they send none.
        ...(outcome.ok ? {} : { matchCount: findAllOccurrences(liveContent, find).length }),
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
