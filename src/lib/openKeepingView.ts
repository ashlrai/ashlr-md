/**
 * openKeepingView.ts — open a file picked from a list (a recent, a search
 * hit, a related note) without losing the document in view.
 *
 * A plain open shows a read error in place of the open document. For a file
 * deleted or moved since the list was made, that replaced what was open, and
 * with one tab (no tab bar) it could not be got back short of opening
 * another file. Here the document stays and a toast says why.
 */

import { useDocumentStore } from "../store/documentStore";
import { toast } from "../store/toastStore";

/**
 * Open `path` in a tab (or switch to it). Resolves to `null` once it is
 * open, or to the read error, which a toast shows.
 */
export async function openKeepingView(path: string): Promise<string | null> {
  const error = await useDocumentStore
    .getState()
    .openPath(path, { keepViewOnError: true });
  if (error !== null) {
    const name = path.split(/[\\/]/).pop() || path;
    toast.error(`Could not open ${name}: ${error}`);
  }
  return error;
}
