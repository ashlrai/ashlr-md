/**
 * activityStore.ts — state for the "Agent Activity" drawer.
 *
 * Tracks the watched project folder and the Markdown files AI agents write into
 * it, surfaced newest-first and live-updated from the `activity://file` event
 * stream. Only the watched folder is persisted (so the watch resumes on launch);
 * the file list and unseen-badge set are runtime-only.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  type ActivityEvent,
  listMarkdownFiles,
  type MdFileInfo,
} from "../lib/activity";
import { notifyAgentActivity } from "../lib/notify";
import { useActivationStore } from "./activationStore";
import { useDocumentStore } from "./documentStore";
import { useSettingsStore } from "./settingsStore";
import { toast } from "./toastStore";
import { useUiStore } from "./uiStore";

const MAX_FILES = 200;

// ── New-file toast coalescing ──────────────────────────────────────────────
// When the drawer is closed and an agent writes new Markdown, surface a single
// info toast. A short debounce batches a burst (e.g. an agent writing several
// files at once) into one "N new files" toast instead of spamming the stack.
const TOAST_COALESCE_MS = 700;
let pendingNew: MdFileInfo[] = [];
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function flushNewFileToast() {
  pendingTimer = null;
  const batch = pendingNew;
  pendingNew = [];
  if (batch.length === 0) return;

  if (batch.length === 1) {
    const f = batch[0];
    toast.info(`New: ${f.name}`, {
      onClick: () => {
        void useDocumentStore.getState().openPath(f.path);
        useUiStore.getState().openActivity();
      },
    });
  } else {
    toast.info(`${batch.length} new files`, {
      onClick: () => useUiStore.getState().openActivity(),
    });
  }

  // When the app isn't focused, also fire a native OS notification — ONLY for
  // this real agent activity, never on a timer. Honors the user's setting.
  if (
    typeof document !== "undefined" &&
    !document.hasFocus() &&
    useSettingsStore.getState().notificationsEnabled
  ) {
    const body =
      batch.length === 1 ? batch[0].name : `${batch.length} new files from your agent`;
    void notifyAgentActivity("Ashlr MD", body);
  }
}

// Debounce per-file semantic re-indexing so a burst of agent writes collapses
// into one batched embed call (one Ollama round-trip, one index save).
const EMBED_DEBOUNCE_MS = 2000;
const pendingEmbedPaths = new Set<string>();
let embedTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleEmbedIndex(path: string) {
  pendingEmbedPaths.add(path);
  if (embedTimer) clearTimeout(embedTimer);
  embedTimer = setTimeout(() => {
    embedTimer = null;
    const paths = Array.from(pendingEmbedPaths);
    pendingEmbedPaths.clear();
    import("../lib/embedSearch").then(({ embedIndex }) => {
      void embedIndex(paths, false); // incremental — additive, never prunes
    });
  }, EMBED_DEBOUNCE_MS);
}

/** Queue a newly-created file for the coalesced "New: …" toast. */
function queueNewFileToast(file: MdFileInfo) {
  pendingNew.push(file);
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flushNewFileToast, TOAST_COALESCE_MS);
}

interface ActivityState {
  /** Currently-watched folder (absolute), or null if none. Persisted. */
  watchedDir: string | null;
  /** Surfaced Markdown files, newest first, deduped by path. Runtime only. */
  files: MdFileInfo[];
  /** Paths created/modified since the drawer was last viewed (badge source). */
  unseen: string[];
  /** Last error string from a backend call, or null. */
  lastError: string | null;

  /** Set (or clear) the watched folder. Does NOT issue the watch itself. */
  setWatchedDir: (dir: string | null) => void;
  /** Load the file listing for the current watched folder. */
  loadFiles: () => Promise<void>;
  /** Apply a live event: upsert to top, mark unseen when the drawer is closed. */
  applyEvent: (ev: ActivityEvent) => void;
  /** Clear the unseen badge (drawer viewed). */
  markAllSeen: () => void;
  /** Stop watching: clear folder, files, and unseen. */
  clearWatch: () => void;
}

/** Strip the event-only `kind` field down to a plain {@link MdFileInfo}. */
function toFileInfo(ev: ActivityEvent): MdFileInfo {
  return {
    path: ev.path,
    name: ev.name,
    dir: ev.dir,
    mtimeMs: ev.mtimeMs,
    size: ev.size,
  };
}

/** Upsert `file` to the front, de-duping by path, capped at MAX_FILES. */
function upsert(files: MdFileInfo[], file: MdFileInfo): MdFileInfo[] {
  return [file, ...files.filter((f) => f.path !== file.path)].slice(0, MAX_FILES);
}

export const useActivityStore = create<ActivityState>()(
  persist(
    (set, get) => ({
      watchedDir: null,
      files: [],
      unseen: [],
      lastError: null,

      setWatchedDir: (dir) => {
        set({ watchedDir: dir, lastError: null });
        // Watching a folder is the primary activation event ("Ashlr is where my
        // agent's markdown lands"). Recorded locally for first-run gating.
        if (dir) useActivationStore.getState().markActivated();
      },

      loadFiles: async () => {
        const dir = get().watchedDir;
        if (!dir) {
          set({ files: [] });
          return;
        }
        try {
          const files = await listMarkdownFiles(dir);
          set({ files, lastError: null });
        } catch (e) {
          set({ lastError: e instanceof Error ? e.message : String(e) });
        }
      },

      applyEvent: (ev) => {
        // When the drawer is open the user is actively watching, so nothing is
        // "unseen". Otherwise track the path so the toggle can show a count.
        const drawerOpen = useUiStore.getState().activityOpen;
        // A newly-created file the user hasn't seen yet — surface a toast (when
        // the drawer is closed) so it isn't missed. Re-creates of an already-
        // tracked path are skipped to avoid repeat noise.
        const isNovel =
          ev.kind === "created" &&
          !drawerOpen &&
          !get().files.some((f) => f.path === ev.path);
        if (isNovel) queueNewFileToast(toFileInfo(ev));
        set((s) => ({
          files: upsert(s.files, toFileInfo(ev)),
          unseen:
            drawerOpen || s.unseen.includes(ev.path)
              ? s.unseen
              : [...s.unseen, ev.path],
        }));
        // Incremental semantic re-index for the changed file, debounced so a
        // burst of agent writes becomes one batched call (no-op without a model).
        if (ev.kind === "created" || ev.kind === "modified") {
          scheduleEmbedIndex(ev.path);
        }
      },

      markAllSeen: () => set({ unseen: [] }),

      clearWatch: () =>
        set({ watchedDir: null, files: [], unseen: [], lastError: null }),
    }),
    {
      name: "mdopener-activity",
      // Persist only the watched folder; files/unseen are reconstructed at runtime.
      partialize: (s) => ({ watchedDir: s.watchedDir }),
    },
  ),
);
