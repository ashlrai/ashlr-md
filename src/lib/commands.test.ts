/**
 * commands.test.ts — unit tests for src/lib/commands.ts + src/lib/keymap.ts
 *
 * Coverage:
 *   (1) All Command ids are unique and non-empty
 *   (2) All shortcuts parse correctly via the keymap engine — no collisions,
 *       valid mod+ syntax, key is non-empty
 *   (3) Each command's when() predicate is deterministic (view-mode / selection
 *       state / tab count) and reflects the intended conditions
 *   (4) Export / activity-drawer / palette commands execute without crashing
 *       when their pre-conditions are met
 *   (5) Keyboard shortcut dispatch: matchShortcut fires on the correct command
 *       (⌘K, ⌘E, ⌘1/2/3, ⌘B, ⌘⇧O all wire correctly)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── All vi.mock() calls must come before any imports that trigger side-effects.
// Factories must be self-contained (no references to variables in this module)
// because Vitest hoists them to the top of the file.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));

vi.mock("../store/toastStore", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("./activity", () => ({
  unwatchDirectory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./export", () => ({
  exportHtml: vi.fn().mockResolvedValue(undefined),
  exportPdf: vi.fn().mockResolvedValue(undefined),
  exportDocx: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./copyRichText", () => ({
  copyDocumentAsRichText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./tableEditor", () => ({
  buildEmptyTable: vi.fn().mockReturnValue("| Column 1 | Column 2 |\n| --- | --- |\n|  |  |"),
}));

vi.mock("./openFile", () => ({
  pickAndOpen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./sourceSearchBridge", () => ({
  getSourceView: vi.fn().mockReturnValue(null),
}));

vi.mock("./waitForElement", () => ({
  waitForElement: vi.fn().mockResolvedValue(undefined),
}));

// ── Store mocks: factories return live references to module-level objects so
// tests can mutate state between cases without re-requiring.

/** Shared mutable doc state — mutate in tests, reset in beforeEach. */
const docState = {
  path: "/tmp/test.md" as string | null,
  fileName: "test.md",
  content: "# Hello\n\n",
  viewMode: "read" as "read" | "edit" | "source",
  splitView: false,
  tabs: [] as { id: string; path: string; fileName: string }[],
  setViewMode: vi.fn(),
  toggleSplitView: vi.fn(),
  setContent: vi.fn(),
  save: vi.fn(),
  close: vi.fn(),
  nextTab: vi.fn(),
  prevTab: vi.fn(),
};

const uiState = {
  openExport: vi.fn(),
  openSettings: vi.fn(),
  openFind: vi.fn(),
  openActivity: vi.fn(),
  toggleZen: vi.fn(),
  toggleSearch: vi.fn(),
  toggleActivity: vi.fn(),
  toggleOutline: vi.fn(),
  toggleCommandPalette: vi.fn(),
};

const aiState = { toggle: vi.fn() };

const settingsState = {
  theme: "paper" as string,
  cycleTheme: vi.fn(),
  setTheme: vi.fn(),
};

// These factories capture the module-scope objects by closure.
// Because vi.mock is hoisted but the factory body runs lazily on first import,
// the objects are already initialised by the time the factory executes.
vi.mock("../store/documentStore", () => ({
  useDocumentStore: {
    get getState() {
      // Return a function that returns the live docState object.
      // Using a getter delays evaluation until after hoisting.
      return () => docState;
    },
  },
}));

vi.mock("../store/uiStore", () => ({
  useUiStore: {
    get getState() {
      return () => uiState;
    },
  },
}));

vi.mock("../store/aiStore", () => ({
  useAIStore: {
    get getState() {
      return () => aiState;
    },
  },
}));

vi.mock("../store/activityStore", () => ({
  useActivityStore: {
    getState: () => ({ setWatchedDir: vi.fn() }),
  },
}));

vi.mock("../store/settingsStore", () => ({
  THEMES: [
    { id: "paper", label: "Paper" },
    { id: "sepia", label: "Sepia" },
    { id: "midnight", label: "Midnight" },
  ],
  useSettingsStore: {
    get getState() {
      return () => settingsState;
    },
  },
}));

// ── Imports of modules under test (after all mocks) ───────────────────────────

import { getCommands, getShortcutCommands, COMMAND_GROUPS } from "./commands";
import { matchShortcut, formatShortcut } from "./keymap";

// ── Typed access to mocked modules ───────────────────────────────────────────

import { invoke } from "@tauri-apps/api/core";
import { toast } from "../store/toastStore";
import { copyDocumentAsRichText } from "./copyRichText";
import { pickAndOpen } from "./openFile";
import { exportHtml, exportPdf, exportDocx } from "./export";

const invokeMock = vi.mocked(invoke);
const toastErrorMock = vi.mocked(toast.error);
const toastSuccessMock = vi.mocked(toast.success);
const copyRichTextMock = vi.mocked(copyDocumentAsRichText);
const pickAndOpenMock = vi.mocked(pickAndOpen);
const exportHtmlMock = vi.mocked(exportHtml);
const exportPdfMock = vi.mocked(exportPdf);
const exportDocxMock = vi.mocked(exportDocx);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal KeyboardEvent-like object that matchShortcut can consume.
 *
 * happy-dom reports navigator.platform as "X11; Darwin arm64" which does NOT
 * match the /Mac|iPhone|iPad|iPod/ regex in keymap.ts, so IS_MAC=false there.
 * Therefore `mod` maps to ctrlKey (not metaKey) in the test environment.
 */
function makeEvent(shortcut: string): KeyboardEvent {
  const parts = shortcut.toLowerCase().split("+");
  const mod = parts.includes("mod");
  const shift = parts.includes("shift");
  const alt = parts.includes("alt") || parts.includes("option");
  const key = parts.find((p) => !["mod", "shift", "alt", "option", "opt"].includes(p)) ?? "";
  return {
    // IS_MAC=false in happy-dom → mod resolves to ctrlKey, not metaKey
    ctrlKey: mod,
    metaKey: false,
    shiftKey: shift,
    altKey: alt,
    key,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as KeyboardEvent;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset doc state to canonical "has a file, read view, one tab"
  docState.path = "/tmp/test.md";
  docState.content = "# Hello\n\n";
  docState.viewMode = "read";
  docState.tabs = [{ id: "t1", path: "/tmp/test.md", fileName: "test.md" }];
  settingsState.theme = "paper";

  // Reset all vi.fn() spies on the state objects
  const allFns = [
    ...Object.values(docState),
    ...Object.values(uiState),
    ...Object.values(aiState),
    ...Object.values(settingsState),
  ].filter((v): v is ReturnType<typeof vi.fn> => typeof v === "function" && "mockReset" in v);
  for (const fn of allFns) fn.mockReset();

  // Stub window.prompt for insert-table command
  vi.stubGlobal("prompt", vi.fn().mockReturnValue("3"));

  // Restore return values that commands depend on
  docState.save.mockResolvedValue(undefined);

  invokeMock.mockReset().mockResolvedValue(undefined);
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  copyRichTextMock.mockReset().mockResolvedValue(undefined);
  pickAndOpenMock.mockReset().mockResolvedValue(undefined);
  exportHtmlMock.mockReset().mockResolvedValue(undefined);
  exportPdfMock.mockReset().mockResolvedValue(undefined);
  exportDocxMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// (1) ID uniqueness + structural shape
// ═══════════════════════════════════════════════════════════════════════════════

describe("Command registry — id uniqueness and shape", () => {
  it("getCommands() returns a non-empty array", () => {
    expect(getCommands().length).toBeGreaterThan(0);
  });

  it("every command has a non-empty id string", () => {
    for (const cmd of getCommands()) {
      expect(typeof cmd.id, `command id must be a string (got ${typeof cmd.id})`).toBe("string");
      expect(cmd.id.trim().length, `id must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("all command ids are unique — no duplicates", () => {
    const ids = getCommands().map((c) => c.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("every command has a non-empty title string", () => {
    for (const cmd of getCommands()) {
      expect(typeof cmd.title).toBe("string");
      expect(cmd.title.trim().length).toBeGreaterThan(0);
    }
  });

  it("every command belongs to a declared COMMAND_GROUPS section", () => {
    const allowedGroups = new Set<string>([...COMMAND_GROUPS]);
    for (const cmd of getCommands()) {
      expect(allowedGroups.has(cmd.group), `Unknown group '${cmd.group}' on command '${cmd.id}'`).toBe(true);
    }
  });

  it("every command has a run function", () => {
    for (const cmd of getCommands()) {
      expect(typeof cmd.run).toBe("function");
    }
  });

  it("known important commands are present by id", () => {
    const ids = new Set(getCommands().map((c) => c.id));
    const required = [
      "app.commandPalette",
      "file.export.dialog",
      "view.activity.toggle",
      "view.outline.toggle",
      "view.read",
      "view.edit",
      "view.source",
      "ai.toggle",
      "theme.cycle",
      "edit.copyRichText",
      "edit.insertTable",
      "file.open",
      "file.save",
      "file.close",
      "tab.next",
      "tab.prev",
      "tab.close",
      "find.document",
      "find.replace",
      "view.zen.toggle",
      "view.search.toggle",
    ];
    for (const id of required) {
      expect(ids.has(id), `Missing expected command '${id}'`).toBe(true);
    }
  });

  it("COMMAND_GROUPS exports all expected section labels", () => {
    expect(COMMAND_GROUPS).toContain("File");
    expect(COMMAND_GROUPS).toContain("View");
    expect(COMMAND_GROUPS).toContain("Edit");
    expect(COMMAND_GROUPS).toContain("AI");
    expect(COMMAND_GROUPS).toContain("Appearance");
    expect(COMMAND_GROUPS).toContain("App");
  });

  it("theme.set.* commands exist for each theme", () => {
    const ids = new Set(getCommands().map((c) => c.id));
    expect(ids.has("theme.set.paper")).toBe(true);
    expect(ids.has("theme.set.sepia")).toBe(true);
    expect(ids.has("theme.set.midnight")).toBe(true);
  });

  it("getShortcutCommands() returns a subset of getCommands()", () => {
    const allIds = new Set(getCommands().map((c) => c.id));
    for (const cmd of getShortcutCommands()) {
      expect(allIds.has(cmd.id)).toBe(true);
    }
  });

  it("getShortcutCommands() only includes commands that have a shortcut", () => {
    for (const cmd of getShortcutCommands()) {
      expect(typeof cmd.shortcut).toBe("string");
      expect((cmd.shortcut as string).length).toBeGreaterThan(0);
    }
  });

  it("commands with no shortcut property are excluded from getShortcutCommands()", () => {
    const withoutShortcut = getCommands().filter((c) => !c.shortcut);
    const shortcutIds = new Set(getShortcutCommands().map((c) => c.id));
    for (const cmd of withoutShortcut) {
      expect(shortcutIds.has(cmd.id)).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (2) Shortcut parsing + collision detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("Command shortcuts — parsing and collision detection", () => {
  it("all shortcuts start with 'mod+' (require the platform command modifier)", () => {
    for (const cmd of getShortcutCommands()) {
      expect(
        (cmd.shortcut as string).startsWith("mod+"),
        `Shortcut '${cmd.shortcut}' on '${cmd.id}' does not start with mod+`,
      ).toBe(true);
    }
  });

  it("all shortcuts have a non-empty key token after stripping modifiers", () => {
    const modifiers = new Set(["mod", "shift", "alt", "option", "opt"]);
    for (const cmd of getShortcutCommands()) {
      const parts = (cmd.shortcut as string).toLowerCase().split("+");
      const keys = parts.filter((p) => !modifiers.has(p));
      expect(keys.length, `No key token in shortcut '${cmd.shortcut}' (${cmd.id})`).toBeGreaterThanOrEqual(1);
      expect(keys[0].trim().length, `Empty key token in '${cmd.shortcut}' (${cmd.id})`).toBeGreaterThan(0);
    }
  });

  it("no two commands share the same shortcut — no collision", () => {
    const shortcuts = getShortcutCommands().map((c) => c.shortcut as string);
    const seen = new Map<string, string>();
    for (let i = 0; i < shortcuts.length; i++) {
      const s = shortcuts[i];
      if (seen.has(s)) {
        throw new Error(
          `Shortcut collision: '${s}' used by both '${seen.get(s)}' and '${getShortcutCommands()[i].id}'`,
        );
      }
      seen.set(s, getShortcutCommands()[i].id);
    }
    expect(seen.size).toBe(shortcuts.length);
  });

  it("formatShortcut does not throw for any registered shortcut", () => {
    for (const cmd of getShortcutCommands()) {
      expect(() => formatShortcut(cmd.shortcut as string)).not.toThrow();
    }
  });

  it("formatShortcut returns a non-empty string for every shortcut", () => {
    for (const cmd of getShortcutCommands()) {
      const label = formatShortcut(cmd.shortcut as string);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("matchShortcut returns true when event exactly matches the shortcut", () => {
    for (const cmd of getShortcutCommands()) {
      const e = makeEvent(cmd.shortcut as string);
      expect(
        matchShortcut(e, cmd.shortcut as string),
        `matchShortcut failed for '${cmd.shortcut}' (${cmd.id})`,
      ).toBe(true);
    }
  });

  it("matchShortcut returns false when a different key is pressed", () => {
    const e = makeEvent("mod+k");
    expect(matchShortcut(e, "mod+j")).toBe(false);
  });

  it("matchShortcut is modifier-exact: mod+l does NOT match mod+shift+l", () => {
    const e = makeEvent("mod+l");
    expect(matchShortcut(e, "mod+shift+l")).toBe(false);
  });

  it("matchShortcut is modifier-exact: mod+shift+l does NOT match mod+l", () => {
    const e = makeEvent("mod+shift+l");
    expect(matchShortcut(e, "mod+l")).toBe(false);
  });

  it("view.split.toggle shortcut is 'mod+\\'", () => {
    const cmd = getShortcutCommands().find((c) => c.id === "view.split.toggle");
    expect(cmd).toBeDefined();
    expect(cmd?.shortcut).toBe("mod+\\");
  });

  it("tab.next shortcut is 'mod+shift+]'", () => {
    const cmd = getShortcutCommands().find((c) => c.id === "tab.next");
    expect(cmd?.shortcut).toBe("mod+shift+]");
  });

  it("tab.prev shortcut is 'mod+shift+['", () => {
    const cmd = getShortcutCommands().find((c) => c.id === "tab.prev");
    expect(cmd?.shortcut).toBe("mod+shift+[");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (3) when() predicates — determinism and correctness
// ═══════════════════════════════════════════════════════════════════════════════

describe("Command when() predicates", () => {
  it("app.commandPalette has no when() — always available", () => {
    const cmd = getCommands().find((c) => c.id === "app.commandPalette");
    expect(cmd?.when).toBeUndefined();
  });

  it("ai.toggle has no when() — always available", () => {
    const cmd = getCommands().find((c) => c.id === "ai.toggle");
    expect(cmd?.when).toBeUndefined();
  });

  it("view.zen.toggle has no when() — always available", () => {
    const cmd = getCommands().find((c) => c.id === "view.zen.toggle");
    expect(cmd?.when).toBeUndefined();
  });

  it("hasDoc commands return true when path is set", () => {
    docState.path = "/tmp/test.md";
    const docCommands = [
      "file.save", "file.export.dialog", "file.export.html", "file.export.pdf",
      "file.export.docx", "file.close", "view.read", "view.edit", "view.source",
      "find.document", "find.replace", "edit.copyRichText",
    ];
    for (const id of docCommands) {
      const cmd = getCommands().find((c) => c.id === id);
      expect(cmd?.when?.(), `'${id}'.when() should be true when path is set`).toBe(true);
    }
  });

  it("hasDoc commands return false when path is null", () => {
    docState.path = null;
    const docCommands = [
      "file.save", "file.export.dialog", "file.close",
      "view.read", "view.edit", "view.source", "edit.copyRichText",
    ];
    for (const id of docCommands) {
      const cmd = getCommands().find((c) => c.id === id);
      expect(cmd?.when?.(), `'${id}'.when() should be false when path is null`).toBe(false);
    }
  });

  it("view.split.toggle is false when no doc is open", () => {
    docState.path = null;
    const cmd = getCommands().find((c) => c.id === "view.split.toggle")!;
    expect(cmd.when?.()).toBe(false);
  });

  it("view.split.toggle is false in read view (even with a doc)", () => {
    docState.path = "/tmp/test.md";
    docState.viewMode = "read";
    expect(getCommands().find((c) => c.id === "view.split.toggle")?.when?.()).toBe(false);
  });

  it("view.split.toggle is true in edit view with a doc", () => {
    docState.path = "/tmp/test.md";
    docState.viewMode = "edit";
    expect(getCommands().find((c) => c.id === "view.split.toggle")?.when?.()).toBe(true);
  });

  it("view.split.toggle is true in source view with a doc", () => {
    docState.path = "/tmp/test.md";
    docState.viewMode = "source";
    expect(getCommands().find((c) => c.id === "view.split.toggle")?.when?.()).toBe(true);
  });

  it("tab.next is false with one tab", () => {
    docState.tabs = [{ id: "t1", path: "/tmp/a.md", fileName: "a.md" }];
    expect(getCommands().find((c) => c.id === "tab.next")?.when?.()).toBe(false);
  });

  it("tab.next is true with two or more tabs", () => {
    docState.tabs = [
      { id: "t1", path: "/tmp/a.md", fileName: "a.md" },
      { id: "t2", path: "/tmp/b.md", fileName: "b.md" },
    ];
    expect(getCommands().find((c) => c.id === "tab.next")?.when?.()).toBe(true);
  });

  it("tab.prev is false with one tab", () => {
    docState.tabs = [{ id: "t1", path: "/tmp/a.md", fileName: "a.md" }];
    expect(getCommands().find((c) => c.id === "tab.prev")?.when?.()).toBe(false);
  });

  it("tab.prev is true with two or more tabs", () => {
    docState.tabs = [
      { id: "t1", path: "/a.md", fileName: "a.md" },
      { id: "t2", path: "/b.md", fileName: "b.md" },
    ];
    expect(getCommands().find((c) => c.id === "tab.prev")?.when?.()).toBe(true);
  });

  it("tab.close is false with no tabs", () => {
    docState.tabs = [];
    expect(getCommands().find((c) => c.id === "tab.close")?.when?.()).toBe(false);
  });

  it("tab.close is true with one tab", () => {
    docState.tabs = [{ id: "t1", path: "/a.md", fileName: "a.md" }];
    expect(getCommands().find((c) => c.id === "tab.close")?.when?.()).toBe(true);
  });

  it("view.outline.toggle is true when path is set", () => {
    docState.path = "/tmp/doc.md";
    expect(getCommands().find((c) => c.id === "view.outline.toggle")?.when?.()).toBe(true);
  });

  it("view.outline.toggle is false when path is null", () => {
    docState.path = null;
    expect(getCommands().find((c) => c.id === "view.outline.toggle")?.when?.()).toBe(false);
  });

  it("theme.set.paper when() is false when paper theme is active", () => {
    settingsState.theme = "paper";
    expect(getCommands().find((c) => c.id === "theme.set.paper")?.when?.()).toBe(false);
  });

  it("theme.set.sepia when() is true when paper theme is active", () => {
    settingsState.theme = "paper";
    expect(getCommands().find((c) => c.id === "theme.set.sepia")?.when?.()).toBe(true);
  });

  it("theme.set.midnight when() is true when paper theme is active", () => {
    settingsState.theme = "paper";
    expect(getCommands().find((c) => c.id === "theme.set.midnight")?.when?.()).toBe(true);
  });

  it("theme.set.midnight when() is false when midnight theme is active", () => {
    settingsState.theme = "midnight";
    expect(getCommands().find((c) => c.id === "theme.set.midnight")?.when?.()).toBe(false);
  });

  it("predicates are deterministic: same state produces same result on repeated calls", () => {
    docState.path = "/tmp/test.md";
    const cmd = getCommands().find((c) => c.id === "file.save")!;
    expect(cmd.when?.()).toBe(cmd.when?.());
  });

  it("predicates react to path changing: hasDoc flips correctly", () => {
    docState.path = "/tmp/test.md";
    const cmd = getCommands().find((c) => c.id === "file.save")!;
    expect(cmd.when?.()).toBe(true);
    docState.path = null;
    expect(cmd.when?.()).toBe(false);
    docState.path = "/tmp/other.md";
    expect(cmd.when?.()).toBe(true);
  });

  it("predicates react to viewMode changes: view.split.toggle tracks mode", () => {
    docState.path = "/tmp/test.md";
    const cmd = getCommands().find((c) => c.id === "view.split.toggle")!;
    docState.viewMode = "read";
    expect(cmd.when?.()).toBe(false);
    docState.viewMode = "edit";
    expect(cmd.when?.()).toBe(true);
    docState.viewMode = "source";
    expect(cmd.when?.()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (4) Command execution — no crash, correct delegates called
// ═══════════════════════════════════════════════════════════════════════════════

describe("Command execution — delegates fire correctly", () => {
  it("app.commandPalette.run() calls uiStore.toggleCommandPalette()", () => {
    getCommands().find((c) => c.id === "app.commandPalette")!.run();
    expect(uiState.toggleCommandPalette).toHaveBeenCalledOnce();
  });

  it("app.settings.run() calls uiStore.openSettings()", () => {
    getCommands().find((c) => c.id === "app.settings")!.run();
    expect(uiState.openSettings).toHaveBeenCalledOnce();
  });

  it("file.open.run() calls pickAndOpen()", () => {
    getCommands().find((c) => c.id === "file.open")!.run();
    expect(pickAndOpenMock).toHaveBeenCalledOnce();
  });

  it("file.save.run() calls doc.save()", () => {
    getCommands().find((c) => c.id === "file.save")!.run();
    expect(docState.save).toHaveBeenCalledOnce();
  });

  it("file.close.run() calls doc.close()", () => {
    getCommands().find((c) => c.id === "file.close")!.run();
    expect(docState.close).toHaveBeenCalledOnce();
  });

  it("file.export.dialog.run() calls uiStore.openExport()", () => {
    getCommands().find((c) => c.id === "file.export.dialog")!.run();
    expect(uiState.openExport).toHaveBeenCalledOnce();
  });

  it("view.read.run() calls doc.setViewMode('read')", () => {
    getCommands().find((c) => c.id === "view.read")!.run();
    expect(docState.setViewMode).toHaveBeenCalledWith("read");
  });

  it("view.edit.run() calls doc.setViewMode('edit')", () => {
    getCommands().find((c) => c.id === "view.edit")!.run();
    expect(docState.setViewMode).toHaveBeenCalledWith("edit");
  });

  it("view.source.run() calls doc.setViewMode('source')", () => {
    getCommands().find((c) => c.id === "view.source")!.run();
    expect(docState.setViewMode).toHaveBeenCalledWith("source");
  });

  it("view.zen.toggle.run() calls uiStore.toggleZen()", () => {
    getCommands().find((c) => c.id === "view.zen.toggle")!.run();
    expect(uiState.toggleZen).toHaveBeenCalledOnce();
  });

  it("view.search.toggle.run() calls uiStore.toggleSearch()", () => {
    getCommands().find((c) => c.id === "view.search.toggle")!.run();
    expect(uiState.toggleSearch).toHaveBeenCalledOnce();
  });

  it("view.activity.toggle.run() calls uiStore.toggleActivity()", () => {
    getCommands().find((c) => c.id === "view.activity.toggle")!.run();
    expect(uiState.toggleActivity).toHaveBeenCalledOnce();
  });

  it("view.outline.toggle.run() calls uiStore.toggleOutline()", () => {
    getCommands().find((c) => c.id === "view.outline.toggle")!.run();
    expect(uiState.toggleOutline).toHaveBeenCalledOnce();
  });

  it("ai.toggle.run() calls aiStore.toggle()", () => {
    getCommands().find((c) => c.id === "ai.toggle")!.run();
    expect(aiState.toggle).toHaveBeenCalledOnce();
  });

  it("theme.cycle.run() calls settingsStore.cycleTheme()", () => {
    getCommands().find((c) => c.id === "theme.cycle")!.run();
    expect(settingsState.cycleTheme).toHaveBeenCalledOnce();
  });

  it("theme.set.paper.run() calls settingsStore.setTheme('paper')", () => {
    getCommands().find((c) => c.id === "theme.set.paper")!.run();
    expect(settingsState.setTheme).toHaveBeenCalledWith("paper");
  });

  it("theme.set.sepia.run() calls settingsStore.setTheme('sepia')", () => {
    getCommands().find((c) => c.id === "theme.set.sepia")!.run();
    expect(settingsState.setTheme).toHaveBeenCalledWith("sepia");
  });

  it("theme.set.midnight.run() calls settingsStore.setTheme('midnight')", () => {
    getCommands().find((c) => c.id === "theme.set.midnight")!.run();
    expect(settingsState.setTheme).toHaveBeenCalledWith("midnight");
  });

  it("tab.next.run() calls doc.nextTab()", () => {
    getCommands().find((c) => c.id === "tab.next")!.run();
    expect(docState.nextTab).toHaveBeenCalledOnce();
  });

  it("tab.prev.run() calls doc.prevTab()", () => {
    getCommands().find((c) => c.id === "tab.prev")!.run();
    expect(docState.prevTab).toHaveBeenCalledOnce();
  });

  it("tab.close.run() calls doc.close()", () => {
    getCommands().find((c) => c.id === "tab.close")!.run();
    expect(docState.close).toHaveBeenCalledOnce();
  });

  it("view.split.toggle.run() calls doc.toggleSplitView()", () => {
    docState.viewMode = "edit";
    getCommands().find((c) => c.id === "view.split.toggle")!.run();
    expect(docState.toggleSplitView).toHaveBeenCalledOnce();
  });

  it("edit.copyRichText.run() calls copyDocumentAsRichText()", async () => {
    await getCommands().find((c) => c.id === "edit.copyRichText")!.run();
    expect(copyRichTextMock).toHaveBeenCalledOnce();
  });

  it("edit.insertTable.run() calls doc.setContent() when doc is open and prompt returns values", async () => {
    docState.path = "/tmp/test.md";
    vi.stubGlobal("prompt", vi.fn().mockReturnValue("3"));
    await getCommands().find((c) => c.id === "edit.insertTable")!.run();
    expect(docState.setContent).toHaveBeenCalled();
    const newContent: string = docState.setContent.mock.calls[0][0] as string;
    expect(newContent).toContain("Column 1");
  });

  it("edit.insertTable.run() does nothing when doc path is null", async () => {
    docState.path = null;
    await getCommands().find((c) => c.id === "edit.insertTable")!.run();
    expect(docState.setContent).not.toHaveBeenCalled();
  });

  it("edit.insertTable.run() does nothing when first prompt is cancelled (null)", async () => {
    docState.path = "/tmp/test.md";
    vi.stubGlobal("prompt", vi.fn().mockReturnValueOnce(null));
    await getCommands().find((c) => c.id === "edit.insertTable")!.run();
    expect(docState.setContent).not.toHaveBeenCalled();
  });

  it("edit.insertTable.run() does nothing when second prompt is cancelled (null)", async () => {
    docState.path = "/tmp/test.md";
    vi.stubGlobal(
      "prompt",
      vi.fn().mockReturnValueOnce("2").mockReturnValueOnce(null),
    );
    await getCommands().find((c) => c.id === "edit.insertTable")!.run();
    expect(docState.setContent).not.toHaveBeenCalled();
  });

  it("file.openInObsidian.run() invokes 'open_in_obsidian' with current path", async () => {
    docState.path = "/tmp/note.md";
    await getCommands().find((c) => c.id === "file.openInObsidian")!.run();
    expect(invokeMock).toHaveBeenCalledWith("open_in_obsidian", { path: "/tmp/note.md" });
  });

  it("file.openInObsidian.run() does nothing when path is null", async () => {
    docState.path = null;
    await getCommands().find((c) => c.id === "file.openInObsidian")!.run();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("file.openInObsidian.run() shows error toast and does not rethrow when invoke rejects", async () => {
    docState.path = "/tmp/note.md";
    invokeMock.mockRejectedValueOnce(new Error("Obsidian not found"));
    await expect(getCommands().find((c) => c.id === "file.openInObsidian")!.run()).resolves.not.toThrow();
    expect(toastErrorMock).toHaveBeenCalled();
  });

  it("export commands (html/pdf/docx) do not throw when called with a doc open", async () => {
    docState.path = "/tmp/test.md";
    // runExport switches to read view then calls the export fn — since .markdown-body
    // is absent in the test DOM, waitForElement mock resolves instantly and the
    // export stub is called.
    await expect(getCommands().find((c) => c.id === "file.export.html")!.run()).resolves.not.toThrow();
    await expect(getCommands().find((c) => c.id === "file.export.pdf")!.run()).resolves.not.toThrow();
    await expect(getCommands().find((c) => c.id === "file.export.docx")!.run()).resolves.not.toThrow();
  });

  it("file.export.html.run() does nothing when no doc is open", async () => {
    docState.path = null;
    await getCommands().find((c) => c.id === "file.export.html")!.run();
    expect(exportHtmlMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (5) Keyboard shortcut dispatch — bindings wire to the correct command
// ═══════════════════════════════════════════════════════════════════════════════

describe("Keyboard shortcut dispatch — bindings wire to correct commands", () => {
  /**
   * Simulate the App.tsx global keydown handler: walk shortcut commands,
   * return the id of the first that matches the event and passes its when().
   */
  function dispatch(e: KeyboardEvent): string | null {
    for (const cmd of getShortcutCommands()) {
      if (!matchShortcut(e, cmd.shortcut as string)) continue;
      if (cmd.when && !cmd.when()) continue;
      return cmd.id;
    }
    return null;
  }

  it("⌘K → app.commandPalette", () => {
    expect(dispatch(makeEvent("mod+k"))).toBe("app.commandPalette");
  });

  it("⌘E → file.export.dialog (doc open)", () => {
    docState.path = "/tmp/test.md";
    expect(dispatch(makeEvent("mod+e"))).toBe("file.export.dialog");
  });

  it("⌘E → null (no doc)", () => {
    docState.path = null;
    expect(dispatch(makeEvent("mod+e"))).toBeNull();
  });

  it("⌘1 → view.read (doc open)", () => {
    docState.path = "/tmp/test.md";
    expect(dispatch(makeEvent("mod+1"))).toBe("view.read");
  });

  it("⌘2 → view.edit (doc open)", () => {
    docState.path = "/tmp/test.md";
    expect(dispatch(makeEvent("mod+2"))).toBe("view.edit");
  });

  it("⌘3 → view.source (doc open)", () => {
    docState.path = "/tmp/test.md";
    expect(dispatch(makeEvent("mod+3"))).toBe("view.source");
  });

  it("⌘1/2/3 → null (no doc)", () => {
    docState.path = null;
    expect(dispatch(makeEvent("mod+1"))).toBeNull();
    expect(dispatch(makeEvent("mod+2"))).toBeNull();
    expect(dispatch(makeEvent("mod+3"))).toBeNull();
  });

  it("⌘B → view.activity.toggle", () => {
    expect(dispatch(makeEvent("mod+b"))).toBe("view.activity.toggle");
  });

  it("⌘⇧O → view.outline.toggle (doc open)", () => {
    docState.path = "/tmp/test.md";
    expect(dispatch(makeEvent("mod+shift+o"))).toBe("view.outline.toggle");
  });

  it("⌘⇧O → null (no doc)", () => {
    docState.path = null;
    expect(dispatch(makeEvent("mod+shift+o"))).toBeNull();
  });

  it("⌘O → file.open", () => {
    expect(dispatch(makeEvent("mod+o"))).toBe("file.open");
  });

  it("⌘S → file.save (doc open)", () => {
    docState.path = "/tmp/test.md";
    expect(dispatch(makeEvent("mod+s"))).toBe("file.save");
  });

  it("⌘S → null (no doc)", () => {
    docState.path = null;
    expect(dispatch(makeEvent("mod+s"))).toBeNull();
  });

  it("⌘L → ai.toggle", () => {
    expect(dispatch(makeEvent("mod+l"))).toBe("ai.toggle");
  });

  it("⌘⇧L → theme.cycle (not ai.toggle)", () => {
    expect(dispatch(makeEvent("mod+shift+l"))).toBe("theme.cycle");
  });

  it("⌘, → app.settings", () => {
    expect(dispatch(makeEvent("mod+,"))).toBe("app.settings");
  });

  it("⌘F → find.document (doc open)", () => {
    docState.path = "/tmp/test.md";
    expect(dispatch(makeEvent("mod+f"))).toBe("find.document");
  });

  it("⌘⇧F → view.search.toggle", () => {
    expect(dispatch(makeEvent("mod+shift+f"))).toBe("view.search.toggle");
  });

  it("⌘⇧Z → view.zen.toggle", () => {
    expect(dispatch(makeEvent("mod+shift+z"))).toBe("view.zen.toggle");
  });

  it("⌘W → tab.close (one tab open)", () => {
    docState.tabs = [{ id: "t1", path: "/a.md", fileName: "a.md" }];
    expect(dispatch(makeEvent("mod+w"))).toBe("tab.close");
  });

  it("⌘W → null (no tabs)", () => {
    docState.tabs = [];
    expect(dispatch(makeEvent("mod+w"))).toBeNull();
  });

  it("⌘⇧] (key='}') → tab.next (two tabs)", () => {
    docState.tabs = [
      { id: "t1", path: "/a.md", fileName: "a.md" },
      { id: "t2", path: "/b.md", fileName: "b.md" },
    ];
    // Browser reports shifted-bracket as '}'; SHIFTED_TO_BASE maps it back to ']'
    // IS_MAC=false in happy-dom so mod=ctrlKey
    const e = { ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: "}" } as unknown as KeyboardEvent;
    expect(dispatch(e)).toBe("tab.next");
  });

  it("⌘⇧[ (key='{') → tab.prev (two tabs)", () => {
    docState.tabs = [
      { id: "t1", path: "/a.md", fileName: "a.md" },
      { id: "t2", path: "/b.md", fileName: "b.md" },
    ];
    const e = { ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: "{" } as unknown as KeyboardEvent;
    expect(dispatch(e)).toBe("tab.prev");
  });

  it("⌘⇧C → edit.copyRichText (doc open)", () => {
    docState.path = "/tmp/test.md";
    expect(dispatch(makeEvent("mod+shift+c"))).toBe("edit.copyRichText");
  });

  it("⌘⇧T → edit.insertTable (doc open)", () => {
    docState.path = "/tmp/test.md";
    expect(dispatch(makeEvent("mod+shift+t"))).toBe("edit.insertTable");
  });

  it("⌘⇧T → null (no doc)", () => {
    docState.path = null;
    expect(dispatch(makeEvent("mod+shift+t"))).toBeNull();
  });

  it("unregistered shortcut ⌘Z → null", () => {
    expect(dispatch(makeEvent("mod+z"))).toBeNull();
  });

  it("no match when event has no mod and no key registers", () => {
    // Neither ctrlKey nor metaKey held → no shortcut should fire
    const e = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: "k" } as unknown as KeyboardEvent;
    expect(dispatch(e)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// keymap.ts — matchShortcut and formatShortcut unit tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("keymap — matchShortcut", () => {
  it("matches a single-modifier shortcut exactly", () => {
    expect(matchShortcut(makeEvent("mod+k"), "mod+k")).toBe(true);
  });

  it("does not match when the mod key is absent", () => {
    // IS_MAC=false in happy-dom → mod=ctrlKey; neither ctrl nor meta held here
    const e = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: "k" } as unknown as KeyboardEvent;
    expect(matchShortcut(e, "mod+k")).toBe(false);
  });

  it("does not match when shift is held but shortcut does not require it", () => {
    const e = makeEvent("mod+shift+k");
    expect(matchShortcut(e, "mod+k")).toBe(false);
  });

  it("matches mod+shift+l correctly", () => {
    expect(matchShortcut(makeEvent("mod+shift+l"), "mod+shift+l")).toBe(true);
  });

  it("matches mod+alt+f correctly", () => {
    expect(matchShortcut(makeEvent("mod+alt+f"), "mod+alt+f")).toBe(true);
  });

  it("does not match mod+alt+f when alt is not held", () => {
    expect(matchShortcut(makeEvent("mod+f"), "mod+alt+f")).toBe(false);
  });

  it("key comparison is case-insensitive (event.key='K' matches 'mod+k')", () => {
    // IS_MAC=false → mod=ctrlKey
    const e = { ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: "K" } as unknown as KeyboardEvent;
    expect(matchShortcut(e, "mod+k")).toBe(true);
  });

  it("SHIFTED_TO_BASE: key='}' matches shortcut 'mod+shift+]'", () => {
    const e = { ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: "}" } as unknown as KeyboardEvent;
    expect(matchShortcut(e, "mod+shift+]")).toBe(true);
  });

  it("SHIFTED_TO_BASE: key='{' matches shortcut 'mod+shift+['", () => {
    const e = { ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: "{" } as unknown as KeyboardEvent;
    expect(matchShortcut(e, "mod+shift+[")).toBe(true);
  });

  it("returns false for a completely unrelated event", () => {
    const e = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: "a" } as unknown as KeyboardEvent;
    expect(matchShortcut(e, "mod+k")).toBe(false);
  });
});

describe("keymap — formatShortcut", () => {
  it("returns a non-empty string for mod+k", () => {
    const label = formatShortcut("mod+k");
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
  });

  it("output for mod+shift+l includes a shift indicator", () => {
    const label = formatShortcut("mod+shift+l");
    expect(label.includes("⇧") || label.toLowerCase().includes("shift")).toBe(true);
  });

  it("output for mod+k contains the letter K", () => {
    const label = formatShortcut("mod+k");
    expect(label.toLowerCase()).toContain("k");
  });

  it("handles the comma key without crashing and includes ','", () => {
    expect(formatShortcut("mod+,")).toContain(",");
  });

  it("is deterministic — same input yields same output on repeated calls", () => {
    expect(formatShortcut("mod+shift+o")).toBe(formatShortcut("mod+shift+o"));
  });

  it("does not throw for any shortcut registered in the command set", () => {
    for (const cmd of getShortcutCommands()) {
      expect(() => formatShortcut(cmd.shortcut as string)).not.toThrow();
    }
  });
});
