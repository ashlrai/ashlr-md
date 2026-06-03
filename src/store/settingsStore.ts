import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeId = "paper" | "sepia" | "midnight";

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "paper", label: "Paper" },
  { id: "sepia", label: "Sepia" },
  { id: "midnight", label: "Midnight" },
];

interface SettingsState {
  theme: ThemeId;
  fontSize: number;
  contentWidth: number;
  setTheme: (theme: ThemeId) => void;
  cycleTheme: () => void;
  setFontSize: (fontSize: number) => void;
  defaultPromptDismissed: boolean;
  setDefaultPromptDismissed: (v: boolean) => void;
}

const order: ThemeId[] = THEMES.map((t) => t.id);

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: "paper",
      fontSize: 17,
      contentWidth: 720,
      setTheme: (theme) => set({ theme }),
      cycleTheme: () => {
        const i = order.indexOf(get().theme);
        set({ theme: order[(i + 1) % order.length] });
      },
      setFontSize: (fontSize) =>
        set({ fontSize: Math.min(24, Math.max(13, fontSize)) }),
      defaultPromptDismissed: false,
      setDefaultPromptDismissed: (defaultPromptDismissed) =>
        set({ defaultPromptDismissed }),
    }),
    { name: "mdopener-settings" },
  ),
);
