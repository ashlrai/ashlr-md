import { beforeEach, describe, expect, it } from "vitest";
import { getStoredState } from "../test-setup";
import {
  isDefaultPromptSnoozed,
  NEVER_ASK_DEFAULT,
  NO_TEMPLATE_ID,
  useSettingsStore,
} from "./settingsStore";

// ─── Export template registry ─────────────────────────────────────────────────

describe("settingsStore — export template registry", () => {
  // Reset the store before each test so tests are independent.
  beforeEach(() => {
    useSettingsStore.setState({
      userTemplates: [],
      activeTemplateId: NO_TEMPLATE_ID,
    });
  });

  it("starts with an empty user template list", () => {
    const { userTemplates } = useSettingsStore.getState();
    expect(userTemplates).toEqual([]);
  });

  it("starts with NO_TEMPLATE_ID as the active template", () => {
    const { activeTemplateId } = useSettingsStore.getState();
    expect(activeTemplateId).toBe(NO_TEMPLATE_ID);
  });

  it("addUserTemplate adds a template and returns its id", () => {
    const { addUserTemplate } = useSettingsStore.getState();
    const id = addUserTemplate({ name: "My Style", css: "body{color:red}" });
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^user-/);
    const { userTemplates } = useSettingsStore.getState();
    expect(userTemplates).toHaveLength(1);
    expect(userTemplates[0].name).toBe("My Style");
    expect(userTemplates[0].css).toBe("body{color:red}");
    expect(userTemplates[0].builtin).toBe(false);
  });

  it("addUserTemplate preserves existing templates", () => {
    const { addUserTemplate } = useSettingsStore.getState();
    addUserTemplate({ name: "First", css: "body{}" });
    addUserTemplate({ name: "Second", css: "p{}" });
    const { userTemplates } = useSettingsStore.getState();
    expect(userTemplates).toHaveLength(2);
  });

  it("updateUserTemplate patches an existing template by id", () => {
    const { addUserTemplate, updateUserTemplate } = useSettingsStore.getState();
    const id = addUserTemplate({ name: "Old Name", css: "body{}" });
    updateUserTemplate(id, { name: "New Name", css: "h1{}" });
    const { userTemplates } = useSettingsStore.getState();
    const tpl = userTemplates.find((t) => t.id === id);
    expect(tpl?.name).toBe("New Name");
    expect(tpl?.css).toBe("h1{}");
  });

  it("updateUserTemplate is a no-op for an unknown id", () => {
    const { addUserTemplate, updateUserTemplate } = useSettingsStore.getState();
    addUserTemplate({ name: "Existing", css: "body{}" });
    updateUserTemplate("ghost-id", { name: "Ghost" });
    const { userTemplates } = useSettingsStore.getState();
    expect(userTemplates).toHaveLength(1);
    expect(userTemplates[0].name).toBe("Existing");
  });

  it("removeUserTemplate removes the template by id", () => {
    const { addUserTemplate, removeUserTemplate } = useSettingsStore.getState();
    const id = addUserTemplate({ name: "Temp", css: "body{}" });
    removeUserTemplate(id);
    const { userTemplates } = useSettingsStore.getState();
    expect(userTemplates).toHaveLength(0);
  });

  it("removeUserTemplate resets activeTemplateId to NO_TEMPLATE_ID when active template is removed", () => {
    const { addUserTemplate, removeUserTemplate, setActiveTemplateId } =
      useSettingsStore.getState();
    const id = addUserTemplate({ name: "Active", css: "body{}" });
    setActiveTemplateId(id);
    expect(useSettingsStore.getState().activeTemplateId).toBe(id);
    removeUserTemplate(id);
    expect(useSettingsStore.getState().activeTemplateId).toBe(NO_TEMPLATE_ID);
  });

  it("removeUserTemplate preserves activeTemplateId when a different template is removed", () => {
    const { addUserTemplate, removeUserTemplate, setActiveTemplateId } =
      useSettingsStore.getState();
    const id1 = addUserTemplate({ name: "One", css: "body{}" });
    const id2 = addUserTemplate({ name: "Two", css: "p{}" });
    setActiveTemplateId(id1);
    removeUserTemplate(id2);
    expect(useSettingsStore.getState().activeTemplateId).toBe(id1);
  });

  it("setActiveTemplateId updates the active template", () => {
    const { addUserTemplate, setActiveTemplateId } = useSettingsStore.getState();
    const id = addUserTemplate({ name: "New Active", css: "body{}" });
    setActiveTemplateId(id);
    expect(useSettingsStore.getState().activeTemplateId).toBe(id);
  });

  it("setActiveTemplateId accepts NO_TEMPLATE_ID to clear the selection", () => {
    const { addUserTemplate, setActiveTemplateId } = useSettingsStore.getState();
    const id = addUserTemplate({ name: "T", css: "" });
    setActiveTemplateId(id);
    setActiveTemplateId(NO_TEMPLATE_ID);
    expect(useSettingsStore.getState().activeTemplateId).toBe(NO_TEMPLATE_ID);
  });

  it("setActiveTemplateId accepts a built-in template id", () => {
    const { setActiveTemplateId } = useSettingsStore.getState();
    setActiveTemplateId("builtin-github");
    expect(useSettingsStore.getState().activeTemplateId).toBe("builtin-github");
  });

  it("setUserTemplates replaces the entire user template list", () => {
    const { addUserTemplate, setUserTemplates } = useSettingsStore.getState();
    addUserTemplate({ name: "Old", css: "body{}" });
    setUserTemplates([{ id: "manual-id", name: "Manual", css: "p{}", builtin: false }]);
    const { userTemplates } = useSettingsStore.getState();
    expect(userTemplates).toHaveLength(1);
    expect(userTemplates[0].id).toBe("manual-id");
  });

  it("each addUserTemplate call generates a distinct id", () => {
    const { addUserTemplate } = useSettingsStore.getState();
    const ids = Array.from({ length: 10 }, (_, i) =>
      addUserTemplate({ name: `T${i}`, css: "" }),
    );
    expect(new Set(ids).size).toBe(10);
  });

  it("addUserTemplate writes userTemplates to localStorage via persist middleware", () => {
    const { addUserTemplate } = useSettingsStore.getState();
    addUserTemplate({ name: "Persisted", css: "h1{color:blue}" });
    const blob = getStoredState<{ userTemplates: { name: string; css: string }[] }>(
      "mdopener-settings",
    );
    expect(blob).not.toBeNull();
    expect(blob!.state.userTemplates).toHaveLength(1);
    expect(blob!.state.userTemplates[0].name).toBe("Persisted");
  });
});

// ─── isDefaultPromptSnoozed ───────────────────────────────────────────────────

describe("isDefaultPromptSnoozed", () => {
  it("treats null as not snoozed (prompt may show)", () => {
    expect(isDefaultPromptSnoozed(null)).toBe(false);
  });

  it("treats a future timestamp as snoozed", () => {
    expect(isDefaultPromptSnoozed(Date.now() + 60_000)).toBe(true);
  });

  it("treats a past timestamp as expired (prompt may show again)", () => {
    expect(isDefaultPromptSnoozed(Date.now() - 60_000)).toBe(false);
  });

  it("treats the never-ask sentinel as permanently snoozed", () => {
    expect(isDefaultPromptSnoozed(NEVER_ASK_DEFAULT)).toBe(true);
  });

  it("keeps the never-ask sentinel finite so it survives JSON serialization", () => {
    expect(Number.isFinite(NEVER_ASK_DEFAULT)).toBe(true);
    expect(JSON.parse(JSON.stringify(NEVER_ASK_DEFAULT))).toBe(NEVER_ASK_DEFAULT);
  });
});

// ─── autoEmbedIndex (opt-in semantic re-index) ────────────────────────────────

describe("settingsStore — autoEmbedIndex", () => {
  const migrate = () => {
    const fn = useSettingsStore.persist.getOptions().migrate;
    if (!fn) throw new Error("settings store has no migrate");
    return fn;
  };

  it("defaults to false for a new install", () => {
    expect(useSettingsStore.getInitialState().autoEmbedIndex).toBe(false);
  });

  it("setAutoEmbedIndex flips the flag", () => {
    useSettingsStore.getState().setAutoEmbedIndex(true);
    expect(useSettingsStore.getState().autoEmbedIndex).toBe(true);
    useSettingsStore.getState().setAutoEmbedIndex(false);
    expect(useSettingsStore.getState().autoEmbedIndex).toBe(false);
  });

  it("v7 to v8 migration keeps an existing install on", async () => {
    const out = (await migrate()({ theme: "light" }, 7)) as { autoEmbedIndex: boolean };
    expect(out.autoEmbedIndex).toBe(true);
  });

  it("migration from older versions also keeps existing installs on", async () => {
    const out = (await migrate()({}, 3)) as { autoEmbedIndex: boolean };
    expect(out.autoEmbedIndex).toBe(true);
  });

  it("migration never overrides an explicit choice", async () => {
    const out = (await migrate()({ autoEmbedIndex: false }, 7)) as {
      autoEmbedIndex: boolean;
    };
    expect(out.autoEmbedIndex).toBe(false);
  });
});

// ─── Loading the persisted settings ───────────────────────────────────────────

describe("settingsStore — loading a damaged, partial or newer settings file", () => {
  const load = async (raw: string) => {
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    localStorage.setItem("mdopener-settings", raw);
    await useSettingsStore.persist.rehydrate();
    return useSettingsStore.getState();
  };

  it("keeps the defaults for values of the wrong type", async () => {
    // The default merge took them as they were: a null linterConfig threw
    // in the linter settings, a string font size reached the CSS.
    const s = await load(
      JSON.stringify({
        state: {
          theme: "neon",
          fontSize: "huge",
          contentWidth: 5000,
          loadRemoteImages: null,
          linterConfig: null,
          userTemplates: { id: "x" },
          customSnippets: [{ label: "ok", template: "t" }, { label: 3 }],
          disabledProfileIds: ["slack-html", "gone", 7],
          setTheme: "not a function",
        },
        version: 8,
      }),
    );
    expect(s.theme).toBe("paper");
    expect(s.fontSize).toBe(17);
    expect(s.contentWidth).toBe(960);
    expect(s.loadRemoteImages).toBe(true);
    expect(s.linterConfig).toEqual({ disabledRules: [] });
    expect(s.userTemplates).toEqual([]);
    expect(s.customSnippets).toEqual([{ label: "ok", template: "t" }]);
    expect(s.disabledProfileIds).toEqual(["slack-html"]);
    expect(typeof s.setTheme).toBe("function");
    s.toggleLinterRule("MD001");
    expect(useSettingsStore.getState().linterConfig.disabledRules).toEqual(["MD001"]);
  });

  it("gives a setting missing from the file its default, and keeps a newer version's keys", async () => {
    const s = await load(
      JSON.stringify({
        state: { theme: "sepia", fromTheFuture: { a: 1 } },
        version: 9,
      }),
    );
    expect(s.theme).toBe("sepia");
    expect(s.loadRemoteImages).toBe(true);
    expect(s.epubEnabled).toBe(true);
    s.setFontSize(20);
    const stored = getStoredState<Record<string, unknown>>("mdopener-settings");
    expect(stored?.state.fromTheFuture).toEqual({ a: 1 });
    expect(stored?.state.fontSize).toBe(20);
  });

  it("starts from the defaults when the file is not JSON", async () => {
    const s = await load("{not json");
    expect(s.theme).toBe("paper");
    expect(s.loadRemoteImages).toBe(true);
  });

  it("keeps a newer version's version number when it saves", async () => {
    // Written back as 8, the newer app re-ran its migrations on the next run.
    const s = await load(
      JSON.stringify({ state: { theme: "sepia", fromTheFuture: 1 }, version: 12 }),
    );
    s.setFontSize(19);
    const stored = getStoredState<Record<string, unknown>>("mdopener-settings");
    expect(stored?.version).toBe(12);
    expect(stored?.state.fromTheFuture).toBe(1);
    expect(stored?.state.fontSize).toBe(19);
  });

  it("writes its own version over an older file's", async () => {
    const s = await load(JSON.stringify({ state: { theme: "sepia" }, version: 7 }));
    s.setFontSize(18);
    expect(getStoredState("mdopener-settings")?.version).toBe(8);
  });
});
