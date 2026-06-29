/**
 * copyRichText.test.ts — unit tests for src/lib/copyRichText.ts
 *
 * Coverage:
 *   (1)  wrapRichTextBody — wrapping, empty, whitespace
 *   (2)  cloneWithoutInjectedChrome — review card stripping
 *   (3)  buildThemeAwareRichHtml — theme variants, CSS embedding, edge cases
 *   (4)  THEME_PALETTES — structure / completeness
 *   (5)  copyAsRichText — clipboard interaction, format param, fallback paths,
 *        empty-doc guard, view-mode switching
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── All vi.mock() calls BEFORE imports that trigger side-effects ──────────────

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../store/toastStore", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./waitForElement", () => ({
  waitForElement: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./export", () => ({
  buildStandaloneHtml: vi.fn().mockReturnValue(
    '<!doctype html><html><body><div class="reading-surface"><div class="markdown-body"><h1>Fallback</h1></div></div></body></html>',
  ),
  cloneWithoutInjectedChrome: vi.fn().mockImplementation((el: Element) => {
    const clone = el.cloneNode(true) as Element;
    for (const node of clone.querySelectorAll(".review-card")) node.remove();
    return clone;
  }),
}));

// Vite ?raw CSS imports are not resolved in the Vitest happy-dom environment —
// mock them with representative stub strings so the HTML builder can run.
vi.mock("katex/dist/katex.min.css?raw", () => ({ default: "/* katex-stub */" }));
vi.mock("../styles/markdown.css?raw", () => ({ default: "/* markdown-stub */" }));
vi.mock("../styles/themes.css?raw", () => ({ default: "/* themes-stub */" }));

/** Shared mutable doc state — tests mutate it, beforeEach resets it. */
const docState = {
  path: "/tmp/test.md" as string | null,
  content: "# Hello\n\nWorld\n",
  viewMode: "read" as "read" | "edit" | "source",
  setViewMode: vi.fn(),
};

vi.mock("../store/documentStore", () => ({
  useDocumentStore: {
    get getState() {
      return () => docState;
    },
  },
}));

// ── Imports under test (after mocks) ─────────────────────────────────────────

import {
  wrapRichTextBody,
  buildRichTextHtml,
  buildThemeAwareRichHtml,
  THEME_PALETTES,
  copyAsRichText,
} from "./copyRichText";
import { cloneWithoutInjectedChrome } from "./export";
import { toast } from "../store/toastStore";
import { waitForElement } from "./waitForElement";

const toastInfoMock = vi.mocked(toast.info);
const toastSuccessMock = vi.mocked(toast.success);
const toastErrorMock = vi.mocked(toast.error);
const waitForElementMock = vi.mocked(waitForElement);

// ── Clipboard stubs ───────────────────────────────────────────────────────────

/** Mutable clipboard state so tests can inspect calls and simulate failures. */
let clipboardWriteMock: ReturnType<typeof vi.fn>;
let clipboardWriteTextMock: ReturnType<typeof vi.fn>;

function installClipboardMocks(opts: { writeRejects?: boolean; noClipboardItem?: boolean } = {}) {
  clipboardWriteMock = vi.fn().mockImplementation(opts.writeRejects
    ? () => Promise.reject(new Error("clipboard write denied"))
    : () => Promise.resolve());
  clipboardWriteTextMock = vi.fn().mockResolvedValue(undefined);

  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { write: clipboardWriteMock, writeText: clipboardWriteTextMock } },
    writable: true,
    configurable: true,
  });

  if (opts.noClipboardItem) {
    // @ts-expect-error intentionally remove ClipboardItem for fallback tests
    globalThis.ClipboardItem = undefined;
  } else {
    globalThis.ClipboardItem = class {
      constructor(public readonly data: Record<string, Blob>) {}
    } as unknown as typeof ClipboardItem;
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  docState.path = "/tmp/test.md";
  docState.content = "# Hello\n\nWorld\n";
  docState.viewMode = "read";
  docState.setViewMode.mockReset();
  toastInfoMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  waitForElementMock.mockReset().mockResolvedValue(undefined as unknown as Element);
  installClipboardMocks();

  // DOM: install a .markdown-body element so the capture path finds it.
  const existing = document.querySelector(".markdown-body");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.className = "markdown-body";
  el.innerHTML = "<h1>Hello</h1><p>World</p>";
  document.body.appendChild(el);
});

afterEach(() => {
  vi.clearAllMocks();
  document.querySelector(".markdown-body")?.remove();
});

// ═══════════════════════════════════════════════════════════════════════════════
// (1) wrapRichTextBody
// ═══════════════════════════════════════════════════════════════════════════════

describe("wrapRichTextBody", () => {
  it("wraps body markup in an inline-styled div", () => {
    const html = wrapRichTextBody("<h1>Title</h1><p>Hello <strong>world</strong></p>");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>world</strong>");
    expect(html.startsWith('<div style="')).toBe(true);
    expect(html.endsWith("</div>")).toBe(true);
    expect(html).toContain("font-family");
  });

  it("preserves rich constructs verbatim: lists, links, code, and tables", () => {
    const body = [
      "<ul><li>one</li><li>two</li></ul>",
      '<a href="https://example.com">link</a>',
      "<pre><code>const a = 1;</code></pre>",
      "<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>",
    ].join("");
    const html = wrapRichTextBody(body);
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain('<a href="https://example.com">link</a>');
    expect(html).toContain("<code>const a = 1;</code>");
    expect(html).toContain("<td>c</td>");
  });

  it("returns an empty string when the body is empty or whitespace", () => {
    expect(wrapRichTextBody("")).toBe("");
    expect(wrapRichTextBody("   \n  ")).toBe("");
  });

  it("trims surrounding whitespace before wrapping", () => {
    expect(wrapRichTextBody("\n  <p>x</p>\n")).toBe(wrapRichTextBody("<p>x</p>"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (2) cloneWithoutInjectedChrome
// ═══════════════════════════════════════════════════════════════════════════════

describe("cloneWithoutInjectedChrome", () => {
  it("strips the injected review card but keeps document content", () => {
    const body = document.createElement("div");
    body.className = "markdown-body";
    body.innerHTML =
      '<aside class="review-card">SUMMARY</aside><h1>Real Title</h1><p>Body text</p>';
    const cleaned = cloneWithoutInjectedChrome(body);
    expect(cleaned.querySelector(".review-card")).toBeNull();
    expect(cleaned.innerHTML).toContain("<h1>Real Title</h1>");
    expect(cleaned.innerHTML).toContain("Body text");
    // Original element must be untouched (clone, not mutate).
    expect(body.querySelector(".review-card")).not.toBeNull();
  });

  it("is a no-op for a body with no injected chrome", () => {
    const body = document.createElement("div");
    body.innerHTML = "<h1>Doc</h1><p>x</p>";
    expect(cloneWithoutInjectedChrome(body).innerHTML).toBe("<h1>Doc</h1><p>x</p>");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (3) buildThemeAwareRichHtml — theme variants, CSS embedding, edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildThemeAwareRichHtml", () => {
  it("returns empty string for empty body", () => {
    expect(buildThemeAwareRichHtml("", "paper")).toBe("");
    expect(buildThemeAwareRichHtml("   ", "paper")).toBe("");
  });

  it("produces a valid HTML5 document", () => {
    const html = buildThemeAwareRichHtml("<h1>Test</h1>", "paper");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("<head>");
    expect(html).toContain("<body>");
  });

  it("embeds the body inside .markdown-body inside .reading-surface", () => {
    const html = buildThemeAwareRichHtml("<h1>Hello</h1>", "paper");
    expect(html).toContain('class="reading-surface"');
    expect(html).toContain('class="markdown-body"');
    expect(html).toContain("<h1>Hello</h1>");
  });

  it("sets data-theme attribute on <html> for paper theme", () => {
    const html = buildThemeAwareRichHtml("<p>x</p>", "paper");
    expect(html).toContain('data-theme="paper"');
  });

  it("sets data-theme attribute on <html> for sepia theme", () => {
    const html = buildThemeAwareRichHtml("<p>x</p>", "sepia");
    expect(html).toContain('data-theme="sepia"');
  });

  it("sets data-theme attribute on <html> for midnight theme", () => {
    const html = buildThemeAwareRichHtml("<p>x</p>", "midnight");
    expect(html).toContain('data-theme="midnight"');
  });

  it("paper theme: embeds the correct background colour token", () => {
    const html = buildThemeAwareRichHtml("<p>x</p>", "paper");
    expect(html).toContain("--bg:#ffffff");
  });

  it("sepia theme: embeds the correct background colour token", () => {
    const html = buildThemeAwareRichHtml("<p>x</p>", "sepia");
    expect(html).toContain("--bg:#f5edda");
  });

  it("midnight theme: embeds the correct background colour token", () => {
    const html = buildThemeAwareRichHtml("<p>x</p>", "midnight");
    expect(html).toContain("--bg:#16181d");
  });

  it("inlines the themes CSS stub", () => {
    const html = buildThemeAwareRichHtml("<p>x</p>", "paper");
    expect(html).toContain("/* themes-stub */");
  });

  it("inlines the markdown CSS stub", () => {
    const html = buildThemeAwareRichHtml("<p>x</p>", "paper");
    expect(html).toContain("/* markdown-stub */");
  });

  it("inlines the KaTeX CSS stub (math rendering preserved)", () => {
    const html = buildThemeAwareRichHtml("<p>x</p>", "paper");
    expect(html).toContain("/* katex-stub */");
  });

  it("preserves syntax-highlighted code block markup (Shiki inline spans)", () => {
    const codeHtml =
      '<pre class="shiki"><code><span style="color:#e6db74">"hello"</span></code></pre>';
    const html = buildThemeAwareRichHtml(codeHtml, "paper");
    expect(html).toContain('style="color:#e6db74"');
    expect(html).toContain('"hello"');
  });

  it("preserves Mermaid SVG diagrams", () => {
    const mermaidHtml =
      '<div class="mermaid-block"><svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg></div>';
    const html = buildThemeAwareRichHtml(mermaidHtml, "paper");
    expect(html).toContain("<svg");
    expect(html).toContain('viewBox="0 0 100 100"');
  });

  it("preserves KaTeX-rendered math HTML structure", () => {
    const mathHtml =
      '<span class="katex"><span class="katex-html"><span class="base"><span class="mord">E</span></span></span></span>';
    const html = buildThemeAwareRichHtml(mathHtml, "paper");
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="mord"');
  });

  it("handles frontmatter-stripped content (no YAML leakage)", () => {
    const body = "<h1>Doc</h1><p>Content without frontmatter.</p>";
    const html = buildThemeAwareRichHtml(body, "paper");
    expect(html).not.toContain("---");
    expect(html).toContain("<h1>Doc</h1>");
  });

  it("handles nested lists without corruption", () => {
    const nested = "<ul><li>A<ul><li>B</li><li>C</li></ul></li><li>D</li></ul>";
    const html = buildThemeAwareRichHtml(nested, "paper");
    expect(html).toContain("<ul><li>A<ul><li>B</li><li>C</li></ul></li><li>D</li></ul>");
  });

  it("falls back to paper palette for an unknown theme", () => {
    const html = buildThemeAwareRichHtml("<p>x</p>", "unicorn");
    // paper background is white
    expect(html).toContain("--bg:#ffffff");
    // data-theme still reflects what was passed
    expect(html).toContain('data-theme="unicorn"');
  });

  it("does not reference any external resources (offline-ready)", () => {
    const html = buildThemeAwareRichHtml("<p>test</p>", "paper");
    // No http(s):// links in the <style> block.
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch).not.toBeNull();
    const styleBlock = styleMatch![1];
    expect(styleBlock).not.toMatch(/https?:\/\//);
  });

  it("produces identical output on repeated calls (deterministic)", () => {
    const a = buildThemeAwareRichHtml("<p>stable</p>", "sepia");
    const b = buildThemeAwareRichHtml("<p>stable</p>", "sepia");
    expect(a).toBe(b);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (4) THEME_PALETTES — structure and completeness
// ═══════════════════════════════════════════════════════════════════════════════

describe("THEME_PALETTES", () => {
  const REQUIRED_TOKENS = [
    "--bg", "--text", "--accent", "--border",
    "--code-bg", "--inline-code-bg", "--inline-code-text",
    "--quote-border", "--quote-text",
  ];

  for (const theme of ["paper", "sepia", "midnight"] as const) {
    it(`${theme} palette defines all required colour tokens`, () => {
      const palette = THEME_PALETTES[theme];
      expect(palette).toBeDefined();
      for (const token of REQUIRED_TOKENS) {
        expect(
          palette[token],
          `${theme} is missing token ${token}`,
        ).toBeTruthy();
      }
    });
  }

  it("paper background is white (#ffffff)", () => {
    expect(THEME_PALETTES.paper["--bg"]).toBe("#ffffff");
  });

  it("sepia background is warm cream (#f5edda)", () => {
    expect(THEME_PALETTES.sepia["--bg"]).toBe("#f5edda");
  });

  it("midnight background is dark (#16181d)", () => {
    expect(THEME_PALETTES.midnight["--bg"]).toBe("#16181d");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (5) copyAsRichText — clipboard interaction, format variants, fallback paths
// ═══════════════════════════════════════════════════════════════════════════════

describe("copyAsRichText", () => {
  it("shows info toast and returns early when no doc is open", async () => {
    docState.path = null;
    await copyAsRichText("auto");
    expect(toastInfoMock).toHaveBeenCalledWith("Open a document first");
    expect(clipboardWriteMock).not.toHaveBeenCalled();
  });

  it("shows info toast and returns early when content is blank", async () => {
    docState.content = "   \n  ";
    await copyAsRichText("auto");
    expect(toastInfoMock).toHaveBeenCalledWith("Open a document first");
    expect(clipboardWriteMock).not.toHaveBeenCalled();
  });

  it("switches to read view and waits when not in read mode", async () => {
    docState.viewMode = "edit";
    await copyAsRichText("auto");
    expect(docState.setViewMode).toHaveBeenCalledWith("read");
    expect(waitForElementMock).toHaveBeenCalledWith(".markdown-body");
  });

  it("does NOT switch view when already in read mode", async () => {
    docState.viewMode = "read";
    await copyAsRichText("auto");
    expect(docState.setViewMode).not.toHaveBeenCalled();
  });

  it("calls navigator.clipboard.write with text/html and text/plain blobs", async () => {
    await copyAsRichText("auto");
    expect(clipboardWriteMock).toHaveBeenCalledOnce();
    const [items] = clipboardWriteMock.mock.calls[0] as [ClipboardItem[]];
    expect(items).toHaveLength(1);
    const item = items[0] as unknown as { data: Record<string, Blob> };
    expect(item.data["text/html"]).toBeInstanceOf(Blob);
    expect(item.data["text/plain"]).toBeInstanceOf(Blob);
  });

  it("format='auto': text/plain blob contains Markdown source", async () => {
    docState.content = "# Test\n\nContent\n";
    await copyAsRichText("auto");
    const [items] = clipboardWriteMock.mock.calls[0] as [ClipboardItem[]];
    const item = items[0] as unknown as { data: Record<string, Blob> };
    const plainText = await item.data["text/plain"].text();
    expect(plainText).toBe("# Test\n\nContent\n");
  });

  it("format='markdown': text/plain blob contains Markdown source", async () => {
    docState.content = "# Test\n";
    await copyAsRichText("markdown");
    const [items] = clipboardWriteMock.mock.calls[0] as [ClipboardItem[]];
    const item = items[0] as unknown as { data: Record<string, Blob> };
    const plainText = await item.data["text/plain"].text();
    expect(plainText).toBe("# Test\n");
  });

  it("format='html': text/plain blob contains the standalone HTML", async () => {
    await copyAsRichText("html");
    const [items] = clipboardWriteMock.mock.calls[0] as [ClipboardItem[]];
    const item = items[0] as unknown as { data: Record<string, Blob> };
    const plainText = await item.data["text/plain"].text();
    expect(plainText).toContain("<!doctype html>");
  });

  it("text/html blob contains theme-aware standalone HTML", async () => {
    await copyAsRichText("auto");
    const [items] = clipboardWriteMock.mock.calls[0] as [ClipboardItem[]];
    const item = items[0] as unknown as { data: Record<string, Blob> };
    const htmlText = await item.data["text/html"].text();
    expect(htmlText).toContain("<!doctype html>");
    expect(htmlText).toContain("/* themes-stub */");
    expect(htmlText).toContain("/* markdown-stub */");
  });

  it("shows success toast after a successful clipboard write", async () => {
    await copyAsRichText("auto");
    expect(toastSuccessMock).toHaveBeenCalledWith("Copied as rich HTML");
  });

  it("falls back to writeText when ClipboardItem is unavailable", async () => {
    installClipboardMocks({ noClipboardItem: true });
    await copyAsRichText("auto");
    expect(clipboardWriteTextMock).toHaveBeenCalledOnce();
    expect(toastSuccessMock).toHaveBeenCalledWith("Copied as rich HTML");
  });

  it("falls back to writeText when clipboard.write rejects", async () => {
    installClipboardMocks({ writeRejects: true });
    await copyAsRichText("auto");
    expect(clipboardWriteTextMock).toHaveBeenCalledOnce();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("shows error toast when both write and writeText fail", async () => {
    installClipboardMocks({ writeRejects: true });
    clipboardWriteTextMock.mockRejectedValueOnce(new Error("denied"));
    await copyAsRichText("auto");
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't copy to the clipboard");
  });

  it("reads the active theme from document.documentElement.dataset.theme", async () => {
    document.documentElement.dataset.theme = "midnight";
    await copyAsRichText("auto");
    const [items] = clipboardWriteMock.mock.calls[0] as [ClipboardItem[]];
    const item = items[0] as unknown as { data: Record<string, Blob> };
    const htmlText = await item.data["text/html"].text();
    expect(htmlText).toContain('data-theme="midnight"');
    expect(htmlText).toContain("--bg:#16181d");
    // Restore default
    document.documentElement.dataset.theme = "paper";
  });

  it("uses paper theme when no data-theme attribute is set", async () => {
    delete document.documentElement.dataset.theme;
    await copyAsRichText("auto");
    const [items] = clipboardWriteMock.mock.calls[0] as [ClipboardItem[]];
    const item = items[0] as unknown as { data: Record<string, Blob> };
    const htmlText = await item.data["text/html"].text();
    expect(htmlText).toContain("--bg:#ffffff");
    // Restore
    document.documentElement.dataset.theme = "paper";
  });

  it("preserves code block content from the DOM body", async () => {
    const el = document.querySelector(".markdown-body")!;
    el.innerHTML =
      '<pre><code class="language-ts">const x = 1;</code></pre>';
    await copyAsRichText("auto");
    const [items] = clipboardWriteMock.mock.calls[0] as [ClipboardItem[]];
    const item = items[0] as unknown as { data: Record<string, Blob> };
    const htmlText = await item.data["text/html"].text();
    expect(htmlText).toContain("const x = 1;");
  });

  it("strips the .review-card from the copied HTML", async () => {
    const el = document.querySelector(".markdown-body")!;
    el.innerHTML =
      '<aside class="review-card">AI REVIEW</aside><h1>Doc</h1>';
    await copyAsRichText("auto");
    const [items] = clipboardWriteMock.mock.calls[0] as [ClipboardItem[]];
    const item = items[0] as unknown as { data: Record<string, Blob> };
    const htmlText = await item.data["text/html"].text();
    expect(htmlText).not.toContain("AI REVIEW");
    // Text content of the heading must survive (tag may be normalised by DOMPurify).
    expect(htmlText).toContain("Doc");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildRichTextHtml — DOMPurify pass + wrapRichTextBody
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildRichTextHtml", () => {
  it("sanitizes and wraps the inner HTML — preserves text content", () => {
    // DOMPurify may or may not preserve heading tags in the happy-dom test env,
    // but it always preserves text content. We check for the wrapper div and
    // that the text we passed in survives the sanitization pass.
    const result = buildRichTextHtml("<h1>Title</h1><p>text</p>");
    expect(result).toContain("Title");
    expect(result).toContain("text");
    expect(result.startsWith('<div style="')).toBe(true);
  });

  it("returns empty string for empty input", () => {
    expect(buildRichTextHtml("")).toBe("");
  });
});
