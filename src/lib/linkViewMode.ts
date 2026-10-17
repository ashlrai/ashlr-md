/**
 * The view an `mdopener://open?…&mode=read|edit` link asked for.
 *
 * The Rust deep-link handler keeps a link's `mode` per path until the window
 * has opened that file (it may not be listening yet on a cold start), and
 * hands it over once through `take_link_view_mode`. The link used to open the
 * file in whatever view it was, `mode=edit` included, so `mdopen --edit` with
 * the app closed opened in read mode.
 */

import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "../store/documentStore";

/**
 * After `path` was opened from a link, switch to the view the link asked for,
 * if it asked and `path` is still the active document.
 */
export async function applyLinkViewMode(path: string): Promise<void> {
  const mode = await invoke<string | null>("take_link_view_mode", { path }).catch(
    () => null,
  );
  if (mode !== "read" && mode !== "edit") return;
  const doc = useDocumentStore.getState();
  if (doc.path !== path) return;
  doc.setViewMode(mode);
}
