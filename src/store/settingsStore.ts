import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeId = "paper" | "sepia" | "midnight";

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "paper", label: "Paper" },
  { id: "sepia", label: "Sepia" },
  { id: "midnight", label: "Midnight" },
];

/**
 * Sentinel for "never ask again" about the default-handler prompt.
 *
 * It is the maximum timestamp ECMAScript `Date` supports, so it is always in
 * the future, is finite (survives `JSON.stringify`, unlike `Infinity` which
 * serializes to `null`), and reads naturally as "snoozed until the end of time".
 */
export const NEVER_ASK_DEFAULT = 8_640_000_000_000_000;

interface SettingsState {
  theme: ThemeId;
  fontSize: number;
  contentWidth: number;
  setTheme: (theme: ThemeId) => void;
  cycleTheme: () => void;
  setFontSize: (fontSize: number) => void;
  setContentWidth: (width: number) => void;
  /** Fire native OS notifications on real agent activity (default on). */
  notificationsEnabled: boolean;
  setNotificationsEnabled: (v: boolean) => void;

  /**
   * Explicit Obsidian vault-root override. When set, wikilink resolution and
   * "ask your vault" use this folder; when null, the app auto-detects the vault
   * by walking up from the open file for a `.obsidian/` marker.
   */
  vaultRoot: string | null;
  setVaultRoot: (path: string | null) => void;

  /**
   * When (epoch ms) the default-handler prompt may show again.
   *   - `null`               → not snoozed; show whenever the app is not default.
   *   - future timestamp     → snoozed until then ("Not now").
   *   - `NEVER_ASK_DEFAULT`  → permanently dismissed ("Don't ask again").
   */
  defaultPromptSnoozedUntil: number | null;
  /** Snooze the prompt for `days` (default 14). */
  snoozeDefaultPrompt: (days?: number) => void;
  /** Permanently stop asking. */
  neverAskDefault: () => void;
  /** Clear any snooze so the prompt can show again. */
  resetDefaultPrompt: () => void;
}

const order: ThemeId[] = THEMES.map((t) => t.id);

const DAY_MS = 24 * 60 * 60 * 1000;

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
      setContentWidth: (contentWidth) =>
        set({ contentWidth: Math.min(960, Math.max(600, contentWidth)) }),

      notificationsEnabled: true,
      setNotificationsEnabled: (notificationsEnabled) => set({ notificationsEnabled }),

      vaultRoot: null,
      setVaultRoot: (vaultRoot) => set({ vaultRoot }),

      defaultPromptSnoozedUntil: null,
      snoozeDefaultPrompt: (days = 14) =>
        set({ defaultPromptSnoozedUntil: Date.now() + days * DAY_MS }),
      neverAskDefault: () => set({ defaultPromptSnoozedUntil: NEVER_ASK_DEFAULT }),
      resetDefaultPrompt: () => set({ defaultPromptSnoozedUntil: null }),
    }),
    {
      name: "mdopener-settings",
      version: 1,
      // v0 stored a permanent `defaultPromptDismissed: boolean`. Map a dismissed
      // prompt to the "never ask" sentinel so prior choices are honored.
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Record<string, unknown> & {
          defaultPromptDismissed?: boolean;
          defaultPromptSnoozedUntil?: number | null;
        };
        if (version < 1) {
          s.defaultPromptSnoozedUntil = s.defaultPromptDismissed
            ? NEVER_ASK_DEFAULT
            : null;
          delete s.defaultPromptDismissed;
        }
        return s as unknown as SettingsState;
      },
    },
  ),
);

/** True when the default-handler prompt is currently snoozed (or never-ask). */
export function isDefaultPromptSnoozed(snoozedUntil: number | null): boolean {
  return snoozedUntil !== null && snoozedUntil > Date.now();
}
