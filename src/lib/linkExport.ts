/**
 * The export an `mdopener://export?…&format=…` link asked for.
 *
 * The Rust deep-link handler keeps a link's format per path until the window
 * has opened that file, and hands it over once through `take_link_export`.
 * The link used to send the export request as an event right after the open:
 * on a cold start the window was not listening yet, so it was lost, and on a
 * warm start the dialog could open before the file had loaded.
 */

import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "../store/documentStore";
import { useUiStore } from "../store/uiStore";

const LINK_FORMATS = ["pdf", "docx", "html", "epub"] as const;
type LinkFormat = (typeof LINK_FORMATS)[number];

function isLinkFormat(f: unknown): f is LinkFormat {
  return LINK_FORMATS.includes(f as LinkFormat);
}

/**
 * After `path` was opened from a link, open the export dialog with the format
 * the link asked for, if it asked and `path` is still the active document.
 */
export async function applyLinkExport(path: string): Promise<void> {
  const format = await invoke<string | null>("take_link_export", { path }).catch(
    () => null,
  );
  if (!isLinkFormat(format)) return;
  if (useDocumentStore.getState().path !== path) return;
  useUiStore.getState().openExport(format);
}
