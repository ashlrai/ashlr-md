/**
 * unsavedBuffers.ts — keep unsaved text for the next launch.
 *
 * The text of every tab with unsaved edits is copied to localStorage (half a
 * second after the last change), so a crash, a forced quit, a quit the
 * close prompt cannot catch (⌘Q on macOS) or an update's relaunch does not
 * lose it. On the next launch each kept text is put back in its document's
 * tab, unsaved; when the file changed on disk since, the external-change
 * banner offers the disk version too. Close Without Saving forgets the copy.
 *
 * Limits: a document over {@link MAX_BUFFER_CHARS} characters is not kept,
 * nor any past {@link MAX_TOTAL_CHARS} in all (localStorage holds a few MB).
 */

import { useDocumentStore } from "../store/documentStore";

export const BUFFERS_KEY = "mdopener-unsaved";
export const MAX_BUFFER_CHARS = 1_000_000;
export const MAX_TOTAL_CHARS = 3_000_000;
const DEBOUNCE_MS = 500;

export interface KeptBuffer {
  path: string;
  fileName: string;
  /** The unsaved text. */
  content: string;
  /** The disk text it was edited from. */
  base: string;
}

type DocState = ReturnType<typeof useDocumentStore.getState>;

/** The tabs with unsaved edits, as kept buffers, within the size limits. */
export function collectBuffers(s: DocState): KeptBuffer[] {
  const out: KeptBuffer[] = [];
  let total = 0;
  for (const t of s.tabs) {
    const live = t.id === s.activeId;
    const isDirty = live ? s.isDirty : t.isDirty;
    const path = live ? s.path : t.path;
    if (!isDirty || !path) continue;
    const content = live ? s.content : t.content;
    const base = live ? s.diskContent : t.diskContent;
    const size = content.length + base.length;
    if (content.length > MAX_BUFFER_CHARS || total + size > MAX_TOTAL_CHARS) continue;
    total += size;
    out.push({ path, fileName: live ? s.fileName : t.fileName, content, base });
  }
  return out;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Write `buffers` (none: remove the key). Never throws. */
export function writeBuffers(buffers: KeptBuffer[]): void {
  try {
    const ls = storage();
    if (!ls) return;
    if (buffers.length === 0) ls.removeItem(BUFFERS_KEY);
    else ls.setItem(BUFFERS_KEY, JSON.stringify({ version: 1, buffers }));
  } catch {
    // Full or unavailable: the edits are still in the window.
  }
}

/** The kept buffers, each checked; a damaged entry is skipped. */
export function readBuffers(): KeptBuffer[] {
  try {
    const raw = storage()?.getItem(BUFFERS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const list = (parsed as { buffers?: unknown } | null)?.buffers;
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    return list.filter((b): b is KeptBuffer => {
      const ok =
        b != null &&
        typeof b.path === "string" &&
        b.path !== "" &&
        typeof b.fileName === "string" &&
        typeof b.content === "string" &&
        typeof b.base === "string" &&
        !seen.has(b.path);
      if (ok) seen.add(b.path);
      return ok;
    });
  } catch {
    return [];
  }
}

export function clearBuffers(): void {
  writeBuffers([]);
}

/** Write the current unsaved text now (before a relaunch, say). */
export function flushBuffers(): void {
  if (keeper?.stopped === false) keeper.flush();
}

interface Keeper {
  stopped: boolean;
  flush: () => void;
  discard?: () => void;
}
let keeper: Keeper | null = null;

/**
 * Keep the unsaved text from now on. Returns `{ stop, discard }`: `discard`
 * forgets the kept text and keeps nothing more (Close Without Saving).
 */
export function startKeepingBuffers(): { stop: () => void; discard: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = "";
  const self: Keeper = {
    stopped: false,
    flush: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (self.stopped) return;
      const buffers = collectBuffers(useDocumentStore.getState());
      const key = JSON.stringify(buffers);
      if (key === last) return;
      last = key;
      writeBuffers(buffers);
    },
  };
  keeper = self;
  const unsub = useDocumentStore.subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(self.flush, DEBOUNCE_MS);
  });
  const onHide = () => self.flush();
  globalThis.addEventListener?.("pagehide", onHide);
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    self.stopped = true;
    unsub();
    globalThis.removeEventListener?.("pagehide", onHide);
    if (keeper === self) keeper = null;
  };
  const discard = () => {
    stop();
    clearBuffers();
  };
  self.discard = discard;
  return { stop, discard };
}

/** Forget the kept text, and keep nothing more (Close Without Saving). */
export function discardBuffers(): void {
  if (keeper?.discard) keeper.discard();
  else clearBuffers();
}

export interface RestoreResult {
  /** File names whose unsaved text is back in their tab. */
  restored: string[];
  /** File names whose text could not be put back (the file cannot be opened). */
  lost: string[];
}

/**
 * Put each kept buffer back in its document's tab (opened when it is not
 * open). The tab that was active stays active.
 */
export async function restoreBuffers(
  openPath: (path: string) => Promise<string | null>,
): Promise<RestoreResult> {
  const result: RestoreResult = { restored: [], lost: [] };
  const buffers = readBuffers();
  if (buffers.length === 0) return result;
  const store = useDocumentStore;
  const wasActive = store.getState().activeId;
  for (const b of buffers) {
    if ((await openPath(b.path)) !== null) {
      result.lost.push(b.fileName);
      continue;
    }
    const s = store.getState();
    if (s.path !== b.path || s.activeId == null) {
      result.lost.push(b.fileName);
      continue;
    }
    // Saved after all (the copy is written half a second late): nothing to do.
    if (s.content === b.content) continue;
    const disk = s.diskContent;
    // Changed on disk since the edits began: offer the disk text in the
    // banner, as for a change made while the document was open.
    const changed = disk !== b.base && disk !== b.content;
    const fields = {
      content: b.content,
      isDirty: b.content !== disk,
      externalChange: changed,
      pendingDisk: changed ? disk : null,
      pendingVersion: changed ? s.diskVersion : null,
      reloadNonce: s.reloadNonce + 1,
    };
    store.setState({
      ...fields,
      tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, ...fields } : t)),
    });
    result.restored.push(b.fileName);
  }
  const now = store.getState();
  // A document that could not be opened left its error in the window.
  if (now.error !== null && now.tabs.length > 0) store.setState({ error: null });
  if (wasActive != null && now.activeId !== wasActive) {
    if (now.tabs.some((t) => t.id === wasActive)) now.switchTab(wasActive);
  }
  return result;
}

/** One message about a restore, or null when there is nothing to say. */
export function restoreMessage(
  r: RestoreResult,
): { kind: "info" | "error"; text: string } | null {
  const names = (list: string[]) =>
    list.length <= 3
      ? list.map((n) => `"${n}"`).join(", ")
      : `${list
          .slice(0, 3)
          .map((n) => `"${n}"`)
          .join(", ")} and ${list.length - 3} more`;
  if (r.lost.length > 0) {
    return {
      kind: "error",
      text: `Unsaved changes to ${names(r.lost)} could not be restored: the file could not be opened.${
        r.restored.length ? ` Restored unsaved changes to ${names(r.restored)}.` : ""
      }`,
    };
  }
  if (r.restored.length > 0) {
    return { kind: "info", text: `Restored unsaved changes to ${names(r.restored)}` };
  }
  return null;
}
