import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("katex/dist/katex.min.css?raw", () => ({ default: "/* katex */" }));
vi.mock("../styles/markdown.css?raw", () => ({ default: "/* markdown */" }));
vi.mock("../styles/themes.css?raw", () => ({ default: "/* themes */" }));
const settings = vi.hoisted(() => ({ activeTemplateId: "none", userTemplates: [] }));
vi.mock("../store/settingsStore", () => ({
  useSettingsStore: { getState: () => settings },
  NO_TEMPLATE_ID: "none",
}));

import {
  buildStandaloneHtml,
  buildStandaloneHtmlWithActiveTemplate,
  exportPdf,
} from "./export";
import { findTemplate, validateTemplateCss } from "./exportTemplates";
import { ACADEMIC_THEME_CSS, EDITORIAL_THEME_CSS } from "./exportThemes";

beforeEach(() => {
  document.body.innerHTML =
    '<div class="markdown-body"><h1>Title</h1><p>Offline export.</p></div>';
  delete document.documentElement.dataset.theme;
  settings.activeTemplateId = "none";
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
it("keeps the default export byte identical to the pre-theme fixture", () => {
  const html = buildStandaloneHtml("Offline");
  expect(createHash("sha256").update(html).digest("hex")).toBe(
    "01874deabf8cfd088308305c200952f4c66f7ac48ee12feaf2a26244cadc36c3",
  );
  expect(buildStandaloneHtmlWithActiveTemplate("Offline")).toBe(html);
});

for (const [id, css] of [
  ["builtin-academic", ACADEMIC_THEME_CSS],
  ["builtin-editorial", EDITORIAL_THEME_CSS],
]) {
  it(`${id} is selectable and changes HTML with offline CSS`, () => {
    const baseline = buildStandaloneHtmlWithActiveTemplate("Offline");
    settings.activeTemplateId = id;
    const html = buildStandaloneHtmlWithActiveTemplate("Offline");
    expect(findTemplate(id, [])).toMatchObject({ css, builtin: true });
    expect(html).not.toBe(baseline);
    expect(html).toContain(css);
    expect(html).toContain(`data-export-template="${id}"`);
    expect(html.indexOf(css)).toBeGreaterThan(html.indexOf("/* markdown */"));
    expect(css).not.toMatch(/@import|@font-face|url\s*\(/i);
    expect(validateTemplateCss(css)).toBeNull();
    settings.activeTemplateId = "none";
    expect(buildStandaloneHtmlWithActiveTemplate("Offline")).toBe(baseline);
  });

  it(`${id} reaches the PDF print document`, async () => {
    settings.activeTemplateId = id;
    const create = document.createElement.bind(document);
    const write = vi.fn();
    const print = vi.fn();
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = create(tag);
      if (tag === "iframe") {
        Object.defineProperty(element, "contentDocument", {
          value: {
            open: vi.fn(),
            write,
            close: () => {
              element.dispatchEvent(new Event("load"));
              element.onload = null;
            },
          },
        });
        Object.defineProperty(element, "contentWindow", { value: { print } });
      }
      return element;
    });
    await exportPdf("Offline");
    expect(write).toHaveBeenCalledWith(
      buildStandaloneHtmlWithActiveTemplate("Offline"),
    );
    expect(write.mock.calls[0][0]).toContain(css);
    expect(print).toHaveBeenCalledOnce();
  });
}
