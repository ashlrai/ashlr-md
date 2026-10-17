import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface RecentFile {
  path: string;
  fileName: string;
  openedAt: number;
}

interface RecentState {
  recents: RecentFile[];
  add: (path: string, fileName: string, openedAt: number) => void;
  remove: (path: string) => void;
  clear: () => void;
  /**
   * Drop recents whose file no longer exists. Returns how many were dropped.
   * Fails safe: when the check itself fails, every recent is kept.
   */
  pruneMissing: () => Promise<number>;
}

/** True when `error` (from `read_markdown_file`) says the file is not there. */
export function isMissingFileError(error: unknown): boolean {
  // Rust's io::ErrorKind::NotFound reads "(os error 2)" on macOS, Linux and
  // Windows alike, whatever the localized text before it.
  return /\(os error 2\)/.test(String(error));
}

const MAX_RECENTS = 12;

export const useRecentStore = create<RecentState>()(
  persist(
    (set, get) => ({
      recents: [],
      add: (path, fileName, openedAt) =>
        set((s) => ({
          recents: [
            { path, fileName, openedAt },
            ...s.recents.filter((r) => r.path !== path),
          ].slice(0, MAX_RECENTS),
        })),
      remove: (path) =>
        set((s) => ({ recents: s.recents.filter((r) => r.path !== path) })),
      clear: () => set({ recents: [] }),
      // The recents are mirrored to `/recent`, so a file deleted or moved
      // since it was opened stayed in what `list_recent` gives agents (and in
      // the Recent menu) for good, and opening it only failed.
      pruneMissing: async () => {
        const checked = get().recents.map((r) => r.path);
        if (checked.length === 0) return 0;
        let existing: string[];
        try {
          existing = await invoke<string[]>("filter_existing", { paths: checked });
        } catch {
          return 0;
        }
        const present = new Set(existing);
        const missing = new Set(checked.filter((p) => !present.has(p)));
        if (missing.size === 0) return 0;
        set((s) => ({ recents: s.recents.filter((r) => !missing.has(r.path)) }));
        return missing.size;
      },
    }),
    { name: "mdopener-recents" },
  ),
);
