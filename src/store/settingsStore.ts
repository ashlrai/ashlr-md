import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ExportTemplate } from "../lib/exportTemplates";
import { newTemplateId, NO_TEMPLATE_ID } from "../lib/exportTemplates";
import type { LintRuleConfig } from "../lib/mdlint";

export type ThemeId = "paper" | "sepia" | "midnight";

/**
 * Where pasted images are saved.
 *   "doc-relative" — `<doc-dir>/assets/<filename>` (default, next to the document)
 *   "downloads"    — `~/Downloads/mdopener-paste/<filename>`
 */
export type PasteImageTarget = "doc-relative" | "downloads";

// Re-export so consumers can import from the store without touching lib.
export type { ExportTemplate };
export { NO_TEMPLATE_ID };

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

  /**
   * Where pasted images are saved.
   * Toggle in Settings → "Save pasted images to Downloads".
   * @default "doc-relative"
   */
  pasteImageTarget: PasteImageTarget;
  setPasteImageTarget: (target: PasteImageTarget) => void;

  // ── Linter preferences ─────────────────────────────────────────────────────

  /**
   * Per-vault linter rule configuration.
   * `disabledRules` lists rule IDs the user has explicitly turned off.
   * All rules not in this list are enabled by default.
   */
  linterConfig: LintRuleConfig;

  /** Replace the full linter config (used by the settings panel). */
  setLinterConfig: (config: LintRuleConfig) => void;

  /**
   * Toggle a single rule on or off by id.
   * If the rule is currently disabled, it is re-enabled (removed from the list).
   * If the rule is currently enabled, it is disabled (added to the list).
   */
  toggleLinterRule: (ruleId: string) => void;

  // ── Export template registry ────────────────────────────────────────────────

  /**
   * User-defined export templates stored alongside the built-in ones.
   * Built-in templates (BUILTIN_TEMPLATES) are never mutated here — they live
   * in exportTemplates.ts.  This array holds only user-created / duplicated
   * entries.
   */
  userTemplates: ExportTemplate[];

  /**
   * The id of the currently active export template.
   * `NO_TEMPLATE_ID` ("none") means "use base styles without any template".
   */
  activeTemplateId: string;

  /** Replace the full user template list (used after bulk edits). */
  setUserTemplates: (templates: ExportTemplate[]) => void;

  /** Add a new user template; returns the generated id. */
  addUserTemplate: (partial: Omit<ExportTemplate, "id" | "builtin">) => string;

  /** Update an existing user template by id (no-op if id not found). */
  updateUserTemplate: (id: string, patch: Partial<Omit<ExportTemplate, "id" | "builtin">>) => void;

  /** Remove a user template by id (no-op if id not found or is a built-in). */
  removeUserTemplate: (id: string) => void;

  /** Set the active export template. Pass `NO_TEMPLATE_ID` to clear. */
  setActiveTemplateId: (id: string) => void;
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

      pasteImageTarget: "doc-relative",
      setPasteImageTarget: (pasteImageTarget) => set({ pasteImageTarget }),

      vaultRoot: null,
      setVaultRoot: (vaultRoot) => set({ vaultRoot }),

      defaultPromptSnoozedUntil: null,
      snoozeDefaultPrompt: (days = 14) =>
        set({ defaultPromptSnoozedUntil: Date.now() + days * DAY_MS }),
      neverAskDefault: () => set({ defaultPromptSnoozedUntil: NEVER_ASK_DEFAULT }),
      resetDefaultPrompt: () => set({ defaultPromptSnoozedUntil: null }),

      // ── Linter preferences ───────────────────────────────────────────────
      linterConfig: { disabledRules: [] },

      setLinterConfig: (config) => set({ linterConfig: config }),

      toggleLinterRule: (ruleId) =>
        set((s) => {
          const disabled = s.linterConfig.disabledRules;
          const next = disabled.includes(ruleId)
            ? disabled.filter((id) => id !== ruleId)
            : [...disabled, ruleId];
          return { linterConfig: { disabledRules: next } };
        }),

      // ── Export template registry ──────────────────────────────────────────
      userTemplates: [],
      activeTemplateId: NO_TEMPLATE_ID,

      setUserTemplates: (templates) => set({ userTemplates: templates }),

      addUserTemplate: (partial) => {
        const id = newTemplateId();
        set((s) => ({
          userTemplates: [
            ...s.userTemplates,
            { ...partial, id, builtin: false },
          ],
        }));
        return id;
      },

      updateUserTemplate: (id, patch) =>
        set((s) => ({
          userTemplates: s.userTemplates.map((t) =>
            t.id === id ? { ...t, ...patch } : t,
          ),
        })),

      removeUserTemplate: (id) =>
        set((s) => {
          const next = s.userTemplates.filter((t) => t.id !== id);
          // If the removed template was active, fall back to "none".
          const activeTemplateId =
            s.activeTemplateId === id ? NO_TEMPLATE_ID : s.activeTemplateId;
          return { userTemplates: next, activeTemplateId };
        }),

      setActiveTemplateId: (id) => set({ activeTemplateId: id }),
    }),
    {
      name: "mdopener-settings",
      version: 4,
      // v0 stored a permanent `defaultPromptDismissed: boolean`. Map a dismissed
      // prompt to the "never ask" sentinel so prior choices are honored.
      // v2 adds userTemplates + activeTemplateId (default to empty / "none").
      // v3 adds pasteImageTarget (default to "doc-relative").
      // v4 adds linterConfig (default to all rules enabled).
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Record<string, unknown> & {
          defaultPromptDismissed?: boolean;
          defaultPromptSnoozedUntil?: number | null;
          userTemplates?: ExportTemplate[];
          activeTemplateId?: string;
          pasteImageTarget?: PasteImageTarget;
          linterConfig?: { disabledRules: string[] };
        };
        if (version < 1) {
          s.defaultPromptSnoozedUntil = s.defaultPromptDismissed
            ? NEVER_ASK_DEFAULT
            : null;
          delete s.defaultPromptDismissed;
        }
        if (version < 2) {
          s.userTemplates = s.userTemplates ?? [];
          s.activeTemplateId = s.activeTemplateId ?? NO_TEMPLATE_ID;
        }
        if (version < 3) {
          s.pasteImageTarget = s.pasteImageTarget ?? "doc-relative";
        }
        if (version < 4) {
          s.linterConfig = s.linterConfig ?? { disabledRules: [] };
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
