import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ExportProfileId, ExportTemplate } from "../lib/exportTemplates";
import { ALL_PROFILE_IDS, NO_TEMPLATE_ID, newTemplateId } from "../lib/exportTemplates";
import type { LintRuleConfig } from "../lib/mdlint";
import type { UserSnippet } from "../lib/snippets";

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
   * Re-index semantic-search embeddings automatically (watched-folder changes
   * and at startup). New installs: off. Installs that predate this setting keep
   * their old always-on behavior (v8 migration). The manual "Reindex library"
   * button works either way.
   */
  autoEmbedIndex: boolean;
  setAutoEmbedIndex: (v: boolean) => void;

  /**
   * Load web (`https:`) images in documents as they render. Off, a web image
   * shows as a placeholder until the user loads the document's remote images
   * (see store/remoteImagesStore.ts): a fetched image tells its host the
   * document was opened. Default on, as before the setting existed, so no
   * document's images go missing; a persisted state without the field takes
   * the default.
   */
  loadRemoteImages: boolean;
  setLoadRemoteImages: (v: boolean) => void;

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
  updateUserTemplate: (
    id: string,
    patch: Partial<Omit<ExportTemplate, "id" | "builtin">>,
  ) => void;

  /** Remove a user template by id (no-op if id not found or is a built-in). */
  removeUserTemplate: (id: string) => void;

  /** Set the active export template. Pass `NO_TEMPLATE_ID` to clear. */
  setActiveTemplateId: (id: string) => void;

  // ── Export format toggles ───────────────────────────────────────────────────

  /**
   * When true, the EPUB format is shown in Settings → Export Formats and the
   * export dialog.  Defaults to true so new installs get EPUB out of the box.
   */
  epubEnabled: boolean;
  setEpubEnabled: (enabled: boolean) => void;

  // ── Export profile toggles ──────────────────────────────────────────────────

  /**
   * Set of export profile ids that the user has explicitly disabled.
   * All profiles not in this set are considered enabled.
   * Defaults to empty (all 6 profiles enabled out of the box).
   */
  disabledProfileIds: ExportProfileId[];

  /**
   * Toggle a single export profile on or off by id.
   * If disabled, re-enables it; if enabled, disables it.
   */
  toggleExportProfile: (profileId: ExportProfileId) => void;

  /**
   * Returns true when the given profile id is currently enabled.
   */
  isProfileEnabled: (profileId: ExportProfileId) => boolean;

  /** Replace the full disabled-profiles list (used by bulk reset). */
  setDisabledProfileIds: (ids: ExportProfileId[]) => void;

  // ── Snippet engine ──────────────────────────────────────────────────────────

  /**
   * User-defined markdown snippets available in the source editor.
   * Each entry appears in the autocompletion popup alongside the built-in ones.
   */
  customSnippets: UserSnippet[];

  /** Replace all custom snippets (used by the snippet settings UI). */
  setCustomSnippets: (snippets: UserSnippet[]) => void;

  /** Append a new custom snippet. */
  addCustomSnippet: (snippet: UserSnippet) => void;

  /** Remove a custom snippet by label. */
  removeCustomSnippet: (label: string) => void;

  /** Update a custom snippet by its current label. */
  updateCustomSnippet: (label: string, patch: Partial<UserSnippet>) => void;
}

const order: ThemeId[] = THEMES.map((t) => t.id);

const DAY_MS = 24 * 60 * 60 * 1000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

/**
 * A persisted setting as the store reads it, or undefined when its type is
 * wrong (the default is kept). Arrays keep only their well-formed entries.
 */
function checkedSetting(key: string, v: unknown): unknown {
  switch (key) {
    case "theme":
      return order.includes(v as ThemeId) ? v : undefined;
    case "fontSize":
      return typeof v === "number" && Number.isFinite(v) ? clamp(v, 13, 24) : undefined;
    case "contentWidth":
      return typeof v === "number" && Number.isFinite(v)
        ? clamp(v, 600, 960)
        : undefined;
    case "notificationsEnabled":
    case "autoEmbedIndex":
    case "loadRemoteImages":
    case "epubEnabled":
      return typeof v === "boolean" ? v : undefined;
    case "vaultRoot":
      return v === null || (typeof v === "string" && v !== "") ? v : undefined;
    case "defaultPromptSnoozedUntil":
      return v === null || (typeof v === "number" && Number.isFinite(v))
        ? v
        : undefined;
    case "pasteImageTarget":
      return v === "doc-relative" || v === "downloads" ? v : undefined;
    case "linterConfig": {
      const rules = isRecord(v) ? strings(v.disabledRules) : undefined;
      return rules ? { disabledRules: rules } : undefined;
    }
    case "activeTemplateId":
      return typeof v === "string" ? v : undefined;
    case "userTemplates":
      return Array.isArray(v)
        ? v
            .filter(
              (t) =>
                isRecord(t) &&
                typeof t.id === "string" &&
                typeof t.name === "string" &&
                typeof t.css === "string",
            )
            .map((t) => ({ ...t, builtin: false }))
        : undefined;
    case "disabledProfileIds":
      return strings(v)?.filter((id) =>
        (ALL_PROFILE_IDS as readonly string[]).includes(id),
      );
    case "customSnippets":
      return Array.isArray(v)
        ? v.filter(
            (sn) =>
              isRecord(sn) &&
              typeof sn.label === "string" &&
              typeof sn.template === "string" &&
              (sn.detail === undefined || typeof sn.detail === "string"),
          )
        : undefined;
    default:
      return v;
  }
}

/**
 * The persisted settings merged into the defaults (`persist`'s `merge`).
 * Every value is checked against the type the store reads: the default
 * merge took whatever the stored JSON held, so a damaged or hand-edited
 * file, or a newer version that changed a value's type, put a `null`
 * `linterConfig` (the linter settings threw on `disabledRules`), a string
 * `fontSize` or an unknown `theme` into the app. A value of the wrong type
 * keeps its default; a key missing (a setting added since, such as
 * `loadRemoteImages`) takes its default. Keys this version does not know
 * (a newer version's) are kept, so they survive the next write, but never
 * one that names an action.
 */
export function mergePersistedSettings(
  persisted: unknown,
  current: SettingsState,
): SettingsState {
  if (!isRecord(persisted)) return current;
  const out: Record<string, unknown> = { ...current };
  const known = current as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(persisted)) {
    if (typeof known[key] === "function") continue;
    const checked = key in known ? checkedSetting(key, value) : value;
    if (checked !== undefined) out[key] = checked;
  }
  return out as unknown as SettingsState;
}

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
      autoEmbedIndex: false,
      setAutoEmbedIndex: (autoEmbedIndex) => set({ autoEmbedIndex }),
      loadRemoteImages: true,
      setLoadRemoteImages: (loadRemoteImages) => set({ loadRemoteImages }),

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
          userTemplates: [...s.userTemplates, { ...partial, id, builtin: false }],
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

      // ── Export format toggles ───────────────────────────────────────────────
      epubEnabled: true,
      setEpubEnabled: (epubEnabled) => set({ epubEnabled }),

      // ── Export profile toggles ──────────────────────────────────────────────
      disabledProfileIds: [],

      toggleExportProfile: (profileId) =>
        set((s) => {
          const disabled = s.disabledProfileIds;
          const next = disabled.includes(profileId)
            ? disabled.filter((id) => id !== profileId)
            : [...disabled, profileId];
          return { disabledProfileIds: next };
        }),

      isProfileEnabled: (profileId) => !get().disabledProfileIds.includes(profileId),

      setDisabledProfileIds: (ids) => set({ disabledProfileIds: ids }),

      // ── Snippet engine ──────────────────────────────────────────────────
      customSnippets: [],

      setCustomSnippets: (snippets) => set({ customSnippets: snippets }),

      addCustomSnippet: (snippet) =>
        set((s) => ({ customSnippets: [...s.customSnippets, snippet] })),

      removeCustomSnippet: (label) =>
        set((s) => ({
          customSnippets: s.customSnippets.filter((sn) => sn.label !== label),
        })),

      updateCustomSnippet: (label, patch) =>
        set((s) => ({
          customSnippets: s.customSnippets.map((sn) =>
            sn.label === label ? { ...sn, ...patch } : sn,
          ),
        })),
    }),
    {
      name: "mdopener-settings",
      version: 8,
      merge: mergePersistedSettings,
      // v0 stored a permanent `defaultPromptDismissed: boolean`. Map a dismissed
      // prompt to the "never ask" sentinel so prior choices are honored.
      // v2 adds userTemplates + activeTemplateId (default to empty / "none").
      // v3 adds pasteImageTarget (default to "doc-relative").
      // v4 adds linterConfig (default to all rules enabled).
      // v5 adds epubEnabled (default true).
      // v6 adds customSnippets (default []).
      // v7 adds disabledProfileIds (default [] = all profiles enabled).
      // v8 adds autoEmbedIndex (new installs false; existing installs true, since
      // they already re-indexed automatically before the setting existed).
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Record<string, unknown> & {
          defaultPromptDismissed?: boolean;
          defaultPromptSnoozedUntil?: number | null;
          userTemplates?: ExportTemplate[];
          activeTemplateId?: string;
          pasteImageTarget?: PasteImageTarget;
          linterConfig?: { disabledRules: string[] };
          epubEnabled?: boolean;
          customSnippets?: UserSnippet[];
          disabledProfileIds?: ExportProfileId[];
          autoEmbedIndex?: boolean;
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
        if (version < 5) {
          s.epubEnabled = s.epubEnabled ?? true;
        }
        if (version < 6) {
          s.customSnippets = s.customSnippets ?? [];
        }
        if (version < 7) {
          s.disabledProfileIds = s.disabledProfileIds ?? [];
        }
        if (version < 8) {
          s.autoEmbedIndex = s.autoEmbedIndex ?? true;
        }
        // Always reconcile persisted disabled ids against the current set of
        // known profiles so stale ids from removed/renamed profiles don't
        // silently keep a (now-nonexistent) profile "disabled".
        if (Array.isArray(s.disabledProfileIds)) {
          s.disabledProfileIds = s.disabledProfileIds.filter(
            (id): id is ExportProfileId =>
              (ALL_PROFILE_IDS as readonly string[]).includes(id),
          );
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
