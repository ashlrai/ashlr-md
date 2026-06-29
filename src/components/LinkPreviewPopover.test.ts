/**
 * LinkPreviewPopover.test.ts
 *
 * Comprehensive tests for the inline link preview feature, covering:
 *  1. linkPreview utility — classifyHref, domainOf, extractPreviewSnippet
 *  2. resolveLinkPreview — internal links, external stubs, "none" links,
 *     broken links, wikilink targets, caching behaviour
 *
 * These tests are React-free so they run in the happy-dom vitest environment
 * without needing react-testing-library.  All Tauri IPC and store dependencies
 * are mocked below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that transitively use them
// ---------------------------------------------------------------------------

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// resolveWikilink reads the documentStore; mock the whole wikilink module so
// we control resolution results without needing an IPC round-trip.
const resolveWikilinkMock = vi.fn<(target: string) => Promise<string | null>>();
vi.mock("../lib/wikilink", () => ({
  resolveWikilink: (target: unknown) => resolveWikilinkMock(target as string),
  invalidateWikilinkCache: vi.fn(),
}));

// vault and settingsStore are pulled in transitively — stub them out.
vi.mock("../lib/vault", () => ({
  effectiveVaultRoot: vi.fn().mockResolvedValue(null),
}));
vi.mock("../store/settingsStore", () => ({
  useSettingsStore: { getState: () => ({ vaultRoot: null }) },
}));
vi.mock("../store/documentStore", () => ({
  useDocumentStore: {
    getState: () => ({ path: "/vault/current.md", openPath: vi.fn() }),
  },
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks are in place)
// ---------------------------------------------------------------------------

import {
  classifyHref,
  domainOf,
  extractPreviewSnippet,
  invalidateLinkPreviewCache,
  resolveLinkPreview,
} from "../lib/linkPreview";

// ---------------------------------------------------------------------------
// Test-lifecycle helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  invalidateLinkPreviewCache();
  invokeMock.mockReset();
  resolveWikilinkMock.mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
});

// ===========================================================================
// classifyHref
// ===========================================================================

describe("classifyHref — link classification", () => {
  it("classifies https:// links as external", () => {
    expect(classifyHref("https://example.com/page")).toBe("external");
  });

  it("classifies http:// links as external", () => {
    expect(classifyHref("http://example.com")).toBe("external");
  });

  it("classifies HTTPS links with mixed case as external", () => {
    expect(classifyHref("HTTPS://example.com")).toBe("external");
  });

  it("classifies .md file paths as internal", () => {
    expect(classifyHref("notes/project.md")).toBe("internal");
  });

  it("classifies bare wikilink names (no extension) as internal", () => {
    expect(classifyHref("My Note")).toBe("internal");
  });

  it("classifies bare filenames without extension as internal", () => {
    expect(classifyHref("ProjectIdeas")).toBe("internal");
  });

  it("classifies anchor-only links as none", () => {
    expect(classifyHref("#section")).toBe("none");
  });

  it("classifies mailto: links as none", () => {
    expect(classifyHref("mailto:user@example.com")).toBe("none");
  });

  it("classifies javascript: links as none", () => {
    expect(classifyHref("javascript:void(0)")).toBe("none");
  });

  it("classifies data: URIs as none", () => {
    expect(classifyHref("data:text/plain;base64,SGVsbG8=")).toBe("none");
  });

  it("classifies empty string as none", () => {
    expect(classifyHref("")).toBe("none");
  });

  it("classifies absolute .md paths as internal", () => {
    expect(classifyHref("/vault/subdir/note.md")).toBe("internal");
  });
});

// ===========================================================================
// domainOf
// ===========================================================================

describe("domainOf — domain extraction", () => {
  it("extracts hostname from a simple https URL", () => {
    expect(domainOf("https://example.com/page?q=1")).toBe("example.com");
  });

  it("extracts hostname from a http URL with a port", () => {
    expect(domainOf("http://localhost:3000/path")).toBe("localhost");
  });

  it("extracts subdomain correctly", () => {
    expect(domainOf("https://docs.example.com/guide")).toBe("docs.example.com");
  });

  it("returns the original href when URL parse fails", () => {
    expect(domainOf("not-a-url")).toBe("not-a-url");
  });

  it("returns empty string for empty href", () => {
    expect(domainOf("")).toBe("");
  });
});

// ===========================================================================
// extractPreviewSnippet
// ===========================================================================

describe("extractPreviewSnippet — content extraction", () => {
  it("returns heading + following paragraph when present", () => {
    const content = "# My Note\n\nThis is the intro paragraph.\n\nMore text.";
    const result = extractPreviewSnippet(content);
    expect(result).toContain("# My Note");
    expect(result).toContain("This is the intro paragraph.");
    // Should NOT include content beyond the first paragraph.
    expect(result).not.toContain("More text.");
  });

  it("strips YAML frontmatter before extracting", () => {
    const content = "---\ntitle: Test\ndate: 2024-01-01\n---\n# Heading\n\nParagraph.";
    const result = extractPreviewSnippet(content);
    expect(result).not.toContain("title: Test");
    expect(result).toContain("# Heading");
  });

  it("returns just the heading when no paragraph follows", () => {
    const content = "# Heading Only\n\n";
    const result = extractPreviewSnippet(content);
    expect(result).toBe("# Heading Only");
  });

  it("falls back to first 15 non-empty lines when no heading present", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
    const content = lines.join("\n");
    const result = extractPreviewSnippet(content);
    const resultLines = result.split("\n");
    expect(resultLines).toHaveLength(15);
    expect(resultLines[0]).toBe("Line 1");
    expect(resultLines[14]).toBe("Line 15");
  });

  it("skips blank lines between heading and paragraph", () => {
    const content = "# Title\n\n\n\nDeferred paragraph.";
    const result = extractPreviewSnippet(content);
    expect(result).toContain("# Title");
    expect(result).toContain("Deferred paragraph.");
  });

  it("returns empty string for empty content", () => {
    expect(extractPreviewSnippet("")).toBe("");
  });

  it("handles content that is only frontmatter", () => {
    const content = "---\ntitle: Empty\n---\n";
    const result = extractPreviewSnippet(content);
    expect(result).toBe("");
  });

  it("handles h2 headings (not just h1)", () => {
    const content = "## Section\n\nSection content here.";
    const result = extractPreviewSnippet(content);
    expect(result).toContain("## Section");
    expect(result).toContain("Section content here.");
  });

  it("handles h6 headings", () => {
    const content = "###### Deep Heading\n\nDeep content.";
    const result = extractPreviewSnippet(content);
    expect(result).toContain("###### Deep Heading");
  });

  it("extracts only up to 15 lines when falling back", () => {
    // All non-empty lines, no heading.
    const content = Array.from({ length: 30 }, (_, i) => `prose line ${i}`).join("\n");
    const result = extractPreviewSnippet(content);
    const resultLines = result.split("\n").filter((l) => l.trim() !== "");
    expect(resultLines.length).toBeLessThanOrEqual(15);
  });

  it("ignores empty lines when counting fallback lines", () => {
    // 10 non-empty + 20 empty lines — should return all 10 non-empty.
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`text ${i}`);
      lines.push("");
      lines.push("");
    }
    const result = extractPreviewSnippet(lines.join("\n"));
    const nonEmpty = result.split("\n").filter((l) => l.trim() !== "");
    expect(nonEmpty).toHaveLength(10);
  });
});

// ===========================================================================
// resolveLinkPreview — external links
// ===========================================================================

describe("resolveLinkPreview — external links", () => {
  it("returns external kind with domain stub for https URL", async () => {
    const result = await resolveLinkPreview("https://example.com/page", null);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("external");
    expect(result!.snippet).toContain("External link");
    expect(result!.snippet).toContain("example.com");
    expect(result!.resolvedPath).toBe("");
  });

  it("returns external kind for http URL", async () => {
    const result = await resolveLinkPreview("http://blog.example.org/post/1", null);
    expect(result!.kind).toBe("external");
    expect(result!.snippet).toContain("blog.example.org");
  });

  it("never calls invoke for external links (privacy-first)", async () => {
    await resolveLinkPreview("https://example.com", null);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("never calls resolveWikilink for external links", async () => {
    await resolveLinkPreview("https://example.com", null);
    expect(resolveWikilinkMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// resolveLinkPreview — "none" links
// ===========================================================================

describe("resolveLinkPreview — none links (no popover)", () => {
  it("returns null for anchor-only links", async () => {
    const result = await resolveLinkPreview("#section", null);
    expect(result).toBeNull();
  });

  it("returns null for mailto: links", async () => {
    const result = await resolveLinkPreview("mailto:user@example.com", null);
    expect(result).toBeNull();
  });

  it("returns null for javascript: links", async () => {
    const result = await resolveLinkPreview("javascript:void(0)", null);
    expect(result).toBeNull();
  });

  it("returns null for empty href", async () => {
    const result = await resolveLinkPreview("", null);
    expect(result).toBeNull();
  });

  it("does not call IPC for none links", async () => {
    await resolveLinkPreview("#foo", "/vault/doc.md");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// resolveLinkPreview — internal links
// ===========================================================================

describe("resolveLinkPreview — internal .md links", () => {
  it("returns internal kind with snippet when file resolves", async () => {
    resolveWikilinkMock.mockResolvedValueOnce("/vault/target.md");
    invokeMock.mockResolvedValueOnce({ content: "# Target\n\nTarget paragraph." });

    const result = await resolveLinkPreview("target.md", "/vault/current.md");

    expect(result).not.toBeNull();
    expect(result!.kind).toBe("internal");
    expect(result!.resolvedPath).toBe("/vault/target.md");
    expect(result!.snippet).toContain("# Target");
    expect(result!.snippet).toContain("Target paragraph.");
  });

  it("calls read_markdown_file with the resolved path", async () => {
    resolveWikilinkMock.mockResolvedValueOnce("/vault/notes/readme.md");
    invokeMock.mockResolvedValueOnce({ content: "# Readme\n\nContent." });

    await resolveLinkPreview("notes/readme.md", "/vault/current.md");

    expect(invokeMock).toHaveBeenCalledWith("read_markdown_file", {
      path: "/vault/notes/readme.md",
    });
  });

  it("returns null when resolveWikilink returns null (broken link)", async () => {
    resolveWikilinkMock.mockResolvedValueOnce(null);

    const result = await resolveLinkPreview("nonexistent.md", "/vault/current.md");
    expect(result).toBeNull();
  });

  it("returns null when IPC throws (file unreadable)", async () => {
    resolveWikilinkMock.mockResolvedValueOnce("/vault/locked.md");
    invokeMock.mockRejectedValueOnce(new Error("Permission denied"));

    const result = await resolveLinkPreview("locked.md", "/vault/current.md");
    expect(result).toBeNull();
  });

  it("strips #fragment before resolving, passes file part to wikilink", async () => {
    resolveWikilinkMock.mockResolvedValueOnce("/vault/note.md");
    invokeMock.mockResolvedValueOnce({ content: "# Note\n\nBody." });

    await resolveLinkPreview("note.md#heading", "/vault/current.md");

    expect(resolveWikilinkMock).toHaveBeenCalledWith("note.md");
  });

  it("returns snippet extracted from file content", async () => {
    resolveWikilinkMock.mockResolvedValueOnce("/vault/doc.md");
    invokeMock.mockResolvedValueOnce({
      content: "---\nkind: note\n---\n# Doc Title\n\nFirst paragraph of the doc.",
    });

    const result = await resolveLinkPreview("doc.md", "/vault/current.md");

    expect(result!.snippet).toContain("# Doc Title");
    expect(result!.snippet).toContain("First paragraph of the doc.");
    expect(result!.snippet).not.toContain("kind: note");
  });
});

// ===========================================================================
// resolveLinkPreview — wikilink-style targets (no extension)
// ===========================================================================

describe("resolveLinkPreview — wikilink-style targets", () => {
  it("resolves a bare note name via resolveWikilink", async () => {
    resolveWikilinkMock.mockResolvedValueOnce("/vault/My Note.md");
    invokeMock.mockResolvedValueOnce({ content: "# My Note\n\nIntro." });

    const result = await resolveLinkPreview("My Note", "/vault/index.md");

    expect(result!.kind).toBe("internal");
    expect(result!.resolvedPath).toBe("/vault/My Note.md");
    expect(result!.snippet).toContain("# My Note");
  });

  it("handles wikilinks with fragment sections", async () => {
    resolveWikilinkMock.mockResolvedValueOnce("/vault/note.md");
    invokeMock.mockResolvedValueOnce({ content: "# Note\n\n## Section\n\nSection body." });

    const result = await resolveLinkPreview("note#Section", "/vault/current.md");

    // File part "note" stripped of #Section before resolution.
    expect(resolveWikilinkMock).toHaveBeenCalledWith("note");
    expect(result!.kind).toBe("internal");
  });

  it("returns null for a wikilink target that doesn't exist in the vault", async () => {
    resolveWikilinkMock.mockResolvedValueOnce(null);

    const result = await resolveLinkPreview("NonExistentNote", "/vault/current.md");
    expect(result).toBeNull();
  });

  it("passes currentPath through to the cache key so different docs resolve independently", async () => {
    // First call from /vault/a.md context.
    resolveWikilinkMock.mockResolvedValueOnce("/vault/target.md");
    invokeMock.mockResolvedValueOnce({ content: "# T\n\nFrom A." });
    const r1 = await resolveLinkPreview("target", "/vault/a.md");

    // Second call from /vault/b.md context — different cache key → re-resolved.
    resolveWikilinkMock.mockResolvedValueOnce("/vault/target.md");
    invokeMock.mockResolvedValueOnce({ content: "# T\n\nFrom B." });
    const r2 = await resolveLinkPreview("target", "/vault/b.md");

    expect(r1!.snippet).toContain("From A.");
    expect(r2!.snippet).toContain("From B.");
    // resolveWikilink was called twice (different cache keys).
    expect(resolveWikilinkMock).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// resolveLinkPreview — caching
// ===========================================================================

describe("resolveLinkPreview — caching", () => {
  it("caches a successful result and avoids re-invoking IPC", async () => {
    resolveWikilinkMock.mockResolvedValue("/vault/note.md");
    invokeMock.mockResolvedValue({ content: "# Cached\n\nBody." });

    await resolveLinkPreview("note.md", "/vault/current.md");
    await resolveLinkPreview("note.md", "/vault/current.md");

    // IPC should have been called only once despite two hover events.
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("external results are returned immediately on second call (no IPC at all)", async () => {
    await resolveLinkPreview("https://example.com", null);
    const r2 = await resolveLinkPreview("https://example.com", null);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(r2!.kind).toBe("external");
  });

  it("re-resolves after invalidateLinkPreviewCache is called", async () => {
    resolveWikilinkMock.mockResolvedValue("/vault/note.md");
    invokeMock.mockResolvedValue({ content: "# Note\n\nBody." });

    await resolveLinkPreview("note.md", "/vault/current.md");
    invalidateLinkPreviewCache();
    await resolveLinkPreview("note.md", "/vault/current.md");

    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("null (broken) results are cached briefly", async () => {
    resolveWikilinkMock.mockResolvedValue(null);

    const r1 = await resolveLinkPreview("missing.md", "/vault/current.md");
    const r2 = await resolveLinkPreview("missing.md", "/vault/current.md");

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    // resolveWikilink called once — second call hits the null cache entry.
    expect(resolveWikilinkMock).toHaveBeenCalledTimes(1);
  });

  it("different hrefs have independent cache entries", async () => {
    resolveWikilinkMock.mockResolvedValue("/vault/note.md");
    invokeMock.mockResolvedValue({ content: "# Note\n\nBody." });

    await resolveLinkPreview("alpha.md", "/vault/current.md");
    await resolveLinkPreview("beta.md", "/vault/current.md");

    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// resolveLinkPreview — malformed / edge-case links
// ===========================================================================

describe("resolveLinkPreview — malformed and edge-case links", () => {
  it("handles a link that is only a fragment character", async () => {
    const result = await resolveLinkPreview("#", null);
    expect(result).toBeNull();
  });

  it("handles a link with only whitespace gracefully", async () => {
    // Whitespace-only href: classifyHref returns "none" or tries internal.
    // Either way it must not throw.
    const result = await resolveLinkPreview("   ", null);
    // Could be null (none) or attempt internal — must not throw.
    expect(result === null || typeof result === "object").toBe(true);
  });

  it("handles extremely long wikilink target names", async () => {
    const longName = "A".repeat(2000);
    resolveWikilinkMock.mockResolvedValueOnce(null);
    const result = await resolveLinkPreview(longName, "/vault/current.md");
    expect(result).toBeNull();
  });

  it("handles a .md path with spaces", async () => {
    resolveWikilinkMock.mockResolvedValueOnce("/vault/my note.md");
    invokeMock.mockResolvedValueOnce({ content: "# Space Note\n\nContent." });

    const result = await resolveLinkPreview("my note.md", "/vault/current.md");
    expect(result!.kind).toBe("internal");
    expect(result!.resolvedPath).toBe("/vault/my note.md");
  });

  it("handles file content that is empty string", async () => {
    resolveWikilinkMock.mockResolvedValueOnce("/vault/empty.md");
    invokeMock.mockResolvedValueOnce({ content: "" });

    const result = await resolveLinkPreview("empty.md", "/vault/current.md");
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("internal");
    expect(result!.snippet).toBe("");
  });

  it("handles file content that is only frontmatter", async () => {
    resolveWikilinkMock.mockResolvedValueOnce("/vault/fm-only.md");
    invokeMock.mockResolvedValueOnce({ content: "---\ntitle: Only FM\ntags: []\n---\n" });

    const result = await resolveLinkPreview("fm-only.md", "/vault/current.md");
    expect(result).not.toBeNull();
    expect(result!.snippet).toBe("");
  });

  it("handles a currentPath of null (no document open)", async () => {
    resolveWikilinkMock.mockResolvedValueOnce("/vault/note.md");
    invokeMock.mockResolvedValueOnce({ content: "# Note\n\nBody." });

    // Should not throw even when currentPath is null.
    const result = await resolveLinkPreview("note.md", null);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("internal");
  });

  it("handles IPC returning unexpected shape without throwing", async () => {
    resolveWikilinkMock.mockResolvedValueOnce("/vault/note.md");
    // Malformed response — content property missing.
    invokeMock.mockResolvedValueOnce({ text: "wrong property" });

    // extractPreviewSnippet("undefined") should produce something or empty — not throw.
    const result = await resolveLinkPreview("note.md", "/vault/current.md");
    // Either null (cached broken) or a result with possibly empty snippet.
    expect(result === null || typeof result!.snippet === "string").toBe(true);
  });
});
