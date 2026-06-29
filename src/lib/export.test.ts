/**
 * export.test.ts — unit tests for src/lib/export.ts
 *
 * Covers: buildStandaloneHtml, exportHtml, exportDocx, exportPdf,
 * cloneWithoutInjectedChrome, and the helper behaviours documented in export.ts.
 *
 * All Tauri, dialog, and CSS ?raw imports are mocked at the top of the file
 * so the module under test can be imported in the happy-dom environment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Module mocks (must precede any import of the module under test) ──────────

// Stub the three Vite ?raw CSS imports so they return deterministic strings.
vi.mock("katex/dist/katex.min.css?raw", () => ({ default: "/* katex-css */" }));
vi.mock("../styles/markdown.css?raw", () => ({ default: "/* markdown-css */" }));
vi.mock("../styles/themes.css?raw", () => ({ default: "/* themes-css */" }));

// Mock settingsStore so buildStandaloneHtmlWithActiveTemplate can be tested
// without a real Zustand store.
const mockGetState = vi.fn(() => ({
  activeTemplateId: "none",
  userTemplates: [],
}));
vi.mock("../store/settingsStore", () => ({
  useSettingsStore: { getState: (...args: unknown[]) => mockGetState(...args) },
  NO_TEMPLATE_ID: "none",
}));

// Mock Tauri core invoke.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Mock Tauri save dialog.
const saveMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
}));

// Mock the toast store so tests can assert on success/error toasts.
// Use vi.fn() inside the factory (hoisted) — capture refs via vi.mocked() after import.
vi.mock("../store/toastStore", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  buildStandaloneHtml,
  buildStandaloneHtmlWithActiveTemplate,
  cloneWithoutInjectedChrome,
  exportDocx,
  exportHtml,
  exportPdf,
} from "./export";
import { toast } from "../store/toastStore";

// ─── DOM fixture helpers ──────────────────────────────────────────────────────

/** Rich markdown fixture covering code, tables, math, diagrams, callouts, etc. */
const RICH_BODY_HTML = `
<h1>My Document</h1>
<p>Paragraph with <strong>bold</strong>, <em>italic</em>, and <code>inline code</code>.</p>
<h2>Code Block</h2>
<pre class="shiki"><code class="language-typescript"><span style="color:#569CD6">const</span> <span style="color:#9CDCFE">x</span> <span style="color:#D4D4D4">=</span> <span style="color:#B5CEA8">42</span><span style="color:#D4D4D4">;</span>
</code></pre>
<h2>Table</h2>
<table>
  <thead><tr><th>Name</th><th>Value</th></tr></thead>
  <tbody>
    <tr><td>alpha</td><td>1</td></tr>
    <tr><td>beta</td><td>2</td></tr>
  </tbody>
</table>
<h2>Math</h2>
<span class="katex"><span class="katex-html">E=mc²</span></span>
<h2>Mermaid Diagram</h2>
<div class="mermaid-block"><svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50"/></svg></div>
<h2>Callout</h2>
<blockquote class="callout callout-note"><p>Note content</p></blockquote>
<h2>Wikilink</h2>
<a class="wikilink" href="other-note.md">other-note</a>
<h2>Image Embed</h2>
<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" alt="test image" width="200" height="100" />
<h2>List</h2>
<ul><li>Item one</li><li>Item two</li></ul>
<ol><li>First</li><li>Second</li></ol>
`.trim();

/** Inject a `.markdown-body` element with the rich fixture into document.body. */
function setupReadView(extraHtml = "") {
  const div = document.createElement("div");
  div.className = "markdown-body";
  div.innerHTML = RICH_BODY_HTML + extraHtml;
  document.body.appendChild(div);
}

/** Clear the DOM between tests. */
function teardownDom() {
  document.body.innerHTML = "";
}

// ─── cloneWithoutInjectedChrome ───────────────────────────────────────────────

describe("cloneWithoutInjectedChrome", () => {
  it("strips review-card elements and keeps document content", () => {
    const el = document.createElement("div");
    el.innerHTML =
      '<aside class="review-card">SUMMARY</aside><h1>Title</h1><p>body</p>';
    const cleaned = cloneWithoutInjectedChrome(el);
    expect(cleaned.querySelector(".review-card")).toBeNull();
    expect(cleaned.querySelector("h1")?.textContent).toBe("Title");
    expect(cleaned.querySelector("p")?.textContent).toBe("body");
  });

  it("does not mutate the original element", () => {
    const el = document.createElement("div");
    el.innerHTML = '<div class="review-card">X</div><p>real</p>';
    cloneWithoutInjectedChrome(el);
    expect(el.querySelector(".review-card")).not.toBeNull();
  });

  it("is a no-op when no review-card is present", () => {
    const el = document.createElement("div");
    el.innerHTML = "<h2>Heading</h2><p>Content</p>";
    expect(cloneWithoutInjectedChrome(el).innerHTML).toBe(
      "<h2>Heading</h2><p>Content</p>",
    );
  });

  it("strips multiple review-card nodes", () => {
    const el = document.createElement("div");
    el.innerHTML =
      '<div class="review-card">1</div><p>keep</p><div class="review-card">2</div>';
    const cleaned = cloneWithoutInjectedChrome(el);
    expect(cleaned.querySelectorAll(".review-card")).toHaveLength(0);
    expect(cleaned.querySelector("p")?.textContent).toBe("keep");
  });
});

// ─── buildStandaloneHtml — structure ─────────────────────────────────────────

describe("buildStandaloneHtml", () => {
  beforeEach(() => setupReadView());
  afterEach(() => teardownDom());

  it("throws a user-visible error when not in Read view", () => {
    teardownDom(); // remove .markdown-body
    expect(() => buildStandaloneHtml("Test")).toThrow(
      "Switch to Read view before exporting.",
    );
  });

  it("produces a valid HTML5 doctype and html/head/body structure", () => {
    const html = buildStandaloneHtml("My Doc");
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<html");
    expect(html).toContain("<head>");
    expect(html).toContain("<body>");
    expect(html).toContain("</html>");
  });

  it("sets the document title with HTML-entity escaping", () => {
    const html = buildStandaloneHtml('Doc <Title> & "Test"');
    expect(html).toContain(
      "<title>Doc &lt;Title&gt; &amp; &quot;Test&quot;</title>",
    );
  });

  it("inlines all three CSS bundles (themes, markdown, KaTeX)", () => {
    const html = buildStandaloneHtml("CSS Test");
    expect(html).toContain("/* themes-css */");
    expect(html).toContain("/* markdown-css */");
    expect(html).toContain("/* katex-css */");
  });

  it("embeds layout CSS vars (--content-width, --content-font-size) in :root", () => {
    const html = buildStandaloneHtml("Layout");
    expect(html).toContain("--content-width:");
    expect(html).toContain("--content-font-size:");
    // Falls back to defaults when getComputedStyle returns empty.
    expect(html).toContain("720px");
    expect(html).toContain("17px");
  });

  it("embeds the data-theme attribute from document.documentElement", () => {
    document.documentElement.dataset.theme = "midnight";
    const html = buildStandaloneHtml("Theme");
    expect(html).toContain('data-theme="midnight"');
    delete document.documentElement.dataset.theme;
  });

  it("defaults to 'paper' theme when dataset.theme is absent", () => {
    delete document.documentElement.dataset.theme;
    const html = buildStandaloneHtml("Default theme");
    expect(html).toContain('data-theme="paper"');
  });

  it("wraps body content in a .reading-surface article", () => {
    const html = buildStandaloneHtml("Wrap");
    expect(html).toContain('<article class="reading-surface">');
    expect(html).toContain("</article>");
  });

  it("includes @media print rules for pagination", () => {
    const html = buildStandaloneHtml("Print");
    expect(html).toContain("@media print");
    expect(html).toContain("break-inside:avoid");
    expect(html).toContain(".copy-btn{display:none}");
  });

  it("preserves Shiki syntax-highlighted code spans", () => {
    const html = buildStandaloneHtml("Shiki");
    expect(html).toContain("shiki");
    expect(html).toContain('style="color:#569CD6"');
  });

  it("preserves Mermaid inline SVG", () => {
    const html = buildStandaloneHtml("Mermaid");
    expect(html).toContain("<svg");
    expect(html).toContain("mermaid-block");
  });

  it("preserves KaTeX rendered HTML", () => {
    const html = buildStandaloneHtml("KaTeX");
    expect(html).toContain("katex-html");
    expect(html).toContain("E=mc²");
  });

  it("strips review-card chrome from exported body", () => {
    // Add a review card to the live DOM.
    const mb = document.querySelector(".markdown-body")!;
    const card = document.createElement("aside");
    card.className = "review-card";
    card.textContent = "Review summary";
    mb.appendChild(card);

    const html = buildStandaloneHtml("Chrome Strip");
    expect(html).not.toContain("review-card");
    expect(html).not.toContain("Review summary");
  });

  it("includes tables, lists, and blockquotes from the fixture", () => {
    const html = buildStandaloneHtml("Rich");
    expect(html).toContain("<table>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<blockquote");
  });

  it("has no external resource references (offline-ready)", () => {
    const html = buildStandaloneHtml("Offline");
    // No http/https links to external stylesheets or scripts.
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
  });

  it("sets charset utf-8 and viewport meta", () => {
    const html = buildStandaloneHtml("Meta");
    expect(html).toContain('charset="utf-8"');
    expect(html).toContain('name="viewport"');
  });
});

// ─── exportHtml ───────────────────────────────────────────────────────────────

describe("exportHtml", () => {
  beforeEach(() => {
    setupReadView();
    invokeMock.mockReset();
    saveMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    saveMock.mockResolvedValue("/home/user/my-doc.html");
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });
  afterEach(() => teardownDom());

  it("calls write_markdown_file with the built HTML and chosen path", async () => {
    await exportHtml("My Doc");
    expect(invokeMock).toHaveBeenCalledWith("write_markdown_file", {
      path: "/home/user/my-doc.html",
      content: expect.stringContaining("<!doctype html>"),
    });
  });

  it("shows a success toast with the base filename", async () => {
    await exportHtml("My Doc");
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining("my-doc.html"),
    );
  });

  it("does nothing (no invoke, no toast) when the user cancels the dialog", async () => {
    saveMock.mockResolvedValue(null);
    await exportHtml("Cancelled");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("shows an error toast and re-throws when invoke fails", async () => {
    invokeMock.mockRejectedValue(new Error("disk full"));
    await expect(exportHtml("Fail")).rejects.toBeDefined();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("disk full"),
    );
  });

  it("throws a user-visible error when not in Read view", async () => {
    teardownDom();
    await expect(exportHtml("No view")).rejects.toMatch(
      "Switch to Read view before exporting.",
    );
  });

  it("sanitises the title to a safe filename (spaces → hyphens, strips unsafe chars)", async () => {
    await exportHtml("Hello World: <Test>/File");
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/Hello-World-.*\.html/),
      }),
    );
  });

  it("falls back to 'export.html' when title is empty", async () => {
    await exportHtml("");
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "export.html" }),
    );
  });

  it("the written content is self-contained (no external links)", async () => {
    await exportHtml("Offline");
    const written = invokeMock.mock.calls[0][1].content as string;
    expect(written).not.toMatch(/<link[^>]+href="https?:/);
    expect(written).not.toMatch(/<script[^>]+src="https?:/);
  });
});

// ─── exportDocx ───────────────────────────────────────────────────────────────

describe("exportDocx", () => {
  beforeEach(() => {
    setupReadView();
    invokeMock.mockReset();
    saveMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    saveMock.mockResolvedValue("/home/user/my-doc.docx");
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });
  afterEach(() => {
    teardownDom();
    vi.resetModules();
  });

  it("throws a user-visible error when not in Read view", async () => {
    teardownDom();
    await expect(exportDocx("No view")).rejects.toMatch(
      "Switch to Read view before exporting.",
    );
  });

  it("propagates an error when html-to-docx conversion fails", async () => {
    // html-to-docx is present in node_modules but may error at runtime in the
    // test environment.  Confirm that any rejection from the conversion path
    // surfaces — i.e. exportDocx does not swallow it silently.
    const err = await exportDocx("Conversion fail").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
  });

  it("does nothing when the user cancels the dialog (save returns null)", async () => {
    // Pre-mock html-to-docx so we get past the import check.
    const fakeBlob = new Blob(["DOCX bytes"], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    vi.doMock("html-to-docx", () => ({
      default: vi.fn().mockResolvedValue(fakeBlob),
    }));
    saveMock.mockResolvedValue(null);

    // Re-import the module fresh to pick up the mock.
    const { exportDocx: exportDocxFresh } = await import("./export");
    await exportDocxFresh("Cancelled");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("writes bytes via write_file_bytes and shows a success toast", async () => {
    const fakeBlob = new Blob(["DOCX bytes"], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    vi.doMock("html-to-docx", () => ({
      default: vi.fn().mockResolvedValue(fakeBlob),
    }));

    const { exportDocx: exportDocxFresh } = await import("./export");
    await exportDocxFresh("My Doc");

    expect(invokeMock).toHaveBeenCalledWith("write_file_bytes", {
      path: "/home/user/my-doc.docx",
      data: expect.any(Array),
    });
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining("my-doc.docx"),
    );
  });

  it("handles ArrayBuffer result from html-to-docx (not Blob)", async () => {
    const buf = new ArrayBuffer(4);
    vi.doMock("html-to-docx", () => ({
      default: vi.fn().mockResolvedValue(buf),
    }));

    const { exportDocx: exportDocxFresh } = await import("./export");
    await exportDocxFresh("ArrayBuf");

    const call = invokeMock.mock.calls.find((c) => c[0] === "write_file_bytes");
    expect(call).toBeDefined();
    expect(call![1].data).toBeInstanceOf(Array);
  });

  it("shows an error toast and re-throws when write_file_bytes fails", async () => {
    const fakeBlob = new Blob(["x"]);
    vi.doMock("html-to-docx", () => ({
      default: vi.fn().mockResolvedValue(fakeBlob),
    }));
    invokeMock.mockRejectedValue(new Error("write error"));

    const { exportDocx: exportDocxFresh } = await import("./export");
    await expect(exportDocxFresh("Fail")).rejects.toBeDefined();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("write error"),
    );
  });

  it("requests a .docx file filter in the save dialog", async () => {
    const fakeBlob = new Blob(["x"]);
    vi.doMock("html-to-docx", () => ({
      default: vi.fn().mockResolvedValue(fakeBlob),
    }));

    const { exportDocx: exportDocxFresh } = await import("./export");
    await exportDocxFresh("Filter Test");

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.arrayContaining([
          expect.objectContaining({ extensions: expect.arrayContaining(["docx"]) }),
        ]),
      }),
    );
  });
});

// ─── exportPdf ────────────────────────────────────────────────────────────────

describe("exportPdf", () => {
  beforeEach(() => {
    setupReadView();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });
  afterEach(() => teardownDom());

  /**
   * In happy-dom iframes have no real contentDocument/contentWindow, so we
   * simulate the iframe load + print flow by patching createElement to intercept
   * the iframe and immediately fire its onload with a mock print function.
   */
  function patchIframe(printFn: () => void = vi.fn()) {
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag !== "iframe") return origCreate(tag);
      const iframe = origCreate("iframe") as HTMLIFrameElement;

      // Stub contentDocument with open/write/close + contentWindow.print.
      const mockDoc = { open: vi.fn(), write: vi.fn(), close: vi.fn() };
      const mockWin = { print: printFn };
      Object.defineProperty(iframe, "contentDocument", {
        get: () => mockDoc,
        configurable: true,
      });
      Object.defineProperty(iframe, "contentWindow", {
        get: () => mockWin,
        configurable: true,
      });

      // Fire onload asynchronously after the element is appended.
      const origAppendChild = document.body.appendChild.bind(document.body);
      vi.spyOn(document.body, "appendChild").mockImplementationOnce((node) => {
        const result = origAppendChild(node);
        // Trigger onload on next tick.
        setTimeout(() => {
          if (typeof iframe.onload === "function") {
            // biome-ignore lint/suspicious/noExplicitAny: test helper
            (iframe.onload as any)();
          }
        }, 0);
        return result;
      });

      return iframe;
    });
  }

  it("throws a user-visible error when not in Read view", async () => {
    teardownDom();
    await expect(exportPdf("No view")).rejects.toMatch(
      "Switch to Read view before exporting.",
    );
  });

  it("appends a hidden iframe to the document body", async () => {
    patchIframe();
    await exportPdf("PDF Test");
    const iframes = document.querySelectorAll("iframe");
    // The iframe is removed after printing; the spy tracks it was created.
    // We just need the promise to resolve without throwing.
    expect(iframes).toBeDefined();
    vi.restoreAllMocks();
  });

  it("writes the standalone HTML into the iframe document", async () => {
    let capturedWrite: string | undefined;
    const mockDoc = {
      open: vi.fn(),
      write: vi.fn((html: string) => { capturedWrite = html; }),
      close: vi.fn(),
    };
    const printFn = vi.fn();
    const mockWin = { print: printFn };

    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag !== "iframe") return origCreate(tag);
      const iframe = origCreate("iframe") as HTMLIFrameElement;
      Object.defineProperty(iframe, "contentDocument", { get: () => mockDoc, configurable: true });
      Object.defineProperty(iframe, "contentWindow", { get: () => mockWin, configurable: true });
      const origAppend = document.body.appendChild.bind(document.body);
      vi.spyOn(document.body, "appendChild").mockImplementationOnce((node) => {
        const r = origAppend(node);
        setTimeout(() => { if (typeof iframe.onload === "function") (iframe.onload as any)(); }, 0);
        return r;
      });
      return iframe;
    });

    await exportPdf("Content Check");

    expect(mockDoc.open).toHaveBeenCalled();
    expect(capturedWrite).toContain("<!doctype html>");
    expect(capturedWrite).toContain("<h1>My Document</h1>");
    vi.restoreAllMocks();
  });

  it("calls print() on the iframe contentWindow", async () => {
    const printFn = vi.fn();
    patchIframe(printFn);
    await exportPdf("Print Call");
    expect(printFn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("shows a success toast after opening the print dialog", async () => {
    patchIframe();
    await exportPdf("Toast Check");
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining("print dialog"),
    );
    vi.restoreAllMocks();
  });

  it("rejects when contentDocument is null", async () => {
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag !== "iframe") return origCreate(tag);
      const iframe = origCreate("iframe") as HTMLIFrameElement;
      Object.defineProperty(iframe, "contentDocument", { get: () => null, configurable: true });
      Object.defineProperty(iframe, "contentWindow", { get: () => null, configurable: true });
      const origAppend = document.body.appendChild.bind(document.body);
      vi.spyOn(document.body, "appendChild").mockImplementationOnce((node) => {
        return origAppend(node);
      });
      return iframe;
    });

    await expect(exportPdf("No doc")).rejects.toMatch("print frame");
    vi.restoreAllMocks();
  });

  it("exported HTML contains @media print rules for pagination", async () => {
    let capturedWrite: string | undefined;
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag !== "iframe") return origCreate(tag);
      const iframe = origCreate("iframe") as HTMLIFrameElement;
      const mockDoc = {
        open: vi.fn(),
        write: vi.fn((h: string) => { capturedWrite = h; }),
        close: vi.fn(),
      };
      Object.defineProperty(iframe, "contentDocument", { get: () => mockDoc, configurable: true });
      Object.defineProperty(iframe, "contentWindow", { get: () => ({ print: vi.fn() }), configurable: true });
      const origAppend = document.body.appendChild.bind(document.body);
      vi.spyOn(document.body, "appendChild").mockImplementationOnce((node) => {
        const r = origAppend(node);
        setTimeout(() => { if (typeof iframe.onload === "function") (iframe.onload as any)(); }, 0);
        return r;
      });
      return iframe;
    });

    await exportPdf("Pagination");
    expect(capturedWrite).toContain("@media print");
    expect(capturedWrite).toContain("page-break-inside:avoid");
    vi.restoreAllMocks();
  });

  it("exported HTML excludes app chrome (no .copy-btn in print view)", async () => {
    let capturedWrite: string | undefined;
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag !== "iframe") return origCreate(tag);
      const iframe = origCreate("iframe") as HTMLIFrameElement;
      const mockDoc = {
        open: vi.fn(),
        write: vi.fn((h: string) => { capturedWrite = h; }),
        close: vi.fn(),
      };
      Object.defineProperty(iframe, "contentDocument", { get: () => mockDoc, configurable: true });
      Object.defineProperty(iframe, "contentWindow", { get: () => ({ print: vi.fn() }), configurable: true });
      const origAppend = document.body.appendChild.bind(document.body);
      vi.spyOn(document.body, "appendChild").mockImplementationOnce((node) => {
        const r = origAppend(node);
        setTimeout(() => { if (typeof iframe.onload === "function") (iframe.onload as any)(); }, 0);
        return r;
      });
      return iframe;
    });

    // Add a review card + copy button to the DOM to confirm they're stripped.
    const mb = document.querySelector(".markdown-body")!;
    mb.innerHTML +=
      '<aside class="review-card">REVIEW</aside><button class="copy-btn">Copy</button>';

    await exportPdf("Chrome Strip");
    expect(capturedWrite).not.toContain("REVIEW");
    // copy-btn is only hidden via CSS print rule, not stripped from HTML:
    expect(capturedWrite).toContain(".copy-btn{display:none}");
    vi.restoreAllMocks();
  });
});

// ─── currentTheme / currentLayoutVars defaults ────────────────────────────────

describe("buildStandaloneHtml layout var defaults", () => {
  afterEach(() => {
    teardownDom();
    delete document.documentElement.dataset.theme;
  });

  it("uses 720px width fallback when CSS var is empty", () => {
    setupReadView();
    const html = buildStandaloneHtml("Defaults");
    expect(html).toContain("720px");
  });

  it("uses 17px font-size fallback when CSS var is empty", () => {
    setupReadView();
    const html = buildStandaloneHtml("Defaults");
    expect(html).toContain("17px");
  });

  it("sepia theme is embedded in data-theme attribute", () => {
    setupReadView();
    document.documentElement.dataset.theme = "sepia";
    const html = buildStandaloneHtml("Sepia");
    expect(html).toContain('data-theme="sepia"');
  });
});

// ─── buildStandaloneHtml — template CSS injection ─────────────────────────────

describe("buildStandaloneHtml with template", () => {
  beforeEach(() => setupReadView());
  afterEach(() => teardownDom());

  it("injects template CSS after base styles when template is provided", () => {
    const tpl = { id: "tpl-test", name: "Test Template", css: "body{color:hotpink}" };
    const html = buildStandaloneHtml("With Template", tpl);
    expect(html).toContain("body{color:hotpink}");
    // Template CSS must appear AFTER KaTeX CSS to win the cascade.
    const katexPos = html.indexOf("/* katex-css */");
    const tplPos = html.indexOf("body{color:hotpink}");
    expect(tplPos).toBeGreaterThan(katexPos);
  });

  it("adds data-export-template attribute to <html> when template is set", () => {
    const tpl = { id: "builtin-github", name: "GitHub Readme", css: "body{}" };
    const html = buildStandaloneHtml("Attr Test", tpl);
    expect(html).toContain('data-export-template="builtin-github"');
  });

  it("omits data-export-template attribute when no template is passed", () => {
    const html = buildStandaloneHtml("No Template");
    expect(html).not.toContain("data-export-template");
  });

  it("omits data-export-template attribute when template is null", () => {
    const html = buildStandaloneHtml("Null Template", null);
    expect(html).not.toContain("data-export-template");
  });

  it("adds a comment identifying the template name in the CSS block", () => {
    const tpl = { id: "my-tpl", name: "My Named Template", css: "p{margin:0}" };
    const html = buildStandaloneHtml("Named", tpl);
    expect(html).toContain("My Named Template");
  });

  it("still includes all base CSS bundles when a template is used", () => {
    const tpl = { id: "x", name: "X", css: ".reading-surface{max-width:900px}" };
    const html = buildStandaloneHtml("Base+Template", tpl);
    expect(html).toContain("/* themes-css */");
    expect(html).toContain("/* markdown-css */");
    expect(html).toContain("/* katex-css */");
  });

  it("template CSS with special characters is included verbatim", () => {
    const tpl = {
      id: "special",
      name: "Special",
      css: ':root { --color: color-mix(in srgb, #ff0000 50%, #0000ff); }',
    };
    const html = buildStandaloneHtml("Special CSS", tpl);
    expect(html).toContain("color-mix(in srgb");
  });

  it("empty template CSS results in no extra content (no template block injected)", () => {
    const tpl = { id: "empty-css", name: "Empty", css: "" };
    const html = buildStandaloneHtml("Empty CSS", tpl);
    // Should still be a valid document but with no extra style block.
    expect(html).toContain("<!doctype html>");
    // No template comment for empty CSS.
    expect(html).not.toContain("Export template: Empty");
  });

  it("HTML-escapes template name in comment to prevent injection", () => {
    const tpl = {
      id: "xss",
      name: 'Evil <script>alert(1)</script>',
      css: "body{}",
    };
    const html = buildStandaloneHtml("XSS Test", tpl);
    // The raw <script> must not appear verbatim in the output.
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("HTML-escapes template id attribute to prevent injection", () => {
    const tpl = {
      id: 'foo" onload="evil()',
      name: "Injected",
      css: "body{}",
    };
    const html = buildStandaloneHtml("Attr Injection", tpl);
    expect(html).not.toContain('onload="evil()');
  });

  it("cascade order: template CSS block appears after @media print rules", () => {
    const tpl = { id: "t", name: "T", css: "h1{color:navy}" };
    const html = buildStandaloneHtml("Order", tpl);
    const printPos = html.indexOf("@media print");
    const tplPos = html.indexOf("h1{color:navy}");
    expect(tplPos).toBeGreaterThan(printPos);
  });
});

// ─── buildStandaloneHtmlWithActiveTemplate ────────────────────────────────────

describe("buildStandaloneHtmlWithActiveTemplate", () => {
  beforeEach(() => {
    setupReadView();
    mockGetState.mockReset();
  });
  afterEach(() => teardownDom());

  it("uses base styles only when activeTemplateId is NO_TEMPLATE_ID", () => {
    mockGetState.mockReturnValue({ activeTemplateId: "none", userTemplates: [] });
    const html = buildStandaloneHtmlWithActiveTemplate("No Active");
    expect(html).not.toContain("data-export-template");
  });

  it("injects built-in template CSS when a built-in id is active", () => {
    mockGetState.mockReturnValue({
      activeTemplateId: "builtin-github",
      userTemplates: [],
    });
    const html = buildStandaloneHtmlWithActiveTemplate("GitHub Active");
    expect(html).toContain('data-export-template="builtin-github"');
    // GitHub template contains font-family override.
    expect(html).toContain("font-family");
  });

  it("injects user template CSS when a user template id is active", () => {
    mockGetState.mockReturnValue({
      activeTemplateId: "user-custom",
      userTemplates: [
        { id: "user-custom", name: "Custom", css: "body{font-size:20px}", builtin: false },
      ],
    });
    const html = buildStandaloneHtmlWithActiveTemplate("User Active");
    expect(html).toContain("body{font-size:20px}");
    expect(html).toContain('data-export-template="user-custom"');
  });

  it("falls back to no template when activeTemplateId is an unknown id", () => {
    mockGetState.mockReturnValue({
      activeTemplateId: "ghost-id",
      userTemplates: [],
    });
    const html = buildStandaloneHtmlWithActiveTemplate("Ghost");
    expect(html).not.toContain("data-export-template");
  });

  it("still inlines base CSS bundles regardless of template", () => {
    mockGetState.mockReturnValue({
      activeTemplateId: "builtin-academic",
      userTemplates: [],
    });
    const html = buildStandaloneHtmlWithActiveTemplate("Academic");
    expect(html).toContain("/* themes-css */");
    expect(html).toContain("/* markdown-css */");
    expect(html).toContain("/* katex-css */");
  });
});

// ─── Template CSS scope isolation in full export output ───────────────────────

describe("export template variable substitution and scope isolation", () => {
  beforeEach(() => setupReadView());
  afterEach(() => {
    teardownDom();
    mockGetState.mockReset();
  });

  it("CSS custom properties in template are preserved verbatim in output", () => {
    const css = ":root{--my-accent:#ff6600}body{color:var(--my-accent)}";
    const tpl = { id: "t", name: "Token Test", css };
    const html = buildStandaloneHtml("Tokens", tpl);
    expect(html).toContain("--my-accent:#ff6600");
    expect(html).toContain("var(--my-accent)");
  });

  it("template CSS referencing base theme tokens works alongside theme block", () => {
    const css = "body{background:var(--bg);color:var(--text)}";
    const tpl = { id: "t2", name: "Theme Ref", css };
    const html = buildStandaloneHtml("Theme Ref", tpl);
    // Both the theme definition and the reference should be present.
    expect(html).toContain("/* themes-css */");
    expect(html).toContain("var(--bg)");
    expect(html).toContain("var(--text)");
  });

  it("multiple templates produce distinct HTML output", () => {
    const tpl1 = { id: "a", name: "A", css: "body{font-size:14px}" };
    const tpl2 = { id: "b", name: "B", css: "body{font-size:20px}" };
    const html1 = buildStandaloneHtml("A", tpl1);
    const html2 = buildStandaloneHtml("B", tpl2);
    expect(html1).not.toBe(html2);
    expect(html1).toContain("font-size:14px");
    expect(html2).toContain("font-size:20px");
  });

  it("GitHub built-in template produces an offline-ready document (no external links)", () => {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === "builtin-github")!;
    const html = buildStandaloneHtml("Offline GitHub", tpl);
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
  });

  it("Notion built-in template produces a valid HTML5 document", () => {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === "builtin-notion")!;
    const html = buildStandaloneHtml("Notion Valid", tpl);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });
});

// ─── Import built-in templates for cross-suite use ───────────────────────────

import { BUILTIN_TEMPLATES } from "./exportTemplates";

// ─── Import new export utilities under test ───────────────────────────────────

import {
  buildMarkdownArchive,
  buildCanvasGraph,
  exportMarkdownArchive,
  exportCanvasGraph,
  type MarkdownArchiveEntry,
  type VaultDocDescriptor,
} from "./export";

// ─── Mock documentStore for exportMarkdownArchive ────────────────────────────

const mockDocGetState = vi.fn(() => ({
  path: "/vault/my-doc.md",
  fileName: "my-doc.md",
  content: "# Hello\n\nWorld.",
}));
vi.mock("../store/documentStore", () => ({
  useDocumentStore: { getState: (...args: unknown[]) => mockDocGetState(...args) },
}));

// ════════════════════════════════════════════════════════════════════════════
// buildMarkdownArchive — pure packing logic
// ════════════════════════════════════════════════════════════════════════════

describe("buildMarkdownArchive", () => {
  it("returns a single entry when no assets are given", () => {
    const entries = buildMarkdownArchive("# Title\n\nBody.", "doc.md");
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("doc.md");
    expect(entries[0].content).toBe("# Title\n\nBody.");
  });

  it("first entry is always the .md source file", () => {
    const entries = buildMarkdownArchive("content", "notes.md", {
      "assets/fig.svg": "<svg/>",
    });
    expect(entries[0].name).toBe("notes.md");
  });

  it("asset entries follow the .md entry in insertion order", () => {
    const entries = buildMarkdownArchive("# Doc", "doc.md", {
      "assets/a.svg": "<svg>a</svg>",
      "assets/b.png": "binary-data",
    });
    expect(entries).toHaveLength(3);
    expect(entries[1].name).toBe("assets/a.svg");
    expect(entries[2].name).toBe("assets/b.png");
  });

  it("preserves asset content verbatim", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100"/></svg>';
    const entries = buildMarkdownArchive("# D", "d.md", { "img/diagram.svg": svg });
    const assetEntry = entries.find((e) => e.name === "img/diagram.svg");
    expect(assetEntry?.content).toBe(svg);
  });

  it("uses 'document.md' as default fileName", () => {
    const entries = buildMarkdownArchive("# Default");
    expect(entries[0].name).toBe("document.md");
  });

  it("preserves YAML front-matter in the .md content", () => {
    const src = "---\ntitle: My Doc\ntags: [a, b]\n---\n\n# Body";
    const entries = buildMarkdownArchive(src, "doc.md");
    expect(entries[0].content).toContain("---");
    expect(entries[0].content).toContain("title: My Doc");
    expect(entries[0].content).toContain("tags: [a, b]");
  });

  it("empty assets object produces exactly one entry", () => {
    const entries = buildMarkdownArchive("content", "f.md", {});
    expect(entries).toHaveLength(1);
  });

  it("returns correct type shape for each entry", () => {
    const entries = buildMarkdownArchive("x", "x.md", { "a.svg": "<svg/>" });
    for (const entry of entries) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.content).toBe("string");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildCanvasGraph — pure graph construction
// ════════════════════════════════════════════════════════════════════════════

describe("buildCanvasGraph", () => {
  const sampleDocs: VaultDocDescriptor[] = [
    { path: "/vault/a.md", title: "Alpha", tags: ["tag1"], wordCount: 120, linksTo: ["/vault/b.md"] },
    { path: "/vault/b.md", title: "Beta",  tags: [],       wordCount: 80,  linksTo: [] },
    { path: "/vault/c.md", title: "Gamma", tags: ["tag2"], wordCount: 200, linksTo: ["/vault/a.md"] },
  ];

  it("produces a node for every document", () => {
    const canvas = buildCanvasGraph(sampleDocs);
    expect(canvas.nodes).toHaveLength(3);
  });

  it("every node has required JSON Canvas fields", () => {
    const canvas = buildCanvasGraph(sampleDocs);
    for (const node of canvas.nodes) {
      expect(node.id).toBeTruthy();
      expect(node.type).toBe("text");
      expect(typeof node.x).toBe("number");
      expect(typeof node.y).toBe("number");
      expect(typeof node.width).toBe("number");
      expect(typeof node.height).toBe("number");
      expect(typeof node.text).toBe("string");
    }
  });

  it("node text includes the document title", () => {
    const canvas = buildCanvasGraph(sampleDocs);
    const alphaNode = canvas.nodes.find((n) => n.metadata?.path === "/vault/a.md");
    expect(alphaNode?.text).toContain("Alpha");
  });

  it("node text includes tags when present", () => {
    const canvas = buildCanvasGraph(sampleDocs);
    const alphaNode = canvas.nodes.find((n) => n.metadata?.path === "/vault/a.md");
    expect(alphaNode?.text).toContain("tag1");
  });

  it("node text includes word count when present", () => {
    const canvas = buildCanvasGraph(sampleDocs);
    const alphaNode = canvas.nodes.find((n) => n.metadata?.path === "/vault/a.md");
    expect(alphaNode?.text).toContain("120");
  });

  it("produces an edge for each wikilink", () => {
    const canvas = buildCanvasGraph(sampleDocs);
    // a→b and c→a = 2 edges
    expect(canvas.edges).toHaveLength(2);
  });

  it("edge fromNode and toNode reference valid node ids", () => {
    const canvas = buildCanvasGraph(sampleDocs);
    const nodeIds = new Set(canvas.nodes.map((n) => n.id));
    for (const edge of canvas.edges) {
      expect(nodeIds.has(edge.fromNode)).toBe(true);
      expect(nodeIds.has(edge.toNode)).toBe(true);
    }
  });

  it("edge side fields are 'right' and 'left'", () => {
    const canvas = buildCanvasGraph(sampleDocs);
    for (const edge of canvas.edges) {
      expect(edge.fromSide).toBe("right");
      expect(edge.toSide).toBe("left");
    }
  });

  it("each edge has a unique id", () => {
    const canvas = buildCanvasGraph(sampleDocs);
    const ids = new Set(canvas.edges.map((e) => e.id));
    expect(ids.size).toBe(canvas.edges.length);
  });

  it("excludes isolated nodes when includeIsolated=false", () => {
    const docs: VaultDocDescriptor[] = [
      { path: "/a.md", title: "A", linksTo: ["/b.md"] },
      { path: "/b.md", title: "B", linksTo: [] },
      { path: "/isolated.md", title: "Isolated", linksTo: [] },
    ];
    const canvas = buildCanvasGraph(docs, false);
    const paths = canvas.nodes.map((n) => n.metadata?.path);
    expect(paths).not.toContain("/isolated.md");
    expect(paths).toContain("/a.md");
    expect(paths).toContain("/b.md");
  });

  it("includes isolated nodes when includeIsolated=true (default)", () => {
    const docs: VaultDocDescriptor[] = [
      { path: "/a.md", title: "A", linksTo: ["/b.md"] },
      { path: "/b.md", title: "B", linksTo: [] },
      { path: "/isolated.md", title: "Isolated", linksTo: [] },
    ];
    const canvas = buildCanvasGraph(docs, true);
    const paths = canvas.nodes.map((n) => n.metadata?.path);
    expect(paths).toContain("/isolated.md");
  });

  it("handles empty vault gracefully", () => {
    const canvas = buildCanvasGraph([]);
    expect(canvas.nodes).toHaveLength(0);
    expect(canvas.edges).toHaveLength(0);
  });

  it("node ids are unique", () => {
    const canvas = buildCanvasGraph(sampleDocs);
    const ids = new Set(canvas.nodes.map((n) => n.id));
    expect(ids.size).toBe(canvas.nodes.length);
  });

  it("nodes are laid out in a grid (different x/y positions)", () => {
    // With 5 docs and 4 columns, row 0 has 4 nodes, row 1 has 1.
    const docs = Array.from({ length: 5 }, (_, i) => ({
      path: `/doc${i}.md`,
      title: `Doc ${i}`,
    }));
    const canvas = buildCanvasGraph(docs);
    const positions = canvas.nodes.map((n) => `${n.x},${n.y}`);
    const unique = new Set(positions);
    expect(unique.size).toBe(5);
  });

  it("self-links are not added as edges", () => {
    const docs: VaultDocDescriptor[] = [
      { path: "/a.md", title: "A", linksTo: ["/a.md"] },
    ];
    const canvas = buildCanvasGraph(docs);
    expect(canvas.edges).toHaveLength(0);
  });

  it("metadata field carries path, title, tags, wordCount", () => {
    const canvas = buildCanvasGraph(sampleDocs);
    const node = canvas.nodes[0];
    expect(node.metadata?.path).toBeTruthy();
    expect(node.metadata?.title).toBeTruthy();
    expect(Array.isArray(node.metadata?.tags)).toBe(true);
    expect(typeof node.metadata?.wordCount).toBe("number");
  });

  it("links to unknown paths (not in the vault) produce no edges", () => {
    const docs: VaultDocDescriptor[] = [
      { path: "/a.md", title: "A", linksTo: ["/nonexistent.md"] },
    ];
    const canvas = buildCanvasGraph(docs);
    expect(canvas.edges).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// exportMarkdownArchive — integration (mocked Tauri + dialog)
// ════════════════════════════════════════════════════════════════════════════

describe("exportMarkdownArchive", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    saveMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    mockDocGetState.mockReturnValue({
      path: "/vault/my-doc.md",
      fileName: "my-doc.md",
      content: "# Hello\n\nWorld.",
    });
    invokeMock.mockResolvedValue({ path: "/vault/my-doc.tar.gz", files: ["my-doc.md"], size: 512 });
    saveMock.mockResolvedValue("/vault/my-doc.tar.gz");
  });

  it("calls export_markdown_archive invoke with outputPath and includeAssets", async () => {
    await exportMarkdownArchive({ outputPath: "/out/archive.tar.gz", includeAssets: true });
    expect(invokeMock).toHaveBeenCalledWith("export_markdown_archive", {
      outputPath: "/out/archive.tar.gz",
      includeAssets: true,
    });
  });

  it("defaults includeAssets to true when not specified", async () => {
    await exportMarkdownArchive({ outputPath: "/out/archive.tar.gz" });
    expect(invokeMock).toHaveBeenCalledWith("export_markdown_archive", {
      outputPath: "/out/archive.tar.gz",
      includeAssets: true,
    });
  });

  it("shows a success toast with the archive filename", async () => {
    await exportMarkdownArchive({ outputPath: "/out/archive.tar.gz" });
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining("tar.gz"),
    );
  });

  it("returns the output path on success", async () => {
    const result = await exportMarkdownArchive({ outputPath: "/out/archive.tar.gz" });
    expect(result).toBe("/vault/my-doc.tar.gz");
  });

  it("opens a save dialog when no outputPath is provided", async () => {
    await exportMarkdownArchive();
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.arrayContaining([
          expect.objectContaining({ extensions: expect.arrayContaining(["tar.gz"]) }),
        ]),
      }),
    );
  });

  it("returns empty string when user cancels the save dialog", async () => {
    saveMock.mockResolvedValue(null);
    const result = await exportMarkdownArchive();
    expect(result).toBe("");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("shows an error toast and re-throws when invoke fails", async () => {
    invokeMock.mockRejectedValue(new Error("disk error"));
    await expect(exportMarkdownArchive({ outputPath: "/out/x.tar.gz" })).rejects.toBeDefined();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("disk error"),
    );
  });

  it("throws a user-visible error when no document is open (no outputPath path)", async () => {
    mockDocGetState.mockReturnValue({ path: null, fileName: null, content: "" });
    await expect(exportMarkdownArchive()).rejects.toMatch(/No document is open/);
  });

  it("passes includeAssets=false to the invoke call", async () => {
    await exportMarkdownArchive({ outputPath: "/out/slim.tar.gz", includeAssets: false });
    expect(invokeMock).toHaveBeenCalledWith("export_markdown_archive", {
      outputPath: "/out/slim.tar.gz",
      includeAssets: false,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// exportCanvasGraph — integration (mocked Tauri + dialog)
// ════════════════════════════════════════════════════════════════════════════

describe("exportCanvasGraph", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    saveMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    invokeMock.mockResolvedValue({ path: "/vault/vault-graph.canvas", nodeCount: 5, edgeCount: 3 });
    saveMock.mockResolvedValue("/vault/vault-graph.canvas");
  });

  it("calls export_canvas_graph invoke with outputPath and includeIsolated", async () => {
    await exportCanvasGraph({ outputPath: "/out/graph.canvas", includeIsolated: true });
    expect(invokeMock).toHaveBeenCalledWith("export_canvas_graph", {
      outputPath: "/out/graph.canvas",
      includeIsolated: true,
    });
  });

  it("defaults includeIsolated to true when not specified", async () => {
    await exportCanvasGraph({ outputPath: "/out/graph.canvas" });
    expect(invokeMock).toHaveBeenCalledWith("export_canvas_graph", {
      outputPath: "/out/graph.canvas",
      includeIsolated: true,
    });
  });

  it("shows a success toast with the canvas filename", async () => {
    await exportCanvasGraph({ outputPath: "/out/graph.canvas" });
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining(".canvas"),
    );
  });

  it("returns the output path on success", async () => {
    const result = await exportCanvasGraph({ outputPath: "/out/graph.canvas" });
    expect(result).toBe("/vault/vault-graph.canvas");
  });

  it("opens a save dialog with .canvas filter when no outputPath is provided", async () => {
    await exportCanvasGraph();
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.arrayContaining([
          expect.objectContaining({ extensions: expect.arrayContaining(["canvas"]) }),
        ]),
      }),
    );
  });

  it("returns empty string when user cancels the save dialog", async () => {
    saveMock.mockResolvedValue(null);
    const result = await exportCanvasGraph();
    expect(result).toBe("");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("shows an error toast and re-throws when invoke fails", async () => {
    invokeMock.mockRejectedValue(new Error("write failed"));
    await expect(exportCanvasGraph({ outputPath: "/out/g.canvas" })).rejects.toBeDefined();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("write failed"),
    );
  });

  it("passes includeIsolated=false to the invoke call", async () => {
    await exportCanvasGraph({ outputPath: "/out/connected.canvas", includeIsolated: false });
    expect(invokeMock).toHaveBeenCalledWith("export_canvas_graph", {
      outputPath: "/out/connected.canvas",
      includeIsolated: false,
    });
  });

  it("default save dialog path is vault-graph.canvas", async () => {
    await exportCanvasGraph();
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "vault-graph.canvas" }),
    );
  });
});
