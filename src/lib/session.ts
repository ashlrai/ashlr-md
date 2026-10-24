/**
 * session.ts — restore the previous session on launch.
 *
 * Reopens the saved tabs (at most {@link MAX_RESTORED_TABS}; files that no
 * longer exist on disk are skipped and named), restores each tab's view
 * mode, and re-activates the last-active document. Recents keep their order.
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

/**
 * Most tabs a restore reopens. Each is a read and an editor; a session of
 * hundreds of tabs (an agent opened them, say) made the launch crawl. The
 * first ones in tab order are reopened, with the active tab always among them.
 */
export const MAX_RESTORED_TABS = 20;

export interface SessionRestore {
  /** Documents reopened. */
  opened: number;
  /** File names of saved tabs whose file was moved or deleted since. */
  gone: string[];
  /** Saved tabs left closed by {@link MAX_RESTORED_TABS}. */
  capped: number;
}

/** The first `max` of `tabs`, with `activePath`'s tab always kept. */
export function capRestoredTabs(
  tabs: SavedTab[],
  activePath: unknown,
  max = MAX_RESTORED_TABS,
): SavedTab[] {
  if (tabs.length <= max) return tabs;
  const kept = tabs.slice(0, max);
  const active = tabs.find((t) => t.path === activePath);
  if (active && !kept.includes(active)) {
    kept[max - 1] = active;
  }
  return kept;
}

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

/** The one message about a restore, or null when there is nothing to say. */
export function sessionRestoreMessage(r: SessionRestore): string | null {
  const parts: string[] = [];
  if (r.opened >= 1) {
    parts.push(
      `Reopened ${r.opened} document${r.opened > 1 ? "s" : ""} from your last session.`,
    );
  }
  if (r.capped > 0) {
    parts.push(
      `${r.capped} more tab${r.capped > 1 ? "s were" : " was"} left closed (at most ${MAX_RESTORED_TABS} reopen).`,
    );
  }
  if (r.gone.length > 0) {
    const shown = r.gone.slice(0, 3).map((n) => `"${n}"`);
    const more = r.gone.length - shown.length;
    const list = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
    parts.push(
      r.gone.length === 1
        ? `${list} was moved or deleted since, so it was not reopened.`
        : `${list} were moved or deleted since, so they were not reopened.`,
    );
  }
  return parts.length ? parts.join(" ") : null;
}

/** Reopen the previously-saved session. */
export async function restoreSession(): Promise<SessionRestore> {
  const none: SessionRestore = { opened: 0, gone: [], capped: 0 };
  const { savedTabs: stored, activePath } = useSessionStore.getState();
  const savedTabs = savedTabsToRestore(stored);
  if (savedTabs.length === 0) return none;

  // Filter to files that still exist. Fail SAFE on IPC error (restore
  // nothing, and keep the session for the next launch) rather than trying
  // to open files that may be gone and tripping the error state.
  const paths = savedTabs.map((t) => t.path);
  let existingList: string[];
  try {
    existingList = await invoke<string[]>("filter_existing", { paths });
  } catch {
    return none;
  }
  const existing = new Set(existingList);
  const gone = savedTabs
    .filter((t) => !existing.has(t.path))
    .map((t) => baseName(t.path));
  const present = savedTabs.filter((t) => existing.has(t.path));

  // Every saved file is gone: clear the stale session so we don't retry forever.
  if (present.length === 0) {
    useSessionStore.getState().clear();
    return { ...none, gone };
  }
  const toOpen = capRestoredTabs(present, activePath);

  let opened = 0;
  for (const t of toOpen) {
    // A file that is there but cannot be opened (unreadable, too large, not
    // text) gets no tab: its view mode used to be applied to the tab that
    // was active instead, and it was counted as reopened. Recents keep
    // their order: reopening is not opening anew.
    if (
      (await useDocumentStore.getState().openPath(t.path, { addRecent: false })) !==
      null
    ) {
      continue;
    }
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
  return { opened, gone, capped: present.length - toOpen.length };
}
