import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  apply,
  type CursorPosition,
  classifySection,
  type EditSource,
  type OtLogEntry,
  type OtOperation,
  offsetToLineCol,
  resolveConflict,
  transformCursor,
} from "../lib/ot";
import { flushPendingEdits } from "../lib/pendingEdits";
import { useOtLogStore } from "./memoryStore";
import { isMissingFileError, useRecentStore } from "./recentStore";
import { toast } from "./toastStore";

export type ViewMode = "read" | "edit" | "source";

interface MarkdownFile {
  path: string;
  file_name: string;
  content: string;
  size: number;
  /** What the read saw; handed back to `write_markdown_file` as `expected`. */
  version?: string;
  /** `path` with links resolved: which file this is (see {@link fileKey}). */
  canonical_path?: string;
  /** The file's filesystem ignores case. */
  case_insensitive?: boolean;
  /** The file's filesystem ignores Unicode normalization (macOS). */
  normalization_insensitive?: boolean;
}

/**
 * What identifies the file a read named, to find its tab: the canonical path,
 * in NFC where the filesystem ignores normalization and lower-cased where it
 * ignores case. Tabs were matched by the path as given, so one file opened
 * through a symbolic link, with `..`, in the other Unicode form or in other
 * case opened twice, and each tab's save overwrote the other's. A filesystem
 * that tells `a.md` from `A.md` (or NFC from NFD) keeps them apart.
 */
export function fileKey(file: MarkdownFile): string {
  let key = file.canonical_path || file.path;
  if (file.normalization_insensitive) key = key.normalize("NFC");
  if (file.case_insensitive) key = key.toLowerCase();
  return key;
}

/**
 * Tags in a `write_markdown_file` error (src-tauri/src/document.rs): the
 * file changed on disk since it was read, or is gone. Either way nothing
 * was written.
 */
export const SAVE_CONFLICT_TAG = "[save-conflict]";
export const SAVE_MISSING_TAG = "[save-missing]";

/** The error without its tag, for a toast. */
function untagged(error: string): string {
  return error.replace(SAVE_CONFLICT_TAG, "").replace(SAVE_MISSING_TAG, "").trim();
}

/**
 * One open document. A Tab carries its OWN copy of every per-document field so
 * that switching away and back restores its exact state (content, view mode,
 * dirty flag, pending external change, etc.).
 *
 * `isLoading` / `error` are deliberately NOT per-tab — they're transient,
 * top-level-only UI state tied to whatever load is currently in flight.
 */
export interface Tab {
  id: string;
  /** Which file the tab holds, whatever path opened it ({@link fileKey}). */
  key: string;
  path: string;
  fileName: string;
  content: string;
  diskContent: string;
  size: number;
  viewMode: ViewMode;
  isDirty: boolean;
  externalChange: boolean;
  pendingDisk: string | null;
  /**
   * The `version` of the read `diskContent` came from, sent with a save so
   * it is refused when the file changed on disk since (null: unknown, the
   * save is not checked).
   */
  diskVersion: string | null;
  /** The `version` of `pendingDisk`. */
  pendingVersion: string | null;
  /**
   * The file was deleted or moved outside the app while open. The text is
   * kept, and a save asks before writing the file again (or the banner
   * offers Save As).
   */
  missing: boolean;
  reloadNonce: number;
  /** When true, show a live read-preview pane beside the editor. */
  splitView: boolean;
}

interface DocumentState {
  // ── Top-level (active-document) fields ──────────────────────────────────
  // INVARIANT: these always MIRROR the active tab. They ARE the live state of
  // the active document. Every action updates these AND writes the same values
  // through to `tabs[activeIndex]`, so inactive tabs retain their own state and
  // the ~20 components that read top-level fields keep working unchanged.
  path: string | null;
  fileName: string;
  /** Canonical, full document content (frontmatter + body). */
  content: string;
  /** Last content known to be on disk — basis for dirty + external-change checks. */
  diskContent: string;
  size: number;
  isLoading: boolean;
  error: string | null;
  viewMode: ViewMode;
  isDirty: boolean;
  /** Set when the file changed on disk while we hold unsaved edits. */
  externalChange: boolean;
  /** The on-disk content pending the user's reload/keep decision. */
  pendingDisk: string | null;
  /** See {@link Tab.diskVersion}. */
  diskVersion: string | null;
  /** See {@link Tab.pendingVersion}. */
  pendingVersion: string | null;
  /** See {@link Tab.missing}. */
  missing: boolean;
  /** Bumped to force editors to remount with fresh content (e.g. after reload). */
  reloadNonce: number;
  /** When true, render a live read preview beside the editor (per-document). */
  splitView: boolean;

  // ── Multi-document state ────────────────────────────────────────────────
  tabs: Tab[];
  activeId: string | null;

  /**
   * Remote OT operations that have been applied to the document but not yet
   * acknowledged / cleared. The Renderer reads this to draw margin badges.
   * Each entry is cleared after a short TTL by the bridge (or explicitly).
   */
  pendingOps: OtOperation[];

  /**
   * Remote cursor positions keyed by agentId.  Updated whenever a remote op
   * arrives or an explicit cursor-sync message is received.  The UI uses this
   * to render "ghost" cursor markers at the agent's current edit position.
   */
  remoteCursors: Record<string, CursorPosition>;

  /**
   * Whether to render remote cursor ghost markers in the editor.
   * Controlled by the "Show remote cursors" settings toggle.
   */
  showRemoteCursors: boolean;

  /**
   * In-memory OT operation log for the active document.  Entries are also
   * persisted to localStorage via `useOtLogStore` so sessions can be resumed
   * after reconnection without re-downloading the full document.
   */
  opLog: OtLogEntry[];

  /**
   * Open `path` in a tab (or switch to its tab). Never rejects: resolves to
   * `null` once it is open, or to the reason a read failed (also set as
   * `error`, with the previous document left open).
   */
  openPath: (path: string, opts?: OpenOptions) => Promise<string | null>;
  setContent: (content: string) => void;
  /**
   * Apply a remote OT operation atomically.
   * Returns `true` if the op was applied successfully, `false` if it failed
   * (e.g. the op is inconsistent with the current document length — this can
   * happen if the document was replaced wholesale via set-content before the
   * op arrived).  Failures are non-fatal; the caller should surface an error.
   */
  applyOp: (op: OtOperation) => boolean;
  /**
   * Apply an attributed OT operation, resolving conflicts using the edit-source
   * rules (agent wins in code/frontmatter, human wins in prose).
   *
   * The operation is applied using the standard OT `apply()` path; the
   * attribution determines which op takes precedence if there is a concurrent
   * local edit at the same position (the conflict resolution is advisory — it
   * influences the transform tie-break but the diamond property is preserved).
   *
   * Also updates the remote cursor position for the operation's agent and
   * appends the entry to `opLog`.
   *
   * Returns `true` on success, `false` on failure (same semantics as `applyOp`).
   */
  applyAttributedOp: (op: OtOperation, source: EditSource) => boolean;
  /** Remove all accumulated pending ops (e.g. after the badge TTL expires). */
  clearPendingOps: () => void;
  /**
   * Explicitly set / update a remote agent's cursor position.
   * Called when a cursor-sync message arrives independently of an op.
   */
  setRemoteCursor: (agentId: string, offset: number) => void;
  /** Toggle the "show remote cursors" preference. */
  toggleShowRemoteCursors: () => void;
  /** Return the op log entries for a given document path (for session resume). */
  getOpLog: (docPath: string) => OtLogEntry[];
  /** Clear the op log for a given document path. */
  clearOpLog: (docPath: string) => void;
  setViewMode: (mode: ViewMode) => void;
  toggleSplitView: () => void;
  /**
   * Save the active document (or `opts.tabId`'s). Resolves to `null` once it is on disk, or to
   * why it is not (also set as `error` and toasted). A file deleted or moved
   * since it was read is written again only after the user confirms;
   * `agent` saves never ask, and are refused instead.
   */
  save: (opts?: SaveOptions) => Promise<string | null>;
  /**
   * Save the active document under a name the user picks, which the tab
   * then follows. Resolves like `save` (`"cancelled"` when no name was picked).
   */
  saveAs: () => Promise<string | null>;
  /**
   * Read the active document's file again after the watcher reported a
   * change to `path`: hand its text to `handleDiskUpdate`, or flag the tab
   * `missing` when the file is gone.
   */
  refreshFromDisk: (path: string) => Promise<void>;
  /**
   * The watcher saw the active document's file (`from`) renamed to `to`
   * outside the app: the tab takes the new path (and name), is watched
   * there and read again. A tab on any other path is left as it is.
   */
  followRename: (from: string, to: string) => Promise<void>;
  /**
   * Open `content`, unsaved text kept for `path` whose file cannot be read
   * now, in a tab of its own, flagged as gone (the banner offers Save As and
   * Recreate, and closing asks first). Returns the new tab's id.
   */
  openRecovered: (recovered: {
    path: string;
    fileName: string;
    content: string;
  }) => string;
  /** `version` is the read's (`read_markdown_file`), when known. */
  handleDiskUpdate: (diskContent: string, version?: string | null) => void;
  acceptExternalChange: () => void;
  dismissExternalChange: () => void;
  close: () => void;

  // ── Tab actions ─────────────────────────────────────────────────────────
  switchTab: (id: string) => void;
  closeTab: (id: string) => void;
  nextTab: () => void;
  prevTab: () => void;
}

export interface OpenOptions {
  /**
   * Put the file at the top of Recents (default true). A session restore
   * passes false: reopening the last session's tabs is not opening them
   * anew, and it used to reorder Recents by tab order.
   */
  addRecent?: boolean;
}

export interface SaveOptions {
  /** A save an agent asked for: never shows a dialog. */
  agent?: boolean;
  /**
   * The tab to save (default: the active one). A save is of the document
   * it was asked for, whichever tab is active by the time it is written.
   */
  tabId?: string;
}

/** Why an agent save of a deleted or moved file is refused. */
export const MISSING_FILE_REASON =
  "the file was deleted or moved outside Ashlr MD; it is written again only when the user confirms (Save, or Save As)";

/**
 * The disk version of a tab opened by `openRecovered`: no read produces it
 * (a read's is `length:hash`).
 */
export const RECOVERED_VERSION = "recovered";

/** Fields a Tab and the top-level mirror share, sans `id`. */
type TabFields = Omit<Tab, "id" | "key">;

const EMPTY_TOP = {
  path: null,
  fileName: "",
  content: "",
  diskContent: "",
  size: 0,
  error: null,
  isDirty: false,
  externalChange: false,
  pendingDisk: null,
  diskVersion: null,
  pendingVersion: null,
  missing: false,
  viewMode: "read" as ViewMode,
  splitView: false,
};

let tabSeq = 0;
function newTabId(): string {
  tabSeq += 1;
  return `tab-${Date.now()}-${tabSeq}`;
}

/** Snapshot the current top-level per-document fields into a TabFields object. */
function topToTabFields(s: DocumentState): TabFields {
  return {
    path: s.path ?? "",
    fileName: s.fileName,
    content: s.content,
    diskContent: s.diskContent,
    size: s.size,
    viewMode: s.viewMode,
    isDirty: s.isDirty,
    externalChange: s.externalChange,
    pendingDisk: s.pendingDisk,
    diskVersion: s.diskVersion,
    pendingVersion: s.pendingVersion,
    missing: s.missing,
    reloadNonce: s.reloadNonce,
    splitView: s.splitView,
  };
}

/** The top-level mirror values that correspond to a tab's fields. */
function tabFieldsToTop(t: TabFields) {
  return {
    path: t.path,
    fileName: t.fileName,
    content: t.content,
    diskContent: t.diskContent,
    size: t.size,
    viewMode: t.viewMode,
    isDirty: t.isDirty,
    externalChange: t.externalChange,
    pendingDisk: t.pendingDisk,
    diskVersion: t.diskVersion,
    pendingVersion: t.pendingVersion,
    missing: t.missing,
    reloadNonce: t.reloadNonce,
    splitView: t.splitView,
  };
}

/**
 * Return a new `tabs` array with the active tab's fields overwritten by the
 * current top-level mirror. This is how every action keeps the active tab
 * entry in sync after mutating top-level state.
 */
function syncActiveTab(s: DocumentState): Tab[] {
  if (s.activeId == null) return s.tabs;
  return s.tabs.map((t) => (t.id === s.activeId ? { ...t, ...topToTabFields(s) } : t));
}

/**
 * Re-read `path`, the tab `id` just made active, and hand its text to
 * `handleDiskUpdate` if that tab is still active: only the active document
 * is watched, so a change made on disk while the tab was in the background
 * was never seen (the window showed the old text, and its next save wrote
 * over the change). Now it reloads a clean tab, or offers the change when
 * the tab has edits, as a watched change does.
 */
function recheckDisk(
  get: () => DocumentState,
  set: SetState,
  id: string,
  path: string,
) {
  const read = nextDiskRead();
  invoke<MarkdownFile>("read_markdown_file", { path })
    .then((file) => {
      const cur = get();
      if (read === diskReads && cur.activeId === id && cur.path === path) {
        cur.handleDiskUpdate(file.content, file.version ?? null);
      }
    })
    .catch((e) => {
      const cur = get();
      if (
        read === diskReads &&
        cur.activeId === id &&
        cur.path === path &&
        isMissingFileError(e)
      ) {
        markMissing(get, set, path);
      }
    });
}

/**
 * Reads of the active file after a change on disk, counted: only the last
 * one's answer is used. Reads run side by side, so for two quick changes
 * (a save in another app, then another) the first read could answer last,
 * and the window showed, and took as its baseline, the older text.
 */
let diskReads = 0;
function nextDiskRead(): number {
  diskReads += 1;
  return diskReads;
}

type SetState = (partial: Partial<DocumentState>) => void;

/** The path a watch last failed for, so switching back to it says so once. */
let unwatchedPath: string | null = null;

/**
 * Watch `path` for changes made outside the app (the one watch, which
 * replaces the last). A watch that cannot start is said in a toast: it
 * used to fail without a word, so changes on disk went unnoticed and the
 * next save was refused or wrote over them. `quiet`: not said.
 */
function watchFile(path: string, opts?: { quiet?: boolean }): void {
  let watching: Promise<unknown>;
  try {
    watching = Promise.resolve(invoke("watch_file", { path }));
  } catch (e) {
    watching = Promise.reject(e);
  }
  void watching.then(
    () => {
      if (unwatchedPath === path) unwatchedPath = null;
    },
    (e) => {
      if (opts?.quiet || unwatchedPath === path) return;
      unwatchedPath = path;
      toast.error(untagged(String(e)));
    },
  );
}

/**
 * Flag the active tab's file (`path`) as gone: the window used to show
 * nothing, and the next save silently wrote the file again.
 */
function markMissing(
  get: () => DocumentState,
  set: SetState,
  path: string,
  id?: string | null,
) {
  const s = get();
  if (id != null && id !== s.activeId) {
    set({
      tabs: s.tabs.map((t) =>
        t.id === id && t.path === path ? { ...t, missing: true } : t,
      ),
    });
    return;
  }
  if (s.path !== path || s.missing) return;
  const next = { ...s, missing: true };
  set({ missing: true, tabs: syncActiveTab(next) });
}

/** Ask before writing a file that was deleted or moved since it was read. */
async function confirmRecreate(fileName: string): Promise<boolean> {
  try {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return await ask(
      `"${fileName}" was deleted or moved outside Ashlr MD. Save it again at its old location? (Or use Save As in the banner.)`,
      {
        title: "File not found",
        kind: "warning",
        okLabel: "Recreate",
        cancelLabel: "Cancel",
      },
    );
  } catch {
    // No dialog, no recreate: the text stays in the window.
    return false;
  }
}

/** Button labels of {@link confirmCloseMissing}. */
export const CLOSE_MISSING_SAVE_AS = "Save As…";
export const CLOSE_MISSING_DISCARD = "Close Without Saving";

/**
 * Ask what to do with a tab whose file is gone before closing it: "save-as"
 * (Save As, then close), "close" (discard the text), or "cancel". A dialog
 * that cannot be shown keeps the tab open: losing the text is worse.
 */
async function confirmCloseMissing(
  fileName: string,
): Promise<"save-as" | "close" | "cancel"> {
  try {
    const { message } = await import("@tauri-apps/plugin-dialog");
    const choice = await message(
      `"${fileName}" was deleted or moved outside Ashlr MD, so its text is only in this tab. Save it somewhere before closing?`,
      {
        title: "File not found",
        kind: "warning",
        buttons: {
          yes: CLOSE_MISSING_SAVE_AS,
          no: CLOSE_MISSING_DISCARD,
          cancel: "Cancel",
        },
      },
    );
    if (choice === CLOSE_MISSING_SAVE_AS || choice === "Yes") return "save-as";
    if (choice === CLOSE_MISSING_DISCARD || choice === "No") return "close";
    return "cancel";
  } catch {
    return "cancel";
  }
}

/** The last path component, for a tab title. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  path: null,
  fileName: "",
  content: "",
  diskContent: "",
  size: 0,
  isLoading: false,
  error: null,
  viewMode: "read",
  isDirty: false,
  externalChange: false,
  pendingDisk: null,
  diskVersion: null,
  pendingVersion: null,
  missing: false,
  reloadNonce: 0,
  splitView: false,

  tabs: [],
  activeId: null,
  pendingOps: [],
  remoteCursors: {},
  showRemoteCursors: true,
  opLog: [],

  openPath: async (path, opts) => {
    // If this path is already open, just switch to it — no reload.
    const existing = get().tabs.find((t) => t.path === path);
    if (existing) {
      get().switchTab(existing.id);
      return null;
    }

    set({ isLoading: true, error: null });
    try {
      const file = await invoke<MarkdownFile>("read_markdown_file", { path });
      const key = fileKey(file);
      // The same file by another path (a link, `..`, other case on a
      // filesystem that ignores it): switch to its tab, as for its own path.
      const same = get().tabs.find((t) => t.key === key);
      if (same) {
        set({ isLoading: false });
        get().switchTab(same.id);
        return null;
      }
      const id = newTabId();
      const tab: Tab = {
        id,
        key,
        path: file.path,
        fileName: file.file_name,
        content: file.content,
        diskContent: file.content,
        size: file.size,
        viewMode: get().viewMode,
        isDirty: false,
        externalChange: false,
        pendingDisk: null,
        diskVersion: file.version ?? null,
        pendingVersion: null,
        missing: false,
        // Bump nonce so editors keying on path+reloadNonce remount fresh.
        reloadNonce: get().reloadNonce + 1,
        splitView: false,
      };
      set((s) => ({
        // Mirror the new tab into the top-level active fields.
        ...tabFieldsToTop(tab),
        isLoading: false,
        error: null,
        tabs: [...s.tabs, tab],
        activeId: id,
      }));
      if (opts?.addRecent !== false) {
        useRecentStore.getState().add(file.path, file.file_name, Date.now());
      }
      // Begin watching for external changes; a failure is shown, not fatal.
      watchFile(file.path);
      return null;
    } catch (e) {
      const error = String(e);
      set({ isLoading: false, error });
      // A recent that is gone stays gone: drop it rather than keep offering it.
      if (isMissingFileError(e)) useRecentStore.getState().remove(path);
      return error;
    }
  },

  setContent: (content) =>
    set((s) => {
      const next = { ...s, content, isDirty: content !== s.diskContent };
      return {
        content: next.content,
        isDirty: next.isDirty,
        tabs: syncActiveTab(next),
      };
    }),

  applyOp: (op) => {
    const s = get();
    try {
      const newContent = apply(s.content, op);
      set((cur) => {
        const next = {
          ...cur,
          content: newContent,
          isDirty: newContent !== cur.diskContent,
          pendingOps: [...cur.pendingOps, op],
        };
        return {
          content: newContent,
          isDirty: next.isDirty,
          pendingOps: next.pendingOps,
          tabs: syncActiveTab(next),
        };
      });
      return true;
    } catch {
      return false;
    }
  },

  clearPendingOps: () => set({ pendingOps: [] }),

  applyAttributedOp: (op, source) => {
    const s = get();
    try {
      const newContent = apply(s.content, op);

      // Determine the section at the operation's first non-retain position.
      let editOffset = 0;
      for (const c of op.components) {
        if (c.type === "retain") {
          editOffset += c.count;
          continue;
        }
        break;
      }
      const section = classifySection(s.content, editOffset);

      // Advisory conflict check: if there's a pending local op at the same
      // position, log which side wins (does not alter the OT convergence path).
      // This is exposed in the debug panel and for future UI hints.
      let winner: "a" | "b" = "a";
      if (s.pendingOps.length > 0) {
        // Use the last pending local op as the "a" side.
        const localSource: EditSource = "human";
        winner = resolveConflict(localSource, source, section);
        // `winner` is informational only — OT handles convergence regardless.
        void winner;
      }

      // Update the remote cursor to the end of the inserted / affected range.
      const newCursorOffset = transformCursor(editOffset, op);
      const { line, col } = offsetToLineCol(newContent, newCursorOffset);
      const updatedCursor: CursorPosition = {
        agentId: op.agentId,
        offset: newCursorOffset,
        line,
        col,
        updatedAt: Date.now(),
      };

      // Append to op log.
      const logEntry: OtLogEntry = {
        docPath: s.path ?? "",
        op,
        appliedAt: Date.now(),
        source,
      };

      set((cur) => {
        const next = {
          ...cur,
          content: newContent,
          isDirty: newContent !== cur.diskContent,
          pendingOps: [...cur.pendingOps, op],
          remoteCursors: { ...cur.remoteCursors, [op.agentId]: updatedCursor },
          opLog: [...cur.opLog, logEntry],
        };
        return {
          content: newContent,
          isDirty: next.isDirty,
          pendingOps: next.pendingOps,
          remoteCursors: next.remoteCursors,
          opLog: next.opLog,
          tabs: syncActiveTab(next),
        };
      });
      // Persist to the recoverable OT log so reconnecting agents can replay
      // operations without re-downloading the document.
      useOtLogStore.getState().append(logEntry);
      return true;
    } catch {
      return false;
    }
  },

  setRemoteCursor: (agentId, offset) => {
    const s = get();
    const { line, col } = offsetToLineCol(s.content, offset);
    const cursor: CursorPosition = {
      agentId,
      offset,
      line,
      col,
      updatedAt: Date.now(),
    };
    set((cur) => ({ remoteCursors: { ...cur.remoteCursors, [agentId]: cursor } }));
  },

  toggleShowRemoteCursors: () =>
    set((s) => ({ showRemoteCursors: !s.showRemoteCursors })),

  getOpLog: (docPath) => get().opLog.filter((e) => e.docPath === docPath),

  clearOpLog: (docPath) =>
    set((s) => ({ opLog: s.opLog.filter((e) => e.docPath !== docPath) })),

  setViewMode: (viewMode) => {
    // The editor being left reports what was just typed first.
    flushPendingEdits();
    set((s) => {
      // Read view has no editor, so a split preview is meaningless — clear it.
      const splitView = viewMode === "read" ? false : s.splitView;
      const next = { ...s, viewMode, splitView };
      return { viewMode, splitView, tabs: syncActiveTab(next) };
    });
  },

  toggleSplitView: () =>
    set((s) => {
      // Split only applies to the editor views; ignore it in read view.
      if (s.viewMode === "read") return {};
      const splitView = !s.splitView;
      const next = { ...s, splitView };
      return { splitView, tabs: syncActiveTab(next) };
    }),

  save: async (opts) => {
    // What was just typed is saved too (lib/pendingEdits.ts).
    flushPendingEdits();
    // The document to save: the tab named (an agent's edit names the tab
    // it changed, which may no longer be active), else the active one.
    const st = get();
    const id = opts?.tabId ?? st.activeId;
    const tab = id === st.activeId ? null : st.tabs.find((t) => t.id === id);
    if (id !== st.activeId && !tab) return "the document is no longer open";
    const { path, content, diskVersion, missing, fileName } = tab ?? st;
    if (!path) return "no document is open";
    let recreate = false;
    if (missing) {
      // Gone since it was read: write it again only when the user says so.
      if (opts?.agent) return MISSING_FILE_REASON;
      if (!(await confirmRecreate(fileName))) return "cancelled";
      recreate = true;
    }
    try {
      const written = await invoke<unknown>("write_markdown_file", {
        path,
        content,
        // Refused when the file changed on disk since this text's read, or
        // is gone. A recreate the user confirmed is refused when a file is
        // there again (one that cannot be read was written over).
        expected: recreate ? undefined : (diskVersion ?? undefined),
        ...(recreate ? { recreate: true } : {}),
      });
      const version = typeof written === "string" ? written : null;
      set((s) => {
        // What was written is the tab's disk baseline, and it is clean only
        // if nothing was typed since: an edit made while the write was in
        // flight used to be marked saved, so closing the tab dropped it
        // without asking. The saved tab may no longer be the active one (a
        // tab switch during the write), whose fields the mirror then holds:
        // they used to take the saved tab's baseline, so the other tab's
        // edits read as saved.
        const saved = {
          diskContent: content,
          diskVersion: version,
          externalChange: false,
          pendingDisk: null,
          pendingVersion: null,
          missing: false,
        };
        if (s.activeId !== id || s.path !== path) {
          return {
            tabs: s.tabs.map((t) =>
              t.id === id && t.path === path
                ? { ...t, ...saved, isDirty: t.content !== content }
                : t,
            ),
          };
        }
        const isDirty = s.content !== content;
        const next = { ...s, ...saved, isDirty };
        return { ...saved, isDirty, tabs: syncActiveTab(next) };
      });
      toast.success("Saved");
      return null;
    } catch (e) {
      const error = String(e);
      if (error.includes(SAVE_CONFLICT_TAG)) {
        // Another app changed the file since it was read: nothing was
        // written. Offer its text (the banner) as a watched change does, so
        // the user picks; it used to be overwritten without a word.
        toast.error(
          "Not saved: the file changed on disk. Reload it, or keep your version and save again.",
        );
        recheckDisk(get, set, id ?? "", path);
        return untagged(error);
      }
      if (error.includes(SAVE_MISSING_TAG)) {
        // Gone, and the watcher has not said so yet: show it, and ask.
        markMissing(get, set, path, id);
        const now = get();
        if (opts?.agent || now.activeId !== id || !now.missing) {
          return MISSING_FILE_REASON;
        }
        return now.save(opts);
      }
      set({ error: untagged(error) });
      toast.error(`Couldn’t save: ${untagged(error)}`);
      return untagged(error);
    }
  },

  saveAs: async () => {
    flushPendingEdits();
    const { path, content, activeId } = get();
    if (!path || activeId == null) return "no document is open";
    let dest: string | null;
    try {
      const { save: pick } = await import("@tauri-apps/plugin-dialog");
      dest = await pick({
        defaultPath: path,
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx", "txt"] }],
      });
    } catch (e) {
      return String(e);
    }
    if (!dest) return "cancelled";
    // The file may be open in another tab already: it used to stay open
    // beside this one under the same key, showing the text this save
    // replaced, and its next save wrote that back over this one. That tab
    // is closed once the save is done; with unsaved changes of its own
    // (or as the only copy of a file gone from disk), the user is asked
    // first, as the dialog only asked about the file on disk.
    const destPath = dest;
    const fileKeyOf = async () => {
      try {
        return fileKey(
          await invoke<MarkdownFile>("read_markdown_file", { path: destPath }),
        );
      } catch {
        // Not there yet (or unreadable): the path as given will do.
        return destPath;
      }
    };
    const others = (key: string) =>
      get().tabs.filter(
        (t) => t.id !== activeId && (t.key === key || t.path === destPath),
      );
    const open = others(await fileKeyOf());
    const unsaved = open.find((t) => t.isDirty || t.missing);
    if (unsaved) {
      let replace = false;
      try {
        const { ask } = await import("@tauri-apps/plugin-dialog");
        replace = await ask(
          `"${unsaved.fileName}" is open in another tab with unsaved changes. Replace it with this document? Its changes will be lost.`,
          { title: "Replace open document", kind: "warning" },
        );
      } catch {
        // No dialog: keep the other tab's changes.
      }
      if (!replace) return "cancelled";
    }
    try {
      // The dialog asked before replacing an existing file, so no check.
      const written = await invoke<unknown>("write_markdown_file", {
        path: dest,
        content,
      });
      const version = typeof written === "string" ? written : null;
      const fileName = baseName(dest);
      set((s) => {
        const saved = {
          path: dest,
          fileName,
          diskContent: content,
          diskVersion: version,
          externalChange: false,
          pendingDisk: null,
          pendingVersion: null,
          missing: false,
        };
        if (s.activeId !== activeId) {
          return {
            tabs: s.tabs.map((t) =>
              t.id === activeId
                ? { ...t, ...saved, isDirty: t.content !== content }
                : t,
            ),
          };
        }
        const isDirty = s.content !== content;
        const next = { ...s, ...saved, isDirty };
        return { ...saved, isDirty, tabs: syncActiveTab(next) };
      });
      // The tab holds another file now, found by its canonical path as a
      // read names it (fileKey): the path as the dialog gave it was used,
      // so opening the new file by another path (a symbolic link to its
      // folder, other case where case is ignored) opened it in a second
      // tab, whose saves overwrote this one's.
      const key = await fileKeyOf();
      // The other tabs on this file held the text just replaced: closed,
      // so one tab holds it (unless the user switched to one meanwhile).
      const stale = new Set([...open, ...others(key)].map((t) => t.id));
      set((s) => ({
        tabs: s.tabs
          .filter((t) => !stale.has(t.id) || t.id === s.activeId)
          .map((t) => (t.id === activeId ? { ...t, key } : t)),
      }));
      useRecentStore.getState().add(dest, fileName, Date.now());
      if (get().activeId === activeId) {
        watchFile(dest);
      }
      toast.success(`Saved as ${fileName}`);
      return null;
    } catch (e) {
      toast.error(`Couldn’t save: ${untagged(String(e))}`);
      return untagged(String(e));
    }
  },

  openRecovered: ({ path, fileName, content }) => {
    const s = get();
    const id = newTabId();
    const tab: Tab = {
      id,
      key: path,
      path,
      fileName,
      content,
      // Nothing was read from disk: the text is all unsaved.
      diskContent: "",
      size: content.length,
      viewMode: s.viewMode,
      isDirty: true,
      externalChange: false,
      pendingDisk: null,
      // Matches no read, so a save over a file found there again is refused
      // as a change on disk (and offered), never written over it unasked.
      diskVersion: RECOVERED_VERSION,
      pendingVersion: null,
      missing: true,
      reloadNonce: s.reloadNonce + 1,
      splitView: false,
    };
    set({
      ...tabFieldsToTop(tab),
      isLoading: false,
      error: null,
      tabs: [...syncActiveTab(s), tab],
      activeId: id,
    });
    // Watched as an opened file is: the file coming back (a sync client, a
    // drive mounted again) is offered in the banner. It was never watched,
    // so the tab read as gone until it was saved or switched away from. Its
    // folder may be gone too, which the banner already says.
    if (path) watchFile(path, { quiet: true });
    return id;
  },

  followRename: async (from, to) => {
    const s = get();
    if (s.path !== from || !to || to === from) return;
    // A tab open on the new path already holds that file: this one is left
    // as it is (it reads as gone), so the two never save over each other.
    if (s.tabs.some((t) => t.id !== s.activeId && t.path === to)) return;
    const oldName = s.fileName;
    const fileName = baseName(to);
    const next = { ...s, path: to, fileName };
    set({
      path: to,
      fileName,
      tabs: syncActiveTab(next).map((t) =>
        t.id === s.activeId ? { ...t, key: to } : t,
      ),
    });
    toast.info(
      `"${oldName}" was renamed to "${fileName}" outside Ashlr MD. This tab now saves to it.`,
    );
    useRecentStore.getState().add(to, fileName, Date.now());
    watchFile(to);
    await get().refreshFromDisk(to);
    // Found again by its canonical path, as a read names it (see fileKey).
    try {
      const key = fileKey(
        await invoke<MarkdownFile>("read_markdown_file", { path: to }),
      );
      set((now) => ({
        tabs: now.tabs.map((t) =>
          t.id === s.activeId && t.path === to ? { ...t, key } : t,
        ),
      }));
    } catch {
      // Gone again: the path as reported is its key.
    }
  },

  refreshFromDisk: async (path) => {
    if (get().path !== path) return;
    const read = nextDiskRead();
    try {
      const file = await invoke<MarkdownFile>("read_markdown_file", { path });
      // A later read answers for a later change (see nextDiskRead).
      if (read !== diskReads) return;
      if (get().path === path)
        get().handleDiskUpdate(file.content, file.version ?? null);
    } catch (e) {
      if (read !== diskReads) return;
      // Deleted, or moved away: say so. Any other failure may be a write in
      // progress, which the next event settles.
      if (isMissingFileError(e)) markMissing(get, set, path);
    }
  },

  // Called when the watcher reports the file changed on disk and we've re-read it.
  handleDiskUpdate: (disk, version) => {
    // Edits the editor has not reported yet count: without them the tab
    // looked clean, took the disk's text, and what was just typed was lost.
    flushPendingEdits();
    const s0 = get();
    if (!s0.path) return;
    // The file is there (again): a tab flagged missing no longer is.
    if (s0.missing) {
      set({ missing: false, tabs: syncActiveTab({ ...s0, missing: false }) });
    }
    const s = get();
    const diskVersion = version === undefined ? s.diskVersion : version;
    // Our own save (or no real change) — just resync the disk baseline.
    if (disk === s.content) {
      const next = {
        ...s,
        diskContent: disk,
        diskVersion,
        isDirty: false,
        externalChange: false,
        pendingDisk: null,
        pendingVersion: null,
      };
      set({
        diskContent: disk,
        diskVersion,
        isDirty: false,
        externalChange: false,
        pendingDisk: null,
        pendingVersion: null,
        tabs: syncActiveTab(next),
      });
      return;
    }
    // The file is as it was when last read or saved (a touch, a permission
    // or metadata change, or a change undone): nothing to offer, and a
    // banner offering it is gone. It used to be flagged as a conflict while
    // the user had edits, as if another app had changed the file.
    if (disk === s.diskContent) {
      if (!s.externalChange && s.pendingDisk == null && diskVersion === s.diskVersion) {
        return;
      }
      const next = {
        ...s,
        diskVersion,
        externalChange: false,
        pendingDisk: null,
        pendingVersion: null,
      };
      set({
        diskVersion,
        externalChange: false,
        pendingDisk: null,
        pendingVersion: null,
        tabs: syncActiveTab(next),
      });
      return;
    }
    if (s.isDirty) {
      // Conflict: keep the user's edits, surface a banner. The baseline
      // version stays the old read's, so a save before the user picks is
      // refused rather than written over the change.
      const pendingVersion = version ?? null;
      const next = { ...s, externalChange: true, pendingDisk: disk, pendingVersion };
      set({
        externalChange: true,
        pendingDisk: disk,
        pendingVersion,
        tabs: syncActiveTab(next),
      });
    } else {
      // No local edits — adopt the new content and remount editors.
      const next = {
        ...s,
        content: disk,
        diskContent: disk,
        diskVersion,
        isDirty: false,
        reloadNonce: s.reloadNonce + 1,
      };
      set({
        content: disk,
        diskContent: disk,
        diskVersion,
        isDirty: false,
        reloadNonce: s.reloadNonce + 1,
        tabs: syncActiveTab(next),
      });
    }
  },

  acceptExternalChange: () => {
    const s = get();
    if (s.pendingDisk == null) {
      const next = { ...s, externalChange: false };
      set({ externalChange: false, tabs: syncActiveTab(next) });
      return;
    }
    const next = {
      ...s,
      content: s.pendingDisk,
      diskContent: s.pendingDisk,
      diskVersion: s.pendingVersion,
      isDirty: false,
      externalChange: false,
      pendingDisk: null,
      pendingVersion: null,
      reloadNonce: s.reloadNonce + 1,
    };
    set({
      content: next.content,
      diskContent: next.diskContent,
      diskVersion: next.diskVersion,
      isDirty: false,
      externalChange: false,
      pendingDisk: null,
      pendingVersion: null,
      reloadNonce: next.reloadNonce,
      tabs: syncActiveTab(next),
    });
  },

  // "Keep mine": the user has seen the change on disk and chose their text,
  // so the next save may replace it. The disk text becomes the baseline
  // (the edits stay unsaved), and its version is what a save checks.
  dismissExternalChange: () =>
    set((s) => {
      const seen =
        s.pendingDisk == null
          ? {}
          : {
              diskContent: s.pendingDisk,
              diskVersion: s.pendingVersion,
              isDirty: s.content !== s.pendingDisk,
            };
      const next = {
        ...s,
        ...seen,
        externalChange: false,
        pendingDisk: null,
        pendingVersion: null,
      };
      return {
        ...seen,
        externalChange: false,
        pendingDisk: null,
        pendingVersion: null,
        tabs: syncActiveTab(next),
      };
    }),

  close: () => {
    const { activeId } = get();
    if (activeId != null) {
      get().closeTab(activeId);
    } else {
      set({ ...EMPTY_TOP, reloadNonce: get().reloadNonce });
    }
  },

  // ── Tab actions ─────────────────────────────────────────────────────────

  /**
   * Make `id` the active tab.
   *
   * Snapshots the outgoing active tab from the top-level mirror, then loads the
   * target tab's fields into the top-level mirror and re-issues `watch_file`
   * for the now-active path.
   *
   * TRADEOFF: only ONE file is watched at a time (the active document). Editing
   * an inactive doc on disk won't surface an external-change banner until you
   * switch to it, when the tab's file is read again ({@link recheckDisk}).
   * This keeps the watcher model simple; multi-watch can come later if needed.
   */
  switchTab: (id) => {
    if (id === get().activeId) return;
    // The tab being left keeps what was just typed in it.
    flushPendingEdits();
    const s = get();
    const target = s.tabs.find((t) => t.id === id);
    if (!target) return;

    // Snapshot current top-level into the outgoing active tab, then load target.
    const synced = syncActiveTab(s);
    set({
      ...tabFieldsToTop(target),
      activeId: id,
      isLoading: false,
      error: null,
      tabs: synced,
    });
    // Re-issue the watch so the active doc is the one being watched.
    watchFile(target.path);
    recheckDisk(get, set, id, target.path);
  },

  /**
   * Close tab `id`. If it was active, activate the nearest neighbor (right,
   * else left). Closing the last tab returns to the empty state.
   */
  closeTab: (id) => {
    // Closing asks about what was just typed too.
    if (id === get().activeId) flushPendingEdits();
    const s = get();
    const idx = s.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;

    // The active tab's live dirty flag is the top-level `isDirty`; an inactive
    // tab carries its own. Confirm before discarding unsaved edits.
    const tab = s.tabs[idx];
    const dirty = id === s.activeId ? s.isDirty : tab.isDirty;

    // Re-reads state after any async confirm gap, then performs the close.
    const finish = () => {
      const cur = get();
      const i = cur.tabs.findIndex((t) => t.id === id);
      if (i === -1) return;
      const remaining = cur.tabs.filter((t) => t.id !== id);

      if (remaining.length === 0) {
        set({ ...EMPTY_TOP, tabs: [], activeId: null, reloadNonce: cur.reloadNonce });
        return;
      }
      if (id !== cur.activeId) {
        // Non-active tab: persist live edits to the still-active tab first.
        const synced = syncActiveTab(cur).filter((t) => t.id !== id);
        set({ tabs: synced });
        return;
      }
      // Active tab — activate nearest neighbor (right, else left).
      const neighbor = remaining[Math.min(i, remaining.length - 1)];
      set({
        ...tabFieldsToTop(neighbor),
        tabs: remaining,
        activeId: neighbor.id,
        isLoading: false,
        error: null,
      });
      watchFile(neighbor.path);
      recheckDisk(get, set, neighbor.id, neighbor.path);
    };

    // A tab whose file was deleted or moved holds the only copy of its
    // text, edited or not: it used to close without a word when it had no
    // edits, and the text was gone. Offer Save As first.
    const missing = id === s.activeId ? s.missing : tab.missing;
    if (missing) {
      void confirmCloseMissing(tab.fileName).then(async (choice) => {
        if (choice === "close") {
          finish();
          return;
        }
        if (choice !== "save-as") return;
        if (get().activeId !== id) get().switchTab(id);
        if (get().activeId !== id) return;
        // Saved under a new name, the tab closes as asked, unless it was
        // edited during the dialog.
        if (
          (await get().saveAs()) === null &&
          get().activeId === id &&
          !get().isDirty
        ) {
          finish();
        }
      });
      return;
    }

    if (dirty) {
      // A native confirm prevents silently dropping unsaved work (⌘W, ×, etc.).
      // On any dialog failure we DON'T close — losing edits is worse than a
      // tab that won't close (the user can save, then close).
      import("@tauri-apps/plugin-dialog")
        .then(({ ask }) =>
          ask(`"${tab.fileName}" has unsaved changes. Close without saving?`, {
            title: "Unsaved changes",
            kind: "warning",
          }),
        )
        .then((ok) => {
          if (ok) finish();
        })
        .catch(() => {});
      return;
    }
    finish();
  },

  nextTab: () => {
    const s = get();
    if (s.tabs.length < 2) return;
    const i = s.tabs.findIndex((t) => t.id === s.activeId);
    const next = s.tabs[(i + 1) % s.tabs.length];
    get().switchTab(next.id);
  },

  prevTab: () => {
    const s = get();
    if (s.tabs.length < 2) return;
    const i = s.tabs.findIndex((t) => t.id === s.activeId);
    const prev = s.tabs[(i - 1 + s.tabs.length) % s.tabs.length];
    get().switchTab(prev.id);
  },
}));
