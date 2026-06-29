/**
 * pasteImage.ts — shared clipboard-image paste handling for the editors.
 *
 * When the user pastes an image, we save its bytes either:
 *   - next to the open document in an `assets/` subfolder (default, "doc-relative"), or
 *   - to `~/Downloads/mdopener-paste/` (opt-in via Settings toggle).
 *
 * The Rust command `save_pasted_image` handles the doc-relative path, confining
 * the write to the document's own folder.  The Rust command
 * `save_pasted_image_to_downloads` handles the downloads path.
 *
 * Both the CodeMirror source editor and the Milkdown WYSIWYG editor route their
 * paste events through {@link handleImagePaste} (legacy, always doc-relative) or
 * the new {@link handleImagePasteWithSettings} which reads the settings toggle.
 */

import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "../store/documentStore";
import type { PasteImageTarget } from "../store/settingsStore";
import { toast } from "../store/toastStore";

/** MIME → file extension for the image types the backend allowlist accepts. */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** The first clipboard item that is a supported image, or null. */
function firstImageItem(items: DataTransferItemList | null): DataTransferItem | null {
  if (!items) return null;
  for (const item of items) {
    if (item.kind === "file" && MIME_TO_EXT[item.type]) return item;
  }
  return null;
}

/**
 * If `clipboard` carries a supported image, save it next to the open document
 * and return the `![](<relativePath>)` Markdown to insert at the cursor.
 *
 * Returns `null` when there's no image to handle (the caller should let the
 * default paste proceed). When an image IS present but can't be handled
 * (unsaved document, read/save failure), this shows a toast and returns `null`
 * after the caller has already prevented default — so nothing wrong is inserted.
 *
 * Callers should check {@link clipboardHasImage} first to decide whether to
 * `preventDefault()`, then await this for the markdown.
 */
export async function handleImagePaste(
  clipboard: DataTransfer | null,
): Promise<string | null> {
  return handleImagePasteWithSettings(clipboard, "doc-relative");
}

/**
 * Settings-aware image paste handler.
 *
 * Saves the image to the location specified by `target`:
 *   - `"doc-relative"` → `<doc-dir>/assets/<filename>` via Rust `save_pasted_image`
 *   - `"downloads"`    → `~/Downloads/mdopener-paste/<filename>` via
 *                        Rust `save_pasted_image_to_downloads`
 *
 * Returns the Markdown reference to insert (`![](<path>)`), or `null` on
 * failure / no image.  See {@link handleImagePaste} for the full contract.
 */
export async function handleImagePasteWithSettings(
  clipboard: DataTransfer | null,
  target: PasteImageTarget,
): Promise<string | null> {
  const item = firstImageItem(clipboard?.items ?? null);
  if (!item) return null;

  const docPath = useDocumentStore.getState().path;

  // For "doc-relative" mode a saved document is required so the Rust side can
  // resolve a sibling folder.  "downloads" mode has no such requirement.
  if (target === "doc-relative" && !docPath) {
    toast.info("Save the document before pasting images");
    return null;
  }

  const blob = item.getAsFile();
  if (!blob) return null;
  const ext = MIME_TO_EXT[blob.type];
  if (!ext) return null;

  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const bytes = Array.from(buf);

    if (target === "downloads") {
      // Rust returns the full absolute path; we insert it as-is so the editor
      // can render or link to the file outside the vault.
      const absPath = await invoke<string>("save_pasted_image_to_downloads", {
        bytes,
        ext,
      });
      return `![](${absPath})`;
    }

    // doc-relative (default)
    const relPath = await invoke<string>("save_pasted_image", {
      docPath,
      bytes,
      ext,
    });
    return `![](${relPath})`;
  } catch (e) {
    toast.error(`Could not save pasted image: ${String(e)}`);
    return null;
  }
}

/** True if the clipboard carries at least one supported image file. */
export function clipboardHasImage(clipboard: DataTransfer | null): boolean {
  return firstImageItem(clipboard?.items ?? null) !== null;
}

/**
 * Derive the expected save path for a pasted image given the target mode.
 * Pure helper — useful for tests and preview UIs.
 *
 * @param docPath   Absolute path of the open document (only relevant for
 *                  `"doc-relative"` mode; ignored for `"downloads"`).
 * @param filename  The intended filename (e.g. `"image-abc.png"`).
 * @param target    Where to save.
 * @returns         The expected save path string (relative for doc-relative,
 *                  absolute-like for downloads).
 */
export function expectedSavePath(
  docPath: string | null,
  filename: string,
  target: PasteImageTarget,
): string {
  if (target === "downloads") {
    return `~/Downloads/mdopener-paste/${filename}`;
  }
  if (!docPath) return `assets/${filename}`;
  // Strip the filename portion of the doc path to get the directory.
  const dir = docPath.replace(/\/[^/]+$/, "");
  return `${dir}/assets/${filename}`;
}

/**
 * Generate a consistent pasted-image filename from an extension and an opaque
 * token (timestamp + random suffix by default).  Pure function — deterministic
 * when `token` is supplied, which is useful in tests.
 */
export function pasteImageFilename(ext: string, token?: string): string {
  const t = token ?? `${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  return `image-${t}.${ext}`;
}
