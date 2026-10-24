/**
 * closeGuard.ts — ask before closing a window with unsaved edits.
 *
 * Rust holds a close request while the window says it has unsaved edits
 * (src-tauri/src/close_guard.rs) and sends `close-guard://request`. The
 * window acknowledges it at once, asks the user (Save All, Close Without
 * Saving, Cancel) and answers. It fails safe: a window that does not
 * acknowledge in time is closed by Rust, and a guard that throws answers
 * "close", as the window closed before. The unsaved text is kept for the
 * next launch either way (see unsavedBuffers.ts), unless the user chose to
 * close without saving.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type Tab, useDocumentStore } from "../store/documentStore";
import { flushPendingEdits, onPendingEdit } from "./pendingEdits";
import { discardBuffers } from "./unsavedBuffers";

export const CLOSE_REQUEST_EVENT = "close-guard://request";

/** Button labels of the close prompt. */
export const CLOSE_SAVE_ALL = "Save All";
export const CLOSE_DISCARD = "Close Without Saving";
export const CLOSE_CANCEL = "Cancel";

export type CloseChoice = "save" | "discard" | "cancel";

export interface UnsavedTab {
  id: string;
  fileName: string;
}

type DocState = ReturnType<typeof useDocumentStore.getState>;

/**
 * The tabs whose text is not on disk: edited, or holding a file that was
 * deleted or moved since (its text is only in the tab). The active tab's
 * live fields are the top-level mirror.
 */
export function unsavedTabs(s: DocState): UnsavedTab[] {
  return s.tabs
    .map((t: Tab) =>
      t.id === s.activeId ? { ...t, isDirty: s.isDirty, missing: s.missing } : t,
    )
    .filter((t) => t.isDirty || t.missing)
    .map((t) => ({ id: t.id, fileName: t.fileName }));
}

/** The prompt's text for these documents. */
export function closePromptText(names: string[]): string {
  if (names.length === 1) {
    return `"${names[0]}" has unsaved changes. Save them before closing?`;
  }
  const shown = names.slice(0, 5).map((n) => `"${n}"`);
  const more = names.length - shown.length;
  const list = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
  return `${names.length} documents have unsaved changes (${list}). Save them before closing?`;
}

/** Map the dialog's answer (a button label, or Yes/No/Cancel) to a choice. */
export function choiceFromAnswer(answer: string): CloseChoice {
  if (answer === CLOSE_SAVE_ALL || answer === "Yes") return "save";
  if (answer === CLOSE_DISCARD || answer === "No") return "discard";
  return "cancel";
}

export interface CloseGuardDeps {
  /** The tabs with unsaved text, read when asked. */
  unsaved: () => UnsavedTab[];
  /** Ask the user. May throw (no dialog): the window then closes. */
  ask: (names: string[]) => Promise<CloseChoice>;
  /** Save one tab: null once it is on disk, else why not. */
  save: (tabId: string) => Promise<string | null>;
  /** The user chose to drop the edits: forget the copy kept for next launch. */
  discard: () => void;
}

/**
 * Decide whether the window may close. "cancel" keeps it open: the user
 * cancelled, a save failed or was cancelled (its error is shown), or text
 * was edited during the saves.
 */
export async function decideClose(deps: CloseGuardDeps): Promise<"close" | "cancel"> {
  const tabs = deps.unsaved();
  if (tabs.length === 0) return "close";
  const choice = await deps.ask(tabs.map((t) => t.fileName));
  if (choice === "cancel") return "cancel";
  if (choice === "discard") {
    deps.discard();
    return "close";
  }
  for (const t of tabs) {
    if ((await deps.save(t.id)) !== null) return "cancel";
  }
  return deps.unsaved().length === 0 ? "close" : "cancel";
}

async function askWithDialog(names: string[]): Promise<CloseChoice> {
  const { message } = await import("@tauri-apps/plugin-dialog");
  const answer = await message(closePromptText(names), {
    title: "Unsaved changes",
    kind: "warning",
    buttons: { yes: CLOSE_SAVE_ALL, no: CLOSE_DISCARD, cancel: CLOSE_CANCEL },
  });
  return choiceFromAnswer(answer);
}

/**
 * How long after the last unreported edit the close guard takes the edits
 * and reports what is true: past the editor's own report (200 ms after the
 * last keystroke), so it is usually a report already made.
 */
export const PENDING_EDIT_RECHECK_MS = 500;

export interface InstallOptions {
  /** Forget the kept copy of unsaved text (Close Without Saving). */
  discard?: () => void;
  ask?: (names: string[]) => Promise<CloseChoice>;
}

/**
 * Report the unsaved state to Rust as it changes and answer its close
 * requests. Returns a function that stops both.
 */
export async function installCloseGuard(
  opts: InstallOptions = {},
): Promise<() => void> {
  const store = useDocumentStore;
  const deps: CloseGuardDeps = {
    // What was just typed counts: the editor reports it 200 ms late.
    unsaved: () => {
      flushPendingEdits();
      return unsavedTabs(store.getState());
    },
    ask: opts.ask ?? askWithDialog,
    save: (tabId) => store.getState().save({ tabId }),
    discard: opts.discard ?? discardBuffers,
  };

  let latest = 0;
  let asking = false;
  let unlisten: () => void;
  try {
    unlisten = await listen<number>(CLOSE_REQUEST_EVENT, (e) => {
      latest = e.payload;
      void invoke("close_guard_ack", { id: latest }).catch(() => {});
      // Asked again while the prompt is up: the answer goes to this id.
      if (asking) return;
      asking = true;
      void decideClose(deps)
        // A guard that throws closes the window, as it closed before.
        .catch(() => "close" as const)
        .then((outcome) =>
          invoke("close_guard_resolve", { id: latest, close: outcome === "close" }),
        )
        .catch(() => {})
        .finally(() => {
          asking = false;
        });
    });
  } catch {
    // No listener: unsaved state is never reported, so closes go ahead.
    return () => {};
  }
  // Reported only once requests are heard: a window that says it has
  // unsaved edits but cannot answer is closed only after the timeout.
  let reported: boolean | null = null;
  const report = () => {
    const unsaved = unsavedTabs(store.getState()).length > 0;
    if (unsaved === reported) return;
    reported = unsaved;
    invoke("close_guard_set_unsaved", { unsaved }).catch(() => {
      // Not reported: try again on the next change.
      reported = null;
    });
  };

  const unsub = store.subscribe(report);
  // Once the edits have gone quiet, take them and say what is true: an edit
  // that proves to be no change (a character typed and deleted, a mark put
  // on and off) changes nothing in the store, so the window said it had
  // unsaved edits until the next store change, and a close asked it first.
  let recheck: ReturnType<typeof setTimeout> | null = null;
  const settle = () => {
    recheck = null;
    flushPendingEdits();
    report();
  };
  // An edit the editor has not reported yet: unsaved, said at once, so a
  // close in the 200 ms before the report asks the window, which takes the
  // edit first (deps.unsaved). Rust used to close the window, and the edit
  // was gone.
  const unhear = onPendingEdit(() => {
    if (recheck !== null) clearTimeout(recheck);
    recheck = setTimeout(settle, PENDING_EDIT_RECHECK_MS);
    if (reported === true) return;
    reported = true;
    invoke("close_guard_set_unsaved", { unsaved: true }).catch(() => {
      reported = null;
    });
  });
  report();
  return () => {
    if (recheck !== null) clearTimeout(recheck);
    unhear();
    unsub();
    unlisten();
    // Nothing answers requests now: let closes go ahead.
    invoke("close_guard_set_unsaved", { unsaved: false }).catch(() => {});
  };
}
