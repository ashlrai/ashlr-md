import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSettingsStore } from "../store/settingsStore";
import { buildStandaloneHtmlWithActiveTemplate } from "./export";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

beforeEach(() => {
  document.body.innerHTML = '<div class="markdown-body"><h1>Title</h1><p>Offline &amp; unchanged.</p></div>';
  useSettingsStore.setState({ activeTemplateId: "none", userTemplates: [] });
});
afterEach(() => {
  document.body.innerHTML = "";
  delete document.documentElement.dataset.theme;
  useSettingsStore.setState({ activeTemplateId: "none", userTemplates: [] });
  vi.restoreAllMocks();
});

it("keeps default HTML bytes identical for every reader theme", () => {
  // Captured before introducing the export themes; covers the PDF source too.
  const hashes = ["paper", "sepia", "midnight"].map((theme) => {
    document.documentElement.dataset.theme = theme;
    return createHash("sha256").update(buildStandaloneHtmlWithActiveTemplate("Title")).digest("hex");
  });
  expect(hashes).toMatchInlineSnapshot();
});
