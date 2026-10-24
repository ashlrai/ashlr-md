/**
 * pendingEdits.ts: hand the document store an editor's edits it has not
 * reported yet.
 *
 * The WYSIWYG editor (Milkdown) reports a change 200 ms after the last
 * keystroke, and drops the report when it is destroyed. Whatever reads the
 * store in between saw the text without those keystrokes: a change on disk
 * found the tab clean, took the disk's text and remounted the editor, so
 * what was just typed was lost without a word; a save, a tab switch or a
 * view switch in that time lost them too, or left them out. An editor
 * registers here how to report its edits now, and the store asks before it
 * reads the text.
 */

const flushers = new Set<() => void>();

/** Register `flush` (report pending edits now); returns its unregister. */
export function registerPendingEdits(flush: () => void): () => void {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}

/** Have every editor report its pending edits now. Never throws. */
export function flushPendingEdits(): void {
  for (const flush of [...flushers]) {
    try {
      flush();
    } catch {
      // An editor that cannot report keeps its edits for its own report.
    }
  }
}
