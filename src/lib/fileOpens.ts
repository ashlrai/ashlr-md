/**
 * Files the app is asked to open: Finder and file-manager opens, second
 * launches and `mdopener://` links.
 *
 * Rust buffers each path in `PendingFiles` and also sends it in a
 * `file-opened` event. The window drains the buffer on mount
 * (`take_pending_files`), registers its listener, then drains it once more
 * (`pending_files_listening`), after which Rust stops buffering. Buffering
 * used to stop at the first drain, so a file opened between that drain and
 * the listener being registered was neither buffered nor heard.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyLinkExport } from "./linkExport";
import { applyLinkViewMode } from "./linkViewMode";

type OpenPath = (path: string) => Promise<void>;

/**
 * Open the files of one `file-opened` event (or of the startup buffer) in
 * order; the last stays active. A link's `mode` and an export link's format
 * apply once its file is open, and each path's are taken even when it fails
 * to open, so none is left for a later open of that file. Only the last file
 * of an event used to open, so the others' link requests lingered.
 */
export async function openOpenedFiles(
  paths: string[],
  openPath: OpenPath,
): Promise<void> {
  for (const p of paths) {
    await openPath(p);
    await applyLinkViewMode(p);
    await applyLinkExport(p);
  }
}

/**
 * Listen for live `file-opened` events, then open the files opened since the
 * mount drain that no listener heard. Opens run one after another, so a
 * file is never opened twice at once. Returns the unlisten function.
 */
export async function listenForOpenedFiles(openPath: OpenPath): Promise<() => void> {
  let chain = Promise.resolve();
  const enqueue = (paths: string[]) => {
    chain = chain.then(() => openOpenedFiles(paths, openPath)).catch(() => {});
  };
  // Paths the listener heard before the second drain returned, which the
  // drain may hand over again.
  const heard = new Set<string>();
  let draining = true;
  const unlisten = await listen<string[]>("file-opened", (e) => {
    if (draining) for (const p of e.payload) heard.add(p);
    enqueue(e.payload);
  });
  const missed = await invoke<string[]>("pending_files_listening").catch(
    () => [] as string[],
  );
  draining = false;
  for (const p of missed) {
    if (!heard.has(p)) enqueue([p]);
  }
  return unlisten;
}
