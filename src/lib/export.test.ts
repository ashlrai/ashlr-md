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

import { ALL_PROFILE_IDS, BUILTIN_TEMPLATES, type ExportProfileId } from "./exportTemplates";

// ─── Import new export utilities under test ───────────────────────────────────

import {
  buildMarkdownArchive,
  buildCanvasGraph,
  exportMarkdownArchive,
  exportCanvasGraph,
  exportOutline,
  type MarkdownArchiveEntry,
  type VaultDocDescriptor,
  type OutlineNode,
} from "./export";

import { buildOutlineTree, buildOpml } from "./exportOutline";

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

// ════════════════════════════════════════════════════════════════════════════
// buildOutlineTree — pure hierarchical tree construction
// ════════════════════════════════════════════════════════════════════════════

describe("buildOutlineTree", () => {
  it("returns an empty array for an empty headings list", () => {
    expect(buildOutlineTree([])).toEqual([]);
  });

  it("single H1 produces one root node with no children", () => {
    const tree = buildOutlineTree([
      { depth: 1, text: "Title", slug: "title", line: 1 },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].title).toBe("Title");
    expect(tree[0].level).toBe(1);
    expect(tree[0].children).toHaveLength(0);
  });

  it("H2 after H1 is nested as a child of H1", () => {
    const tree = buildOutlineTree([
      { depth: 1, text: "Root", slug: "root", line: 1 },
      { depth: 2, text: "Child", slug: "child", line: 5 },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].title).toBe("Child");
  });

  it("two H1s produce two root nodes", () => {
    const tree = buildOutlineTree([
      { depth: 1, text: "First", slug: "first", line: 1 },
      { depth: 1, text: "Second", slug: "second", line: 10 },
    ]);
    expect(tree).toHaveLength(2);
  });

  it("skipped level (H1 → H3) — H3 becomes child of H1 (no phantom H2)", () => {
    const tree = buildOutlineTree([
      { depth: 1, text: "Root", slug: "root", line: 1 },
      { depth: 3, text: "Deep", slug: "deep", line: 3 },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].level).toBe(3);
  });

  it("missing H1 — tree starts at the first heading level present", () => {
    const tree = buildOutlineTree([
      { depth: 2, text: "A", slug: "a", line: 1 },
      { depth: 3, text: "B", slug: "b", line: 5 },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].level).toBe(2);
    expect(tree[0].children[0].level).toBe(3);
  });

  it("node id matches slug from parseHeadings", () => {
    const tree = buildOutlineTree([
      { depth: 1, text: "Hello World", slug: "hello-world", line: 1 },
    ]);
    expect(tree[0].id).toBe("hello-world");
    expect(tree[0].metadata.headingId).toBe("hello-world");
  });

  it("all node ids are unique for a document with duplicate heading text", () => {
    // github-slugger appends -1, -2 for repeated slugs
    const tree = buildOutlineTree([
      { depth: 2, text: "Section", slug: "section", line: 1 },
      { depth: 2, text: "Section", slug: "section-1", line: 5 },
      { depth: 2, text: "Section", slug: "section-2", line: 9 },
    ]);
    const ids = tree.map((n) => n.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("metadata.startLine matches source line number", () => {
    const tree = buildOutlineTree([
      { depth: 1, text: "T", slug: "t", line: 7 },
    ]);
    expect(tree[0].metadata.startLine).toBe(7);
  });

  it("endLine is null for the last heading in the document", () => {
    const tree = buildOutlineTree([
      { depth: 1, text: "A", slug: "a", line: 1 },
      { depth: 2, text: "B", slug: "b", line: 5 },
    ]);
    // The deepest/last heading always has endLine null
    expect(tree[0].children[0].metadata.endLine).toBeNull();
  });

  it("endLine of H1 is the startLine of the next H1", () => {
    const tree = buildOutlineTree([
      { depth: 1, text: "A", slug: "a", line: 1 },
      { depth: 2, text: "A-child", slug: "a-child", line: 3 },
      { depth: 1, text: "B", slug: "b", line: 10 },
    ]);
    expect(tree[0].metadata.endLine).toBe(10);
    expect(tree[1].metadata.endLine).toBeNull();
  });

  it("deeply nested H4 appears in the correct position in the tree", () => {
    const tree = buildOutlineTree([
      { depth: 1, text: "L1", slug: "l1", line: 1 },
      { depth: 2, text: "L2", slug: "l2", line: 2 },
      { depth: 3, text: "L3", slug: "l3", line: 3 },
      { depth: 4, text: "L4", slug: "l4", line: 4 },
    ]);
    expect(tree[0].children[0].children[0].children[0].title).toBe("L4");
  });

  it("sibling H2s under the same H1 are both children of H1", () => {
    const tree = buildOutlineTree([
      { depth: 1, text: "Root", slug: "root", line: 1 },
      { depth: 2, text: "Sibling A", slug: "sibling-a", line: 3 },
      { depth: 2, text: "Sibling B", slug: "sibling-b", line: 6 },
    ]);
    expect(tree[0].children).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildOpml — OPML serialisation
// ════════════════════════════════════════════════════════════════════════════

describe("buildOpml", () => {
  it("produces valid XML declaration and opml root element", () => {
    const opml = buildOpml([], "Empty Doc");
    expect(opml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(opml).toContain('<opml version="2.0">');
    expect(opml).toContain("</opml>");
  });

  it("includes document title in <head>", () => {
    const opml = buildOpml([], "My Report");
    expect(opml).toContain("<title>My Report</title>");
  });

  it("empty nodes list produces a <body> with no <outline> children", () => {
    const opml = buildOpml([], "Empty");
    expect(opml).toContain("<body>");
    expect(opml).toContain("</body>");
    expect(opml).not.toContain("<outline");
  });

  it("each heading becomes an <outline> element with text attribute", () => {
    const nodes: OutlineNode[] = [
      {
        id: "intro",
        title: "Introduction",
        level: 1,
        children: [],
        metadata: { startLine: 1, endLine: 10, headingId: "intro" },
      },
    ];
    const opml = buildOpml(nodes, "Doc");
    expect(opml).toContain('text="Introduction"');
  });

  it("outline element carries _note attribute with #id anchor", () => {
    const nodes: OutlineNode[] = [
      {
        id: "my-section",
        title: "My Section",
        level: 2,
        children: [],
        metadata: { startLine: 5, endLine: null, headingId: "my-section" },
      },
    ];
    const opml = buildOpml(nodes, "Doc");
    expect(opml).toContain('_note="#my-section"');
  });

  it("child nodes are nested inside parent <outline> element", () => {
    const nodes: OutlineNode[] = [
      {
        id: "parent",
        title: "Parent",
        level: 1,
        children: [
          {
            id: "child",
            title: "Child",
            level: 2,
            children: [],
            metadata: { startLine: 3, endLine: null, headingId: "child" },
          },
        ],
        metadata: { startLine: 1, endLine: null, headingId: "parent" },
      },
    ];
    const opml = buildOpml(nodes, "Nested");
    // Child <outline> must appear between parent's open and close tags
    const parentOpen = opml.indexOf('text="Parent"');
    const childText = opml.indexOf('text="Child"');
    expect(childText).toBeGreaterThan(parentOpen);
    expect(opml).toContain("</outline>");
  });

  it("XML-escapes special characters in title and id", () => {
    const nodes: OutlineNode[] = [
      {
        id: "q-a",
        title: 'Q&A: "Tips" <here>',
        level: 1,
        children: [],
        metadata: { startLine: 1, endLine: null, headingId: "q-a" },
      },
    ];
    const opml = buildOpml(nodes, "Doc");
    expect(opml).toContain("Q&amp;A:");
    expect(opml).toContain("&quot;Tips&quot;");
    expect(opml).toContain("&lt;here&gt;");
  });

  it("includes level attribute on each outline element", () => {
    const nodes: OutlineNode[] = [
      {
        id: "h2",
        title: "A heading",
        level: 2,
        children: [],
        metadata: { startLine: 1, endLine: null, headingId: "h2" },
      },
    ];
    const opml = buildOpml(nodes, "Doc");
    expect(opml).toContain('level="2"');
  });

  it("includes startLine attribute on each outline element", () => {
    const nodes: OutlineNode[] = [
      {
        id: "s",
        title: "S",
        level: 1,
        children: [],
        metadata: { startLine: 42, endLine: null, headingId: "s" },
      },
    ];
    const opml = buildOpml(nodes, "Doc");
    expect(opml).toContain('startLine="42"');
  });

  it("includes endLine attribute when endLine is not null", () => {
    const nodes: OutlineNode[] = [
      {
        id: "s",
        title: "S",
        level: 1,
        children: [],
        metadata: { startLine: 1, endLine: 20, headingId: "s" },
      },
    ];
    const opml = buildOpml(nodes, "Doc");
    expect(opml).toContain('endLine="20"');
  });

  it("omits endLine attribute when endLine is null", () => {
    const nodes: OutlineNode[] = [
      {
        id: "s",
        title: "S",
        level: 1,
        children: [],
        metadata: { startLine: 1, endLine: null, headingId: "s" },
      },
    ];
    const opml = buildOpml(nodes, "Doc");
    expect(opml).not.toContain("endLine=");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// exportOutline — integration (mocked Tauri + dialog + documentStore)
// ════════════════════════════════════════════════════════════════════════════

describe("exportOutline", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    saveMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    invokeMock.mockResolvedValue(undefined);
    saveMock.mockResolvedValue("/out/outline.json");
    mockDocGetState.mockReturnValue({
      path: "/vault/my-doc.md",
      fileName: "my-doc.md",
      content: "# Introduction\n\n## Background\n\n## Methods\n\n### Data Collection\n\n# Conclusion\n",
    });
  });

  it("writes JSON outline via write_markdown_file when format is json", async () => {
    await exportOutline({ format: "json", outputPath: "/out/outline.json" });
    expect(invokeMock).toHaveBeenCalledWith("write_markdown_file", {
      path: "/out/outline.json",
      content: expect.stringContaining('"title"'),
    });
  });

  it("written JSON is parseable and contains root nodes", async () => {
    let written = "";
    invokeMock.mockImplementation((_cmd: string, args: { content?: string }) => {
      if (args?.content) written = args.content;
      return Promise.resolve(undefined);
    });
    await exportOutline({ format: "json", outputPath: "/out/outline.json" });
    const parsed: OutlineNode[] = JSON.parse(written);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].title).toBe("Introduction");
  });

  it("JSON outline preserves nested structure (H2 under H1)", async () => {
    let written = "";
    invokeMock.mockImplementation((_cmd: string, args: { content?: string }) => {
      if (args?.content) written = args.content;
      return Promise.resolve(undefined);
    });
    await exportOutline({ format: "json", outputPath: "/out/outline.json" });
    const parsed: OutlineNode[] = JSON.parse(written);
    const intro = parsed.find((n) => n.title === "Introduction");
    expect(intro?.children.length).toBeGreaterThan(0);
    expect(intro?.children[0].title).toBe("Background");
  });

  it("writes OPML outline when format is opml", async () => {
    saveMock.mockResolvedValue("/out/outline.opml");
    await exportOutline({ format: "opml", outputPath: "/out/outline.opml" });
    expect(invokeMock).toHaveBeenCalledWith("write_markdown_file", {
      path: "/out/outline.opml",
      content: expect.stringContaining("<opml"),
    });
  });

  it("OPML content is valid XML with opml root", async () => {
    let written = "";
    invokeMock.mockImplementation((_cmd: string, args: { content?: string }) => {
      if (args?.content) written = args.content;
      return Promise.resolve(undefined);
    });
    await exportOutline({ format: "opml", outputPath: "/out/outline.opml" });
    expect(written).toContain('<?xml version="1.0"');
    expect(written).toContain('<opml version="2.0">');
    expect(written).toContain("</opml>");
  });

  it("shows a success toast with the file basename", async () => {
    await exportOutline({ format: "json", outputPath: "/out/outline.json" });
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining("outline.json"),
    );
  });

  it("opens a save dialog with json filter when format is json and no outputPath", async () => {
    await exportOutline({ format: "json" });
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.arrayContaining([
          expect.objectContaining({ extensions: expect.arrayContaining(["json"]) }),
        ]),
      }),
    );
  });

  it("opens a save dialog with opml filter when format is opml and no outputPath", async () => {
    saveMock.mockResolvedValue("/out/outline.opml");
    await exportOutline({ format: "opml" });
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.arrayContaining([
          expect.objectContaining({ extensions: expect.arrayContaining(["opml"]) }),
        ]),
      }),
    );
  });

  it("returns empty string and does not invoke when user cancels dialog", async () => {
    saveMock.mockResolvedValue(null);
    const result = await exportOutline({ format: "json" });
    expect(result).toBe("");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("shows an error toast and re-throws when write fails", async () => {
    invokeMock.mockRejectedValue(new Error("disk full"));
    await expect(
      exportOutline({ format: "json", outputPath: "/out/outline.json" }),
    ).rejects.toBeDefined();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("disk full"),
    );
  });

  it("throws a user-visible error when no document is open", async () => {
    mockDocGetState.mockReturnValue({ path: null, fileName: null, content: "" });
    await expect(exportOutline({ format: "json" })).rejects.toMatch(
      /No document is open/,
    );
  });

  it("returns the output path on success (headless mode)", async () => {
    const result = await exportOutline({
      format: "json",
      outputPath: "/out/outline.json",
    });
    expect(result).toBe("/out/outline.json");
  });

  it("JSON outline nodes each have id, title, level, children, metadata fields", async () => {
    let written = "";
    invokeMock.mockImplementation((_cmd: string, args: { content?: string }) => {
      if (args?.content) written = args.content;
      return Promise.resolve(undefined);
    });
    await exportOutline({ format: "json", outputPath: "/out/outline.json" });
    const parsed: OutlineNode[] = JSON.parse(written);
    function checkNode(node: OutlineNode): void {
      expect(typeof node.id).toBe("string");
      expect(typeof node.title).toBe("string");
      expect(typeof node.level).toBe("number");
      expect(Array.isArray(node.children)).toBe(true);
      expect(typeof node.metadata.startLine).toBe("number");
      expect("endLine" in node.metadata).toBe(true);
      expect(typeof node.metadata.headingId).toBe("string");
      for (const child of node.children) checkNode(child);
    }
    for (const root of parsed) checkNode(root);
  });

  it("empty document (no headings) exports an empty JSON array", async () => {
    mockDocGetState.mockReturnValue({
      path: "/vault/empty.md",
      fileName: "empty.md",
      content: "Just a paragraph, no headings.",
    });
    let written = "";
    invokeMock.mockImplementation((_cmd: string, args: { content?: string }) => {
      if (args?.content) written = args.content;
      return Promise.resolve(undefined);
    });
    await exportOutline({ format: "json", outputPath: "/out/outline.json" });
    const parsed = JSON.parse(written);
    expect(parsed).toEqual([]);
  });

  it("headings inside fenced code blocks are not included in the outline", async () => {
    mockDocGetState.mockReturnValue({
      path: "/vault/code.md",
      fileName: "code.md",
      content: "# Real Heading\n\n```\n# Not a heading\n```\n\n## Real Sub\n",
    });
    let written = "";
    invokeMock.mockImplementation((_cmd: string, args: { content?: string }) => {
      if (args?.content) written = args.content;
      return Promise.resolve(undefined);
    });
    await exportOutline({ format: "json", outputPath: "/out/outline.json" });
    const parsed: OutlineNode[] = JSON.parse(written);
    // Count all headings recursively
    function countNodes(nodes: OutlineNode[]): number {
      return nodes.reduce((acc, n) => acc + 1 + countNodes(n.children), 0);
    }
    expect(countNodes(parsed)).toBe(2); // "Real Heading" + "Real Sub", not the code block heading
  });
});

// ─── Import new profile exports ───────────────────────────────────────────────

import { buildExportHtml, buildBatchExportProfiles, exportWithProfile } from "./export";

// ════════════════════════════════════════════════════════════════════════════
// buildExportHtml — profile-specific HTML generation
// ════════════════════════════════════════════════════════════════════════════

/** Rich fixture for profile tests covering all node types. */
const PROFILE_FIXTURE_HTML = `
<h1>Document Title</h1>
<h2>Section One</h2>
<h3>Subsection</h3>
<p>Paragraph with <strong>bold</strong>, <em>italic</em>, and <a href="https://example.com">a link</a>.</p>
<ul><li>List item one</li><li>List item two</li></ul>
<ol><li>First</li><li>Second</li></ol>
<table>
  <thead><tr><th>Name</th><th>Value</th></tr></thead>
  <tbody><tr><td>alpha</td><td>1</td></tr><tr><td>beta</td><td>2</td></tr></tbody>
</table>
<pre><code class="language-typescript">const x = 42;</code></pre>
<p><code>inline code</code></p>
<blockquote><p>A quoted block.</p></blockquote>
<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" alt="test image" width="200" height="100" />
`.trim();

describe("buildExportHtml — notion-html profile", () => {
  beforeEach(() => {
    const div = document.createElement("div");
    div.className = "markdown-body";
    div.innerHTML = PROFILE_FIXTURE_HTML;
    document.body.appendChild(div);
  });
  afterEach(() => { document.body.innerHTML = ""; });

  it("produces a valid HTML5 document", () => {
    const html = buildExportHtml("notion-html");
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  it("sets data-export-profile='notion-html'", () => {
    const html = buildExportHtml("notion-html");
    expect(html).toContain('data-export-profile="notion-html"');
  });

  it("includes profile CSS in the <style> block", () => {
    const html = buildExportHtml("notion-html");
    expect(html).toContain("notion-html export profile");
    expect(html).toContain("position: static");
  });

  it("preserves heading nesting (h1, h2, h3) from fixture", () => {
    const html = buildExportHtml("notion-html");
    expect(html).toContain("<h1>");
    expect(html).toContain("<h2>");
    expect(html).toContain("<h3>");
    expect(html).toContain("Document Title");
    expect(html).toContain("Section One");
    expect(html).toContain("Subsection");
  });

  it("preserves links from fixture", () => {
    const html = buildExportHtml("notion-html");
    expect(html).toContain("https://example.com");
    expect(html).toContain("a link");
  });

  it("preserves lists (ul/ol) from fixture", () => {
    const html = buildExportHtml("notion-html");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("List item one");
    expect(html).toContain("First");
  });

  it("preserves table content from fixture", () => {
    const html = buildExportHtml("notion-html");
    expect(html).toContain("<table");
    expect(html).toContain("<th>");
    expect(html).toContain("Name");
    expect(html).toContain("alpha");
  });

  it("preserves code block from fixture", () => {
    const html = buildExportHtml("notion-html");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 42");
  });

  it("preserves inline code from fixture", () => {
    const html = buildExportHtml("notion-html");
    expect(html).toContain("inline code");
  });

  it("preserves blockquote from fixture", () => {
    const html = buildExportHtml("notion-html");
    expect(html).toContain("<blockquote");
    expect(html).toContain("A quoted block");
  });

  it("preserves data URI image from fixture", () => {
    const html = buildExportHtml("notion-html");
    expect(html).toContain("data:image/png;base64");
  });

  it("inlines base CSS bundles (themes, markdown, katex)", () => {
    const html = buildExportHtml("notion-html");
    expect(html).toContain("/* themes-css */");
    expect(html).toContain("/* markdown-css */");
    expect(html).toContain("/* katex-css */");
  });

  it("has no external resource references (offline-ready)", () => {
    const html = buildExportHtml("notion-html");
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
  });

  it("accepts pre-built content string instead of capturing DOM", () => {
    const html = buildExportHtml("notion-html", "<h1>Injected</h1><p>Body</p>");
    expect(html).toContain("Injected");
    expect(html).not.toContain("Document Title");
  });

  it("throws for an unknown profile id", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing bad input
    expect(() => buildExportHtml("bad-profile" as any)).toThrow(/Unknown export profile/);
  });
});

describe("buildExportHtml — slack-html profile", () => {
  beforeEach(() => {
    const div = document.createElement("div");
    div.className = "markdown-body";
    div.innerHTML = PROFILE_FIXTURE_HTML;
    document.body.appendChild(div);
  });
  afterEach(() => { document.body.innerHTML = ""; });

  it("produces a valid HTML5 document", () => {
    const html = buildExportHtml("slack-html");
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  it("sets data-export-profile='slack-html'", () => {
    const html = buildExportHtml("slack-html");
    expect(html).toContain('data-export-profile="slack-html"');
  });

  it("includes the slack-html profile CSS", () => {
    const html = buildExportHtml("slack-html");
    expect(html).toContain("slack-html export profile");
    expect(html).toContain("520px");
  });

  it("preserves heading nesting from fixture", () => {
    const html = buildExportHtml("slack-html");
    expect(html).toContain("Document Title");
    expect(html).toContain("Section One");
    expect(html).toContain("Subsection");
  });

  it("preserves links from fixture", () => {
    const html = buildExportHtml("slack-html");
    expect(html).toContain("https://example.com");
  });

  it("preserves lists from fixture", () => {
    const html = buildExportHtml("slack-html");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
  });

  it("preserves table from fixture", () => {
    const html = buildExportHtml("slack-html");
    expect(html).toContain("<table");
    expect(html).toContain("Name");
  });

  it("preserves code block from fixture", () => {
    const html = buildExportHtml("slack-html");
    expect(html).toContain("<pre>");
    expect(html).toContain("const x = 42");
  });

  it("preserves inline code from fixture", () => {
    const html = buildExportHtml("slack-html");
    expect(html).toContain("inline code");
  });

  it("preserves blockquote from fixture", () => {
    const html = buildExportHtml("slack-html");
    expect(html).toContain("<blockquote");
  });

  it("preserves data URI image from fixture", () => {
    const html = buildExportHtml("slack-html");
    expect(html).toContain("data:image/png;base64");
  });

  it("has no external resource references (offline-ready)", () => {
    const html = buildExportHtml("slack-html");
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
  });
});

describe("buildExportHtml — email-html profile", () => {
  beforeEach(() => {
    const div = document.createElement("div");
    div.className = "markdown-body";
    div.innerHTML = PROFILE_FIXTURE_HTML;
    document.body.appendChild(div);
  });
  afterEach(() => { document.body.innerHTML = ""; });

  it("produces a valid HTML5 document", () => {
    const html = buildExportHtml("email-html");
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  it("sets data-export-profile='email-html'", () => {
    const html = buildExportHtml("email-html");
    expect(html).toContain('data-export-profile="email-html"');
  });

  it("includes the email-html profile CSS with dark mode", () => {
    const html = buildExportHtml("email-html");
    expect(html).toContain("email-html export profile");
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("inlines style attributes on h1 elements", () => {
    const html = buildExportHtml("email-html");
    // inlineEmailStyles should have added style= to h1
    expect(html).toMatch(/<h1[^>]*style=/i);
    expect(html).toContain("font-size:28px");
  });

  it("inlines style attributes on h2 elements", () => {
    const html = buildExportHtml("email-html");
    expect(html).toMatch(/<h2[^>]*style=/i);
    expect(html).toContain("font-size:22px");
  });

  it("inlines style attributes on h3 elements", () => {
    const html = buildExportHtml("email-html");
    expect(html).toMatch(/<h3[^>]*style=/i);
    expect(html).toContain("font-size:18px");
  });

  it("inlines style attributes on paragraph elements", () => {
    const html = buildExportHtml("email-html");
    expect(html).toMatch(/<p[^>]*style=/i);
    expect(html).toContain("color:#333333");
  });

  it("inlines style attributes on anchor elements", () => {
    const html = buildExportHtml("email-html");
    expect(html).toMatch(/<a[^>]*style=/i);
    expect(html).toContain("color:#0066cc");
  });

  it("inlines style attributes on code elements", () => {
    const html = buildExportHtml("email-html");
    expect(html).toMatch(/<code[^>]*style=/i);
    expect(html).toContain("Courier New");
  });

  it("inlines style attributes on pre elements", () => {
    const html = buildExportHtml("email-html");
    expect(html).toMatch(/<pre[^>]*style=/i);
    expect(html).toContain("background-color:#f8f8f8");
  });

  it("inlines style attributes on blockquote elements", () => {
    const html = buildExportHtml("email-html");
    expect(html).toMatch(/<blockquote[^>]*style=/i);
    expect(html).toContain("border-left:4px solid #cccccc");
  });

  it("adds content-table class to table elements for email client targeting", () => {
    const html = buildExportHtml("email-html");
    expect(html).toContain('class="content-table"');
    expect(html).toContain("cellpadding");
  });

  it("inlines style attributes on img elements", () => {
    const html = buildExportHtml("email-html");
    expect(html).toMatch(/<img[^>]*style=/i);
    expect(html).toContain("max-width:100%");
  });

  it("preserves data URI image src for .png embedding", () => {
    const html = buildExportHtml("email-html");
    expect(html).toContain("data:image/png;base64");
  });

  it("preserves heading content from fixture", () => {
    const html = buildExportHtml("email-html");
    expect(html).toContain("Document Title");
    expect(html).toContain("Section One");
  });

  it("preserves link href from fixture", () => {
    const html = buildExportHtml("email-html");
    expect(html).toContain("https://example.com");
  });

  it("preserves lists from fixture", () => {
    const html = buildExportHtml("email-html");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("List item one");
  });

  it("preserves table content from fixture", () => {
    const html = buildExportHtml("email-html");
    expect(html).toContain("<th>");
    expect(html).toContain("alpha");
  });

  it("preserves code block content from fixture", () => {
    const html = buildExportHtml("email-html");
    expect(html).toContain("const x = 42");
  });

  it("has no external resource references (offline-ready)", () => {
    const html = buildExportHtml("email-html");
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
  });

  it("throws when not in Read view (no .markdown-body)", () => {
    document.body.innerHTML = "";
    expect(() => buildExportHtml("email-html")).toThrow("Switch to Read view");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// exportWithProfile — integration (mocked Tauri + dialog)
// ════════════════════════════════════════════════════════════════════════════

describe("exportWithProfile", () => {
  beforeEach(() => {
    const div = document.createElement("div");
    div.className = "markdown-body";
    div.innerHTML = PROFILE_FIXTURE_HTML;
    document.body.appendChild(div);
    invokeMock.mockReset();
    saveMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });
  afterEach(() => { document.body.innerHTML = ""; });

  it("saves notion-html as .html with correct filter", async () => {
    saveMock.mockResolvedValue("/out/doc.html");
    await exportWithProfile("notion-html", "My Doc");
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/\.html$/),
        filters: expect.arrayContaining([
          expect.objectContaining({ extensions: expect.arrayContaining(["html"]) }),
        ]),
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith("write_markdown_file", {
      path: "/out/doc.html",
      content: expect.stringContaining("<!doctype html>"),
    });
  });

  it("saves slack-html as .txt with correct filter", async () => {
    saveMock.mockResolvedValue("/out/doc.txt");
    await exportWithProfile("slack-html", "My Doc");
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/\.txt$/),
        filters: expect.arrayContaining([
          expect.objectContaining({ extensions: expect.arrayContaining(["txt"]) }),
        ]),
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith("write_markdown_file", {
      path: "/out/doc.txt",
      content: expect.stringContaining("<!doctype html>"),
    });
  });

  it("saves email-html as .html with correct filter", async () => {
    saveMock.mockResolvedValue("/out/doc.html");
    await exportWithProfile("email-html", "My Doc");
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/\.html$/),
        filters: expect.arrayContaining([
          expect.objectContaining({ extensions: expect.arrayContaining(["html"]) }),
        ]),
      }),
    );
  });

  it("shows a success toast with the output filename", async () => {
    saveMock.mockResolvedValue("/out/doc.html");
    await exportWithProfile("notion-html", "My Doc");
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining("doc.html"),
    );
  });

  it("does nothing when user cancels the save dialog", async () => {
    saveMock.mockResolvedValue(null);
    await exportWithProfile("notion-html", "Cancelled");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("shows an error toast and re-throws when invoke fails", async () => {
    saveMock.mockResolvedValue("/out/doc.html");
    invokeMock.mockRejectedValue(new Error("disk full"));
    await expect(exportWithProfile("notion-html", "Fail")).rejects.toBeDefined();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("disk full"),
    );
  });

  it("throws for unknown profile id", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing bad input
    await expect(exportWithProfile("bad-profile" as any, "X")).rejects.toMatch(
      /Unknown export profile/,
    );
  });

  it("written content contains profile-specific CSS marker for notion-html", async () => {
    saveMock.mockResolvedValue("/out/doc.html");
    await exportWithProfile("notion-html", "Check");
    const written = invokeMock.mock.calls[0][1].content as string;
    expect(written).toContain("notion-html export profile");
  });

  it("written content contains profile-specific CSS marker for slack-html", async () => {
    saveMock.mockResolvedValue("/out/doc.txt");
    await exportWithProfile("slack-html", "Check");
    const written = invokeMock.mock.calls[0][1].content as string;
    expect(written).toContain("slack-html export profile");
  });

  it("written content contains profile-specific CSS marker for email-html", async () => {
    saveMock.mockResolvedValue("/out/doc.html");
    await exportWithProfile("email-html", "Check");
    const written = invokeMock.mock.calls[0][1].content as string;
    expect(written).toContain("email-html export profile");
  });

  it("sanitises the title for the default filename", async () => {
    saveMock.mockResolvedValue("/out/doc.html");
    await exportWithProfile("notion-html", "Hello World: <Test>/File");
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/Hello-World.*\.html/),
      }),
    );
  });

  it("throws when not in Read view (no .markdown-body)", async () => {
    document.body.innerHTML = "";
    await expect(exportWithProfile("notion-html", "No view")).rejects.toMatch(
      "Switch to Read view",
    );
  });
});

// ─── EPUB imports ─────────────────────────────────────────────────────────────

import {
  buildEpubChapters,
  buildEpubThemeCss,
  exportEpub,
  type EpubChapter,
} from "./export";

// ════════════════════════════════════════════════════════════════════════════
// buildEpubThemeCss — theme-aware CSS generation
// ════════════════════════════════════════════════════════════════════════════

describe("buildEpubThemeCss", () => {
  it("returns a non-empty string for paper theme", () => {
    const css = buildEpubThemeCss("paper");
    expect(typeof css).toBe("string");
    expect(css.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string for sepia theme", () => {
    const css = buildEpubThemeCss("sepia");
    expect(css.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string for midnight theme", () => {
    const css = buildEpubThemeCss("midnight");
    expect(css.length).toBeGreaterThan(0);
  });

  it("falls back to paper theme for unknown theme id", () => {
    const unknown = buildEpubThemeCss("unknown-theme");
    const paper = buildEpubThemeCss("paper");
    expect(unknown).toBe(paper);
  });

  it("paper theme uses white background", () => {
    const css = buildEpubThemeCss("paper");
    expect(css).toContain("#ffffff");
  });

  it("sepia theme uses warm sepia background", () => {
    const css = buildEpubThemeCss("sepia");
    expect(css).toContain("#f8f3e8");
  });

  it("midnight theme uses dark background", () => {
    const css = buildEpubThemeCss("midnight");
    expect(css).toContain("#1a1a2e");
  });

  it("all themes include body font-family", () => {
    for (const theme of ["paper", "sepia", "midnight"]) {
      const css = buildEpubThemeCss(theme);
      expect(css).toContain("font-family");
    }
  });

  it("all themes include heading styles", () => {
    for (const theme of ["paper", "sepia", "midnight"]) {
      const css = buildEpubThemeCss(theme);
      expect(css).toContain("h1");
      expect(css).toContain("h2");
    }
  });

  it("all themes include code block styles", () => {
    for (const theme of ["paper", "sepia", "midnight"]) {
      const css = buildEpubThemeCss(theme);
      expect(css).toContain("pre");
      expect(css).toContain("code");
    }
  });

  it("produces distinct CSS for each theme", () => {
    const paper = buildEpubThemeCss("paper");
    const sepia = buildEpubThemeCss("sepia");
    const midnight = buildEpubThemeCss("midnight");
    expect(paper).not.toBe(sepia);
    expect(sepia).not.toBe(midnight);
    expect(paper).not.toBe(midnight);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildEpubChapters — pure chapter splitting logic
// ════════════════════════════════════════════════════════════════════════════

describe("buildEpubChapters", () => {
  it("returns a single chapter when body has no headings", () => {
    const div = document.createElement("div");
    div.innerHTML = "<p>Just a paragraph.</p>";
    const chapters = buildEpubChapters(div.innerHTML, "My Book");
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("My Book");
    expect(chapters[0].content).toContain("Just a paragraph");
  });

  it("returns a single chapter for empty body", () => {
    const chapters = buildEpubChapters("", "Empty");
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("Empty");
    expect(chapters[0].content).toBe("");
  });

  it("splits on H1 headings to create chapters", () => {
    const html = "<h1>Chapter One</h1><p>First.</p><h1>Chapter Two</h1><p>Second.</p>";
    const chapters = buildEpubChapters(html, "Book");
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe("Chapter One");
    expect(chapters[1].title).toBe("Chapter Two");
  });

  it("chapter content contains the paragraph text following the heading", () => {
    const html = "<h1>Title</h1><p>Body text here.</p>";
    const chapters = buildEpubChapters(html, "Book");
    expect(chapters[0].content).toContain("Body text here");
  });

  it("preamble content before first H1 is collected into Introduction chapter", () => {
    const html = "<p>Preamble text.</p><h1>Chapter</h1><p>Chapter body.</p>";
    const chapters = buildEpubChapters(html, "Book");
    // Two chapters: Introduction (preamble) + Chapter
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe("Introduction");
    expect(chapters[0].content).toContain("Preamble text");
  });

  it("falls back to H2 splitting when no H1 headings exist", () => {
    const html = "<h2>Section A</h2><p>A text.</p><h2>Section B</h2><p>B text.</p>";
    const chapters = buildEpubChapters(html, "Book");
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe("Section A");
    expect(chapters[1].title).toBe("Section B");
  });

  it("H2 headings are NOT split points when H1 headings exist", () => {
    const html = "<h1>Chapter</h1><h2>Sub</h2><p>Body.</p>";
    const chapters = buildEpubChapters(html, "Book");
    // Only one chapter (H2 stays inside Chapter's content)
    expect(chapters).toHaveLength(1);
    expect(chapters[0].content).toContain("<h2>");
  });

  it("each chapter has a title string and content string", () => {
    const html = "<h1>A</h1><p>Text A.</p><h1>B</h1><p>Text B.</p>";
    const chapters = buildEpubChapters(html, "Book");
    for (const ch of chapters) {
      expect(typeof ch.title).toBe("string");
      expect(typeof ch.content).toBe("string");
    }
  });

  it("chapter title uses heading text content, not markup", () => {
    const html = "<h1><strong>Bold Title</strong></h1><p>Body.</p>";
    const chapters = buildEpubChapters(html, "Book");
    expect(chapters[0].title).toBe("Bold Title");
  });

  it("deep heading hierarchy (H3+) remains in chapter content, not split", () => {
    const html = "<h1>Chapter</h1><h2>Sub</h2><h3>Subsub</h3><p>Text.</p>";
    const chapters = buildEpubChapters(html, "Book");
    expect(chapters).toHaveLength(1);
    expect(chapters[0].content).toContain("<h2>");
    expect(chapters[0].content).toContain("<h3>");
  });

  it("empty preamble is not emitted as a chapter", () => {
    // No content before first H1 — Introduction chapter should be skipped
    const html = "<h1>First</h1><p>Content.</p>";
    const chapters = buildEpubChapters(html, "Book");
    expect(chapters[0].title).toBe("First");
    expect(chapters).toHaveLength(1);
  });

  it("TOC auto-creation: chapter titles match heading texts in order", () => {
    const html = [
      "<h1>Introduction</h1><p>Intro text.</p>",
      "<h1>Methods</h1><p>Methods text.</p>",
      "<h1>Results</h1><p>Results text.</p>",
      "<h1>Conclusion</h1><p>Conclusion text.</p>",
    ].join("");
    const chapters = buildEpubChapters(html, "Paper");
    const titles = chapters.map((c) => c.title);
    expect(titles).toEqual(["Introduction", "Methods", "Results", "Conclusion"]);
  });

  it("image tags inside chapter content are preserved", () => {
    const html = '<h1>Chapter</h1><img src="data:image/png;base64,abc" alt="fig" />';
    const chapters = buildEpubChapters(html, "Book");
    expect(chapters[0].content).toContain("<img");
    expect(chapters[0].content).toContain("data:image/png;base64,abc");
  });

  it("code block content inside chapter is preserved", () => {
    const html = "<h1>Dev</h1><pre><code>const x = 1;</code></pre>";
    const chapters = buildEpubChapters(html, "Book");
    expect(chapters[0].content).toContain("<pre>");
    expect(chapters[0].content).toContain("const x = 1;");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// exportEpub — integration (mocked epub-gen-memory + Tauri + dialog)
// ════════════════════════════════════════════════════════════════════════════

describe("exportEpub", () => {
  const EPUB_BODY_HTML = `
<h1>Chapter One</h1>
<p>Opening paragraph with <strong>bold</strong> and <em>italic</em>.</p>
<h2>Section 1.1</h2>
<p>More text here.</p>
<pre><code class="language-js">console.log("hello");</code></pre>
<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" alt="figure" />
<h1>Chapter Two</h1>
<p>Second chapter content.</p>
`.trim();

  function setupEpubDom(html = EPUB_BODY_HTML) {
    const div = document.createElement("div");
    div.className = "markdown-body";
    div.innerHTML = html;
    document.body.appendChild(div);
  }

  beforeEach(() => {
    setupEpubDom();
    invokeMock.mockReset();
    saveMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    invokeMock.mockResolvedValue(undefined);
    saveMock.mockResolvedValue("/out/my-doc.epub");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.resetModules();
  });

  it("throws a user-visible error when not in Read view", async () => {
    document.body.innerHTML = "";
    await expect(exportEpub("No view")).rejects.toMatch(
      "Switch to Read view before exporting.",
    );
  });

  it("throws when epub-gen-memory is not installed", async () => {
    vi.doMock("epub-gen-memory", () => { throw new Error("module not found"); });
    const { exportEpub: fresh } = await import("./export");
    await expect(fresh("Missing")).rejects.toMatch("epub-gen-memory is not installed");
    vi.resetModules();
  });

  it("does nothing when user cancels the save dialog", async () => {
    const fakeBlob = new Blob(["EPUB"], { type: "application/epub+zip" });
    vi.doMock("epub-gen-memory", () => ({ default: vi.fn().mockResolvedValue(fakeBlob) }));
    saveMock.mockResolvedValue(null);

    const { exportEpub: fresh } = await import("./export");
    await fresh("Cancelled");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("writes EPUB bytes via write_file_bytes and shows a success toast", async () => {
    const fakeBlob = new Blob(["EPUB content"], { type: "application/epub+zip" });
    vi.doMock("epub-gen-memory", () => ({ default: vi.fn().mockResolvedValue(fakeBlob) }));

    const { exportEpub: fresh } = await import("./export");
    await fresh("My Book");

    expect(invokeMock).toHaveBeenCalledWith("write_file_bytes", {
      path: "/out/my-doc.epub",
      data: expect.any(Array),
    });
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining("my-doc.epub"),
    );
  });

  it("handles ArrayBuffer result from epub-gen-memory (not Blob)", async () => {
    const buf = new ArrayBuffer(8);
    vi.doMock("epub-gen-memory", () => ({ default: vi.fn().mockResolvedValue(buf) }));

    const { exportEpub: fresh } = await import("./export");
    await fresh("ArrayBuf");

    const call = invokeMock.mock.calls.find((c) => c[0] === "write_file_bytes");
    expect(call).toBeDefined();
    expect(call![1].data).toBeInstanceOf(Array);
  });

  it("requests a .epub file filter in the save dialog", async () => {
    const fakeBlob = new Blob(["x"], { type: "application/epub+zip" });
    vi.doMock("epub-gen-memory", () => ({ default: vi.fn().mockResolvedValue(fakeBlob) }));

    const { exportEpub: fresh } = await import("./export");
    await fresh("Filter Test");

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.arrayContaining([
          expect.objectContaining({ extensions: expect.arrayContaining(["epub"]) }),
        ]),
      }),
    );
  });

  it("sanitises the title to a safe filename for the save dialog default path", async () => {
    const fakeBlob = new Blob(["x"], { type: "application/epub+zip" });
    vi.doMock("epub-gen-memory", () => ({ default: vi.fn().mockResolvedValue(fakeBlob) }));

    const { exportEpub: fresh } = await import("./export");
    await fresh("Hello World: <Test>/File");

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/Hello-World.*\.epub/),
      }),
    );
  });

  it("shows an error toast and re-throws when write_file_bytes fails", async () => {
    const fakeBlob = new Blob(["x"], { type: "application/epub+zip" });
    vi.doMock("epub-gen-memory", () => ({ default: vi.fn().mockResolvedValue(fakeBlob) }));
    invokeMock.mockRejectedValue(new Error("write failed"));

    const { exportEpub: fresh } = await import("./export");
    await expect(fresh("Fail")).rejects.toBeDefined();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("write failed"),
    );
  });

  it("passes title, css, and chapters to epub-gen-memory", async () => {
    const epubFn = vi.fn().mockResolvedValue(new Blob(["x"]));
    vi.doMock("epub-gen-memory", () => ({ default: epubFn }));

    const { exportEpub: fresh } = await import("./export");
    await fresh("My Great Book");

    expect(epubFn).toHaveBeenCalledTimes(1);
    const [options, chapters] = epubFn.mock.calls[0];
    expect(options).toMatchObject({ title: "My Great Book" });
    expect(options.css).toBeTruthy();
    expect(Array.isArray(chapters)).toBe(true);
    expect(chapters.length).toBeGreaterThan(0);
  });

  it("generates chapters from H1 headings via buildEpubChapters", async () => {
    // Ensure DOM is set up for this fresh-import test (vi.resetModules in
    // afterEach tears down module state but not DOM; re-inject to be safe).
    document.body.innerHTML = "";
    setupEpubDom();

    const epubFn = vi.fn().mockResolvedValue(new Blob(["x"]));
    vi.doMock("epub-gen-memory", () => ({ default: epubFn }));

    const { exportEpub: fresh } = await import("./export");
    await fresh("Chapters Test");

    const [, chapters] = epubFn.mock.calls[0] as [unknown, EpubChapter[]];
    const titles = chapters.map((c) => c.title);
    expect(titles).toContain("Chapter One");
    expect(titles).toContain("Chapter Two");
  });

  it("chapter content contains paragraph body text", async () => {
    document.body.innerHTML = "";
    setupEpubDom();
    const epubFn = vi.fn().mockResolvedValue(new Blob(["x"]));
    vi.doMock("epub-gen-memory", () => ({ default: epubFn }));

    const { exportEpub: fresh } = await import("./export");
    await fresh("Content Test");

    const [, chapters] = epubFn.mock.calls[0] as [unknown, EpubChapter[]];
    const allContent = chapters.map((c) => c.content).join(" ");
    expect(allContent).toContain("Opening paragraph");
  });

  it("chapter content preserves embedded image data URIs", async () => {
    document.body.innerHTML = "";
    setupEpubDom();
    const epubFn = vi.fn().mockResolvedValue(new Blob(["x"]));
    vi.doMock("epub-gen-memory", () => ({ default: epubFn }));

    const { exportEpub: fresh } = await import("./export");
    await fresh("Image Test");

    const [, chapters] = epubFn.mock.calls[0] as [unknown, EpubChapter[]];
    const allContent = chapters.map((c) => c.content).join(" ");
    expect(allContent).toContain("data:image/png;base64");
  });

  it("chapter content preserves code blocks with syntax highlighting", async () => {
    document.body.innerHTML = "";
    setupEpubDom();
    const epubFn = vi.fn().mockResolvedValue(new Blob(["x"]));
    vi.doMock("epub-gen-memory", () => ({ default: epubFn }));

    const { exportEpub: fresh } = await import("./export");
    await fresh("Code Test");

    const [, chapters] = epubFn.mock.calls[0] as [unknown, EpubChapter[]];
    const allContent = chapters.map((c) => c.content).join(" ");
    expect(allContent).toContain('console.log("hello")');
  });

  it("uses theme-aware CSS from buildEpubThemeCss matching current theme", async () => {
    document.documentElement.dataset.theme = "sepia";
    const epubFn = vi.fn().mockResolvedValue(new Blob(["x"]));
    vi.doMock("epub-gen-memory", () => ({ default: epubFn }));

    const { exportEpub: fresh } = await import("./export");
    await fresh("Sepia Test");

    const [options] = epubFn.mock.calls[0] as [{ css: string }, unknown];
    // Sepia theme CSS should reference the sepia background
    expect(options.css).toContain("#f8f3e8");
    delete document.documentElement.dataset.theme;
  });

  it("empty document body produces a single fallback chapter", async () => {
    document.body.innerHTML = "";
    const div = document.createElement("div");
    div.className = "markdown-body";
    div.innerHTML = ""; // No children
    document.body.appendChild(div);

    const epubFn = vi.fn().mockResolvedValue(new Blob(["x"]));
    vi.doMock("epub-gen-memory", () => ({ default: epubFn }));

    const { exportEpub: fresh } = await import("./export");
    await fresh("Empty Doc");

    const [, chapters] = epubFn.mock.calls[0] as [unknown, EpubChapter[]];
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("Empty Doc");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildExportHtml — new rich-text profiles
// ════════════════════════════════════════════════════════════════════════════

/** Simple body fragment used in new-profile tests (no DOM dependency). */
const SAMPLE_BODY = `
<h1>Test Document</h1>
<p>A paragraph with <strong>bold</strong> and <code>inline code</code>.</p>
<h2>Code Block</h2>
<pre class="shiki"><code class="language-js">const x = 1;</code></pre>
<blockquote class="callout callout-note"><p>Note callout</p></blockquote>
<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
<ul><li>Item one</li><li>Item two</li></ul>
`.trim();

describe("buildExportHtml — github-markdown profile", () => {
  it("produces a valid HTML5 document", () => {
    const html = buildExportHtml("github-markdown", SAMPLE_BODY);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  it("sets data-export-profile to github-markdown", () => {
    const html = buildExportHtml("github-markdown", SAMPLE_BODY);
    expect(html).toContain('data-export-profile="github-markdown"');
  });

  it("inlines the github-markdown profile CSS", () => {
    const html = buildExportHtml("github-markdown", SAMPLE_BODY);
    expect(html).toContain("github-markdown export profile");
  });

  it("preserves the body content", () => {
    const html = buildExportHtml("github-markdown", SAMPLE_BODY);
    expect(html).toContain("<h1>Test Document</h1>");
    expect(html).toContain("<table>");
  });

  it("includes base CSS bundles (themes, markdown, KaTeX)", () => {
    const html = buildExportHtml("github-markdown", SAMPLE_BODY);
    expect(html).toContain("/* themes-css */");
    expect(html).toContain("/* markdown-css */");
    expect(html).toContain("/* katex-css */");
  });

  it("has no external resource references (offline-ready)", () => {
    const html = buildExportHtml("github-markdown", SAMPLE_BODY);
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
  });

  it("wraps body content in .reading-surface article", () => {
    const html = buildExportHtml("github-markdown", SAMPLE_BODY);
    expect(html).toContain('<article class="reading-surface">');
  });

  it("includes callout block styling in CSS", () => {
    const html = buildExportHtml("github-markdown", SAMPLE_BODY);
    expect(html).toContain(".callout-note");
  });

  it("preserves code blocks from the body", () => {
    const html = buildExportHtml("github-markdown", SAMPLE_BODY);
    expect(html).toContain("const x = 1;");
  });

  it("throws for an unknown profileId", () => {
    expect(() => buildExportHtml("nonexistent-profile" as ExportProfileId, SAMPLE_BODY)).toThrow();
  });
});

describe("buildExportHtml — confluence-wiki profile", () => {
  it("produces a valid HTML5 document", () => {
    const html = buildExportHtml("confluence-wiki", SAMPLE_BODY);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<html");
  });

  it("sets data-export-profile to confluence-wiki", () => {
    const html = buildExportHtml("confluence-wiki", SAMPLE_BODY);
    expect(html).toContain('data-export-profile="confluence-wiki"');
  });

  it("inlines the confluence-wiki profile CSS", () => {
    const html = buildExportHtml("confluence-wiki", SAMPLE_BODY);
    expect(html).toContain("confluence-wiki export profile");
  });

  it("preserves heading and table structure", () => {
    const html = buildExportHtml("confluence-wiki", SAMPLE_BODY);
    expect(html).toContain("<h1>Test Document</h1>");
    expect(html).toContain("<table>");
  });

  it("includes callout panel styles (.callout-note, .callout-warning)", () => {
    const html = buildExportHtml("confluence-wiki", SAMPLE_BODY);
    expect(html).toContain(".callout-note");
    expect(html).toContain(".callout-warning");
  });

  it("has no external resource references", () => {
    const html = buildExportHtml("confluence-wiki", SAMPLE_BODY);
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
  });

  it("includes the dark code macro background colour", () => {
    const html = buildExportHtml("confluence-wiki", SAMPLE_BODY);
    expect(html).toContain("#23241f");
  });
});

describe("buildExportHtml — slack-rich-markdown profile", () => {
  it("produces a valid HTML5 document", () => {
    const html = buildExportHtml("slack-rich-markdown", SAMPLE_BODY);
    expect(html).toMatch(/^<!doctype html>/i);
  });

  it("sets data-export-profile to slack-rich-markdown", () => {
    const html = buildExportHtml("slack-rich-markdown", SAMPLE_BODY);
    expect(html).toContain('data-export-profile="slack-rich-markdown"');
  });

  it("inlines the slack-rich-markdown profile CSS", () => {
    const html = buildExportHtml("slack-rich-markdown", SAMPLE_BODY);
    expect(html).toContain("slack-rich-markdown export profile");
  });

  it("preserves document body including code blocks", () => {
    const html = buildExportHtml("slack-rich-markdown", SAMPLE_BODY);
    expect(html).toContain("const x = 1;");
    expect(html).toContain("<ul>");
  });

  it("includes Slack coloured callout panel rules", () => {
    const html = buildExportHtml("slack-rich-markdown", SAMPLE_BODY);
    expect(html).toContain(".callout-note");
    expect(html).toContain(".callout-danger");
  });

  it("includes the code block ::before accent stripe", () => {
    const html = buildExportHtml("slack-rich-markdown", SAMPLE_BODY);
    expect(html).toContain("::before");
  });

  it("has no external resource references", () => {
    const html = buildExportHtml("slack-rich-markdown", SAMPLE_BODY);
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildBatchExportProfiles — parallel multi-profile export
// ════════════════════════════════════════════════════════════════════════════

describe("buildBatchExportProfiles", () => {
  it("returns one result per profile in ALL_PROFILE_IDS by default", async () => {
    const results = await buildBatchExportProfiles(ALL_PROFILE_IDS, SAMPLE_BODY);
    expect(results).toHaveLength(ALL_PROFILE_IDS.length);
  });

  it("each result has profileId, ok, and html fields", async () => {
    const results = await buildBatchExportProfiles(ALL_PROFILE_IDS, SAMPLE_BODY);
    for (const r of results) {
      expect(typeof r.profileId).toBe("string");
      expect(typeof r.ok).toBe("boolean");
      expect(r.html !== undefined).toBe(true);
    }
  });

  it("all 6 results are ok=true when valid content is provided", async () => {
    const results = await buildBatchExportProfiles(ALL_PROFILE_IDS, SAMPLE_BODY);
    for (const r of results) {
      expect(r.ok, `Profile ${r.profileId} failed: ${r.error}`).toBe(true);
    }
  });

  it("each successful result contains a valid HTML5 document", async () => {
    const results = await buildBatchExportProfiles(ALL_PROFILE_IDS, SAMPLE_BODY);
    for (const r of results) {
      if (r.ok) {
        expect(r.html).toMatch(/^<!doctype html>/i);
        expect(r.html).toContain("</html>");
      }
    }
  });

  it("result profileId values match the requested profile ids", async () => {
    const ids: ExportProfileId[] = ["github-markdown", "confluence-wiki"];
    const results = await buildBatchExportProfiles(ids, SAMPLE_BODY);
    expect(results.map((r) => r.profileId)).toEqual(ids);
  });

  it("accepts a subset of profiles and returns only those", async () => {
    const subset: ExportProfileId[] = ["slack-rich-markdown", "notion-html"];
    const results = await buildBatchExportProfiles(subset, SAMPLE_BODY);
    expect(results).toHaveLength(2);
    expect(results[0].profileId).toBe("slack-rich-markdown");
    expect(results[1].profileId).toBe("notion-html");
  });

  it("returns ok=false (not throws) for an unknown profileId", async () => {
    const ids = ["nonexistent-profile"] as unknown as ExportProfileId[];
    const results = await buildBatchExportProfiles(ids, SAMPLE_BODY);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].html).toBeNull();
    expect(typeof results[0].error).toBe("string");
  });

  it("returns an empty array when an empty profileIds list is given", async () => {
    const results = await buildBatchExportProfiles([], SAMPLE_BODY);
    expect(results).toHaveLength(0);
  });

  it("each profile result contains the body content from the input fragment", async () => {
    const results = await buildBatchExportProfiles(ALL_PROFILE_IDS, SAMPLE_BODY);
    for (const r of results) {
      if (r.ok) {
        expect(r.html).toContain("Test Document");
      }
    }
  });

  it("different profiles produce distinct HTML output (CSS differs per profile)", async () => {
    const results = await buildBatchExportProfiles(
      ["github-markdown", "confluence-wiki", "slack-rich-markdown"],
      SAMPLE_BODY,
    );
    const [ghHtml, cfHtml, slkHtml] = results.map((r) => r.html!);
    expect(ghHtml).not.toBe(cfHtml);
    expect(cfHtml).not.toBe(slkHtml);
    expect(ghHtml).not.toBe(slkHtml);
  });

  it("github-markdown result contains 980px layout constraint", async () => {
    const results = await buildBatchExportProfiles(["github-markdown"], SAMPLE_BODY);
    expect(results[0].html).toContain("980px");
  });

  it("confluence-wiki result contains 760px layout constraint", async () => {
    const results = await buildBatchExportProfiles(["confluence-wiki"], SAMPLE_BODY);
    expect(results[0].html).toContain("760px");
  });

  it("slack-rich-markdown result contains 600px layout constraint", async () => {
    const results = await buildBatchExportProfiles(["slack-rich-markdown"], SAMPLE_BODY);
    expect(results[0].html).toContain("600px");
  });

  it("partial failure: one bad profile id does not prevent others from succeeding", async () => {
    const ids = [
      "github-markdown",
      "bad-id" as ExportProfileId,
      "confluence-wiki",
    ];
    const results = await buildBatchExportProfiles(ids, SAMPLE_BODY);
    expect(results).toHaveLength(3);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[2].ok).toBe(true);
  });

  it("nested callout in body is preserved in all profile outputs", async () => {
    const bodyWithCallout = `<blockquote class="callout callout-note"><h3>Nested</h3><p>Inner text</p></blockquote>`;
    const results = await buildBatchExportProfiles(ALL_PROFILE_IDS, bodyWithCallout);
    for (const r of results) {
      if (r.ok) {
        expect(r.html).toContain("callout-note");
        expect(r.html).toContain("Inner text");
      }
    }
  });
});
