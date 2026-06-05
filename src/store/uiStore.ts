import { create } from "zustand";

interface UiState {
  exportOpen: boolean;
  openExport: () => void;
  closeExport: () => void;
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  commandPaletteOpen: boolean;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleCommandPalette: () => void;
  activityOpen: boolean;
  openActivity: () => void;
  closeActivity: () => void;
  toggleActivity: () => void;
  outlineOpen: boolean;
  openOutline: () => void;
  closeOutline: () => void;
  toggleOutline: () => void;
  /** Cross-file search panel (shares the left dock with activity/outline). */
  searchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
  toggleSearch: () => void;
  /** In-document find bar (read view). */
  findOpen: boolean;
  openFind: () => void;
  closeFind: () => void;
  toggleFind: () => void;
  /** Distraction-free mode: hides all chrome and centers the content. */
  zenMode: boolean;
  openZen: () => void;
  closeZen: () => void;
  toggleZen: () => void;
}

/**
 * Thin UI-flag store for transient overlay state that doesn't belong in
 * documentStore (file I/O) or settingsStore (persisted prefs).
 */
export const useUiStore = create<UiState>((set) => ({
  exportOpen: false,
  openExport: () => set({ exportOpen: true }),
  closeExport: () => set({ exportOpen: false }),
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  commandPaletteOpen: false,
  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  toggleCommandPalette: () =>
    set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  // Activity, Outline, and Search share the left dock and are mutually
  // exclusive: opening one closes the others.
  activityOpen: false,
  openActivity: () =>
    set({ activityOpen: true, outlineOpen: false, searchOpen: false }),
  closeActivity: () => set({ activityOpen: false }),
  toggleActivity: () =>
    set((s) => ({
      activityOpen: !s.activityOpen,
      outlineOpen: false,
      searchOpen: false,
    })),
  outlineOpen: false,
  openOutline: () => set({ outlineOpen: true, activityOpen: false, searchOpen: false }),
  closeOutline: () => set({ outlineOpen: false }),
  toggleOutline: () =>
    set((s) => ({
      outlineOpen: !s.outlineOpen,
      activityOpen: false,
      searchOpen: false,
    })),
  searchOpen: false,
  openSearch: () => set({ searchOpen: true, activityOpen: false, outlineOpen: false }),
  closeSearch: () => set({ searchOpen: false }),
  toggleSearch: () =>
    set((s) => ({
      searchOpen: !s.searchOpen,
      activityOpen: false,
      outlineOpen: false,
    })),
  findOpen: false,
  openFind: () => set({ findOpen: true }),
  closeFind: () => set({ findOpen: false }),
  toggleFind: () => set((s) => ({ findOpen: !s.findOpen })),
  zenMode: false,
  openZen: () => set({ zenMode: true }),
  closeZen: () => set({ zenMode: false }),
  toggleZen: () => set((s) => ({ zenMode: !s.zenMode })),
}));
