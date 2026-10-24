/**
 * remoteImagesStore.ts — whether the read view loads web images.
 *
 * A web image in a document (`![](https://host/pixel.png)`) is fetched as
 * soon as the document renders, which tells that host the document was
 * opened (a tracking pixel). The webview's CSP (src-tauri/tauri.conf.json)
 * allows `https:` images and cannot be changed while the app runs, so the
 * renderer enforces the choice: with Settings → "Load remote images" off, a
 * web image is not rendered until the user loads the document's remote
 * images, for this document and this session only.
 */

import { create } from "zustand";
import { useSettingsStore } from "./settingsStore";

interface RemoteImagesState {
  /** Documents (by path, `""` for an unsaved one) whose web images load. */
  allowed: Record<string, true>;
  /** Load the web images of the document at `path` for this session. */
  allow: (path: string | null) => void;
}

export const useRemoteImagesStore = create<RemoteImagesState>()((set) => ({
  allowed: {},
  allow: (path) => set((s) => ({ allowed: { ...s.allowed, [path ?? ""]: true } })),
}));

/** Whether web images of the document at `path` load (see module doc). */
export function remoteImagesAllowed(path: string | null): boolean {
  return (
    useSettingsStore.getState().loadRemoteImages ||
    useRemoteImagesStore.getState().allowed[path ?? ""] === true
  );
}

/** {@link remoteImagesAllowed}, as a hook that follows both stores. */
export function useRemoteImagesAllowed(path: string | null): boolean {
  const setting = useSettingsStore((s) => s.loadRemoteImages);
  const allowed = useRemoteImagesStore((s) => s.allowed[path ?? ""] === true);
  return setting || allowed;
}
