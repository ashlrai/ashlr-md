import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSettingsStore } from "../store/settingsStore";
import { buildStandaloneHtmlWithActiveTemplate } from "./export";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

beforeEach(() => {
  document.body.innerHTML =
    '<div class="markdown-body"><h1>Title</h1><p>Offline &amp; unchanged.</p></div>';
  useSettingsStore.setState({ activeTemplateId: "none", userTemplates: [] });
});
afterEach(() => {
  document.body.innerHTML = "";
  delete document.documentElement.dataset.theme;
  useSettingsStore.setState({ activeTemplateId: "none", userTemplates: [] });
  vi.restoreAllMocks();
});

it("preserves pre-export-theme default HTML bytes for each reader theme", () => {
  // Baseline captured on 30a811a, before the export themes were introduced.
  // This is also the HTML source used for PDF printing.
  const html = ["paper", "sepia", "midnight"].map((theme) => {
    document.documentElement.dataset.theme = theme;
    return buildStandaloneHtmlWithActiveTemplate("Title");
  });
  const hashes = html.map((output) =>
    createHash("sha256").update(output).digest("hex"),
  );
  expect(hashes).toMatchInlineSnapshot(`
    [
      "48dd43de900719cb3347c2e33bede54254e4e3fcceb08bd8e467fae52a90a4c7",
      "283515e9d62ed544a548cb8125097e8a14622978c159039a7a6a68eaa3e76e57",
      "22d80b5beba7f0ad6406ee763b6785255090cc06862b182a099c26f254a7ccde",
    ]
  `);
  // The reader theme is deliberately embedded, so the three exports are not
  // identical to each other: only their data-theme attribute should differ.
  expect(html[1].replace('data-theme="sepia"', 'data-theme="paper"')).toBe(html[0]);
  expect(html[2].replace('data-theme="midnight"', 'data-theme="paper"')).toBe(html[0]);
});
