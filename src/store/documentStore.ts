import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useRecentStore } from "./recentStore";
import { toast } from "./toastStore";

export type ViewMode = "read" | "edit" | "source";

interface MarkdownFile {
  path: string;
  file_name: string;
  content: string;
  size: number;
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
  path: string;
  fileName: string;
  content: string;
  diskContent: string;
  size: number;
  viewMode: ViewMode;
  isDirty: boolean;
  externalChange: boolean;
  pendingDisk: string | null;
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
  /** Bumped to force editors to remount with fresh content (e.g. after reload). */
  reloadNonce: number;
  /** When true, render a live read preview beside the editor (per-document). */
  splitView: boolean;

  // ── Multi-document state ────────────────────────────────────────────────
  tabs: Tab[];
  activeId: string | null;

  openPath: (path: string) => Promise<void>;
  setContent: (content: string) => void;
  setViewMode: (mode: ViewMode) => void;
  toggleSplitView: () => void;
  save: () => Promise<void>;
  handleDiskUpdate: (diskContent: string) => void;
  acceptExternalChange: () => void;
  dismissExternalChange: () => void;
  close: () => void;

  // ── Tab actions ─────────────────────────────────────────────────────────
  switchTab: (id: string) => void;
  closeTab: (id: string) => void;
  nextTab: () => void;
  prevTab: () => void;
}

/** Fields a Tab and the top-level mirror share, sans `id`. */
type TabFields = Omit<Tab, "id">;

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
  reloadNonce: 0,
  splitView: false,

  tabs: [],
  activeId: null,

  openPath: async (path) => {
    // If this path is already open, just switch to it — no reload.
    const existing = get().tabs.find((t) => t.path === path);
    if (existing) {
      get().switchTab(existing.id);
      return;
    }

    set({ isLoading: true, error: null });
    try {
      const file = await invoke<MarkdownFile>("read_markdown_file", { path });
      const id = newTabId();
      const tab: Tab = {
        id,
        path: file.path,
        fileName: file.file_name,
        content: file.content,
        diskContent: file.content,
        size: file.size,
        viewMode: get().viewMode,
        isDirty: false,
        externalChange: false,
        pendingDisk: null,
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
      useRecentStore.getState().add(file.path, file.file_name, Date.now());
      // Begin watching for external changes; failure is non-fatal.
      invoke("watch_file", { path: file.path }).catch(() => {});
    } catch (e) {
      set({ isLoading: false, error: String(e) });
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

  setViewMode: (viewMode) =>
    set((s) => {
      // Read view has no editor, so a split preview is meaningless — clear it.
      const splitView = viewMode === "read" ? false : s.splitView;
      const next = { ...s, viewMode, splitView };
      return { viewMode, splitView, tabs: syncActiveTab(next) };
    }),

  toggleSplitView: () =>
    set((s) => {
      // Split only applies to the editor views; ignore it in read view.
      if (s.viewMode === "read") return {};
      const splitView = !s.splitView;
      const next = { ...s, splitView };
      return { splitView, tabs: syncActiveTab(next) };
    }),

  save: async () => {
    const { path, content } = get();
    if (!path) return;
    try {
      await invoke("write_markdown_file", { path, content });
      set((s) => {
        const next = {
          ...s,
          diskContent: content,
          isDirty: false,
          externalChange: false,
          pendingDisk: null,
        };
        return {
          diskContent: content,
          isDirty: false,
          externalChange: false,
          pendingDisk: null,
          tabs: syncActiveTab(next),
        };
      });
      toast.success("Saved");
    } catch (e) {
      set({ error: String(e) });
      toast.error(`Couldn’t save: ${String(e)}`);
    }
  },

  // Called when the watcher reports the file changed on disk and we've re-read it.
  handleDiskUpdate: (disk) => {
    const s = get();
    if (!s.path) return;
    // Our own save (or no real change) — just resync the disk baseline.
    if (disk === s.content) {
      const next = {
        ...s,
        diskContent: disk,
        isDirty: false,
        externalChange: false,
        pendingDisk: null,
      };
      set({
        diskContent: disk,
        isDirty: false,
        externalChange: false,
        pendingDisk: null,
        tabs: syncActiveTab(next),
      });
      return;
    }
    if (s.isDirty) {
      // Conflict: keep the user's edits, surface a banner.
      const next = { ...s, externalChange: true, pendingDisk: disk };
      set({
        externalChange: true,
        pendingDisk: disk,
        tabs: syncActiveTab(next),
      });
    } else {
      // No local edits — adopt the new content and remount editors.
      const next = {
        ...s,
        content: disk,
        diskContent: disk,
        isDirty: false,
        reloadNonce: s.reloadNonce + 1,
      };
      set({
        content: disk,
        diskContent: disk,
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
      isDirty: false,
      externalChange: false,
      pendingDisk: null,
      reloadNonce: s.reloadNonce + 1,
    };
    set({
      content: next.content,
      diskContent: next.diskContent,
      isDirty: false,
      externalChange: false,
      pendingDisk: null,
      reloadNonce: next.reloadNonce,
      tabs: syncActiveTab(next),
    });
  },

  dismissExternalChange: () =>
    set((s) => {
      const next = { ...s, externalChange: false, pendingDisk: null };
      return {
        externalChange: false,
        pendingDisk: null,
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
   * switch to it. This keeps the watcher model simple; multi-watch can come
   * later if needed.
   */
  switchTab: (id) => {
    const s = get();
    if (id === s.activeId) return;
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
    invoke("watch_file", { path: target.path }).catch(() => {});
  },

  /**
   * Close tab `id`. If it was active, activate the nearest neighbor (right,
   * else left). Closing the last tab returns to the empty state.
   */
  closeTab: (id) => {
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
      invoke("watch_file", { path: neighbor.path }).catch(() => {});
    };

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
