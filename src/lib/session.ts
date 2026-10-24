/**
 * session.ts — restore the previous session on launch.
 *
 * Reopens the saved tabs (skipping any files that no longer exist on disk),
 * restores each tab's view mode, and re-activates the last-active document.
 */

import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore, type ViewMode } from "../store/documentStore";
import { type SavedTab, useSessionStore } from "../store/sessionStore";

const VIEW_MODES: readonly ViewMode[] = ["read", "edit", "source"];

/**
 * The saved tabs that name a file, once each, with a view mode the app has
 * ("read" for any other). The session is read from storage as it was
 * written, which a damaged or hand-edited file (or another version) may not
 * match: a `savedTabs` that is not a list threw before anything reopened.
 */
function savedTabsToRestore(saved: unknown): SavedTab[] {
  if (!Array.isArray(saved)) return [];
  const seen = new Set<string>();
  const out: SavedTab[] = [];
  for (const t of saved) {
    const path = (t as Partial<SavedTab> | null)?.path;
    if (typeof path !== "string" || path === "" || seen.has(path)) continue;
    seen.add(path);
    const mode = (t as Partial<SavedTab>).viewMode;
    out.push({
      path,
      viewMode: VIEW_MODES.includes(mode as ViewMode) ? (mode as ViewMode) : "read",
    });
  }
  return out;
}

/** Reopen the previously-saved session. Returns the number of docs reopened. */
export async function restoreSession(): Promise<number> {
  const { savedTabs: stored, activePath } = useSessionStore.getState();
  const savedTabs = savedTabsToRestore(stored);
  if (savedTabs.length === 0) return 0;

  // Filter to files that still exist (moved/deleted ones are silently dropped).
  // Fail SAFE on IPC error (restore nothing) rather than trying to open files
  // that may be gone and tripping the error state.
  const paths = savedTabs.map((t) => t.path);
  const existing = new Set(
    await invoke<string[]>("filter_existing", { paths }).catch(() => [] as string[]),
  );
  const toOpen = savedTabs.filter((t) => existing.has(t.path));

  // Every saved file is gone — clear the stale session so we don't retry forever.
  if (toOpen.length === 0) {
    useSessionStore.getState().clear();
    return 0;
  }

  let opened = 0;
  for (const t of toOpen) {
    // A file that is there but cannot be opened (unreadable, too large, not
    // text) gets no tab: its view mode used to be applied to the tab that
    // was active instead, and it was counted as reopened.
    if ((await useDocumentStore.getState().openPath(t.path)) !== null) continue;
    opened += 1;
    // Always correct the view mode: openPath inherits whatever the prior active
    // tab left in the top-level mirror, which may not match this tab's mode.
    useDocumentStore.getState().setViewMode(t.viewMode);
  }

  // Re-activate the last-active document.
  if (typeof activePath === "string" && existing.has(activePath)) {
    const tab = useDocumentStore.getState().tabs.find((t) => t.path === activePath);
    if (tab) useDocumentStore.getState().switchTab(tab.id);
  }

  // A file that failed to open left its error in place of the document the
  // window shows; with documents reopened, show them.
  if (opened > 0 && useDocumentStore.getState().error !== null) {
    useDocumentStore.setState({ error: null });
  }
  return opened;
}
