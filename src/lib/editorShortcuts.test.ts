/**
 * editorShortcuts.test.ts — unit tests for the three editor-shortcut helpers.
 *
 * Feature coverage:
 *  1. detectListContext / continueList — list continuation logic
 *  2. buildTableMarkdown              — GFM table wizard output
 *  3. isUrl / normaliseUrl / extractLinkTitle / buildLinkMarkdown — paste URL detection
 */

import { describe, it, expect, vi } from "vitest";
import {
  detectListContext,
  continueList,
  buildTableMarkdown,
  isUrl,
  normaliseUrl,
  extractLinkTitle,
  buildLinkMarkdown,
} from "./editorShortcuts";

// ── 1. List continuation ──────────────────────────────────────────────────────

describe("detectListContext", () => {
  it("detects a simple unordered bullet with dash", () => {
    const ctx = detectListContext("- hello");
    expect(ctx).not.toBeNull();
    expect(ctx!.marker).toBe("-");
    expect(ctx!.ordered).toBe(false);
    expect(ctx!.content).toBe("hello");
    expect(ctx!.indent).toBe("");
  });

  it("detects an asterisk bullet", () => {
    const ctx = detectListContext("* world");
    expect(ctx).not.toBeNull();
    expect(ctx!.marker).toBe("*");
    expect(ctx!.ordered).toBe(false);
  });

  it("detects a plus bullet", () => {
    const ctx = detectListContext("+ item");
    expect(ctx).not.toBeNull();
    expect(ctx!.marker).toBe("+");
  });

  it("detects an ordered list item", () => {
    const ctx = detectListContext("1. first");
    expect(ctx).not.toBeNull();
    expect(ctx!.marker).toBe("1.");
    expect(ctx!.ordered).toBe(true);
    expect(ctx!.orderedValue).toBe(1);
    expect(ctx!.content).toBe("first");
  });

  it("detects a high-numbered ordered item", () => {
    const ctx = detectListContext("42. answer");
    expect(ctx).not.toBeNull();
    expect(ctx!.orderedValue).toBe(42);
  });

  it("detects indented (nested) list item", () => {
    const ctx = detectListContext("  - nested");
    expect(ctx).not.toBeNull();
    expect(ctx!.indent).toBe("  ");
    expect(ctx!.marker).toBe("-");
  });

  it("detects deeply indented list item", () => {
    const ctx = detectListContext("    * deep");
    expect(ctx).not.toBeNull();
    expect(ctx!.indent).toBe("    ");
  });

  it("detects indented ordered item", () => {
    const ctx = detectListContext("   3. item");
    expect(ctx).not.toBeNull();
    expect(ctx!.indent).toBe("   ");
    expect(ctx!.orderedValue).toBe(3);
  });

  it("returns null for plain text (not a list item)", () => {
    expect(detectListContext("just some text")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(detectListContext("")).toBeNull();
  });

  it("returns null for a heading", () => {
    expect(detectListContext("## heading")).toBeNull();
  });

  it("returns null for a blockquote", () => {
    expect(detectListContext("> quote")).toBeNull();
  });

  it("detects item with trailing whitespace stripped from content", () => {
    const ctx = detectListContext("- item   ");
    expect(ctx!.content).toBe("item");
  });

  it("detects empty list item (dash + space only)", () => {
    const ctx = detectListContext("- ");
    expect(ctx).not.toBeNull();
    expect(ctx!.content).toBe("");
  });

  it("detects empty ordered item", () => {
    const ctx = detectListContext("1. ");
    expect(ctx).not.toBeNull();
    expect(ctx!.content).toBe("");
  });
});

describe("continueList", () => {
  it("appends a new unordered bullet on the next line", () => {
    const ctx = detectListContext("- item")!;
    expect(continueList(ctx)).toBe("\n- ");
  });

  it("appends a new asterisk bullet", () => {
    const ctx = detectListContext("* item")!;
    expect(continueList(ctx)).toBe("\n* ");
  });

  it("increments ordered list counter", () => {
    const ctx = detectListContext("1. first")!;
    expect(continueList(ctx)).toBe("\n2. ");
  });

  it("increments from a high counter", () => {
    const ctx = detectListContext("9. ninth")!;
    expect(continueList(ctx)).toBe("\n10. ");
  });

  it("preserves indentation for nested bullets", () => {
    const ctx = detectListContext("  - nested")!;
    expect(continueList(ctx)).toBe("\n  - ");
  });

  it("preserves indentation for nested ordered items", () => {
    const ctx = detectListContext("   2. item")!;
    expect(continueList(ctx)).toBe("\n   3. ");
  });

  it("returns empty string for an empty list item (exit list)", () => {
    const ctx = detectListContext("- ")!;
    expect(continueList(ctx)).toBe("");
  });

  it("returns empty string for empty ordered item", () => {
    const ctx = detectListContext("1. ")!;
    expect(continueList(ctx)).toBe("");
  });

  it("handles deeply nested empty item", () => {
    const ctx = detectListContext("    - ")!;
    expect(continueList(ctx)).toBe("");
  });
});

// ── 2. Table wizard ────────────────────────────────────────────────────────────

describe("buildTableMarkdown", () => {
  it("generates a 2x2 table (2 rows, 2 cols)", () => {
    const md = buildTableMarkdown(2, 2);
    const lines = md.split("\n");
    // header + separator + 2 data rows = 4 lines
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("| Header 1 | Header 2 |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines[2]).toBe("| Cell 1,1 | Cell 1,2 |");
    expect(lines[3]).toBe("| Cell 2,1 | Cell 2,2 |");
  });

  it("generates a 1x1 table (minimum dimensions)", () => {
    const md = buildTableMarkdown(1, 1);
    const lines = md.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("| Header 1 |");
    expect(lines[1]).toBe("| --- |");
    expect(lines[2]).toBe("| Cell 1,1 |");
  });

  it("generates a 5x10 table", () => {
    const md = buildTableMarkdown(5, 10);
    const lines = md.split("\n");
    // header + separator + 5 data rows
    expect(lines).toHaveLength(7);
    // 10 header cells
    expect(lines[0]).toContain("Header 10");
    // last data row, last column
    expect(lines[6]).toContain("Cell 5,10");
  });

  it("generates a 3x4 table with correct cell labels", () => {
    const md = buildTableMarkdown(3, 4);
    expect(md).toContain("Header 4");
    expect(md).toContain("Cell 3,4");
    expect(md).not.toContain("Cell 4,");
  });

  it("clamps cols < 1 to 1", () => {
    const md = buildTableMarkdown(1, 0);
    expect(md.split("\n")[0]).toBe("| Header 1 |");
  });

  it("clamps rows < 1 to 1", () => {
    const md = buildTableMarkdown(0, 2);
    const lines = md.split("\n");
    expect(lines).toHaveLength(3); // header + sep + 1 row
  });

  it("each data row has the correct number of cells", () => {
    const cols = 6;
    const md = buildTableMarkdown(3, cols);
    const dataRows = md.split("\n").slice(2);
    for (const row of dataRows) {
      const cells = row.split("|").filter((c) => c.trim());
      expect(cells).toHaveLength(cols);
    }
  });

  it("separator row uses --- for each column", () => {
    const md = buildTableMarkdown(2, 3);
    expect(md.split("\n")[1]).toBe("| --- | --- | --- |");
  });

  it("is valid GFM: every row starts and ends with |", () => {
    const md = buildTableMarkdown(4, 4);
    for (const line of md.split("\n")) {
      expect(line.startsWith("|")).toBe(true);
      expect(line.endsWith("|")).toBe(true);
    }
  });

  it("generates a large 20x20 table without error", () => {
    expect(() => buildTableMarkdown(20, 20)).not.toThrow();
    const md = buildTableMarkdown(20, 20);
    expect(md).toContain("Header 20");
    expect(md).toContain("Cell 20,20");
  });
});

// ── 3. URL detection & link building ──────────────────────────────────────────

describe("isUrl", () => {
  it("recognises http:// URLs", () => {
    expect(isUrl("http://example.com")).toBe(true);
  });

  it("recognises https:// URLs", () => {
    expect(isUrl("https://example.com/path?q=1")).toBe(true);
  });

  it("recognises www. URLs", () => {
    expect(isUrl("www.example.com")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(isUrl("hello world")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isUrl("")).toBe(false);
  });

  it("returns false for partial match embedded in text", () => {
    expect(isUrl("check https://example.com here")).toBe(false);
  });

  it("returns false for a Markdown link", () => {
    expect(isUrl("[title](https://example.com)")).toBe(false);
  });

  it("trims surrounding whitespace before testing", () => {
    expect(isUrl("  https://example.com  ")).toBe(true);
  });
});

describe("normaliseUrl", () => {
  it("passes through https:// URLs unchanged", () => {
    expect(normaliseUrl("https://example.com")).toBe("https://example.com");
  });

  it("passes through http:// URLs unchanged", () => {
    expect(normaliseUrl("http://example.com")).toBe("http://example.com");
  });

  it("prepends https:// to www. URLs", () => {
    expect(normaliseUrl("www.example.com")).toBe("https://www.example.com");
  });

  it("trims leading/trailing whitespace before normalising", () => {
    expect(normaliseUrl("  www.example.com  ")).toBe("https://www.example.com");
  });
});

describe("extractLinkTitle", () => {
  it("returns the title string when invoke resolves with a non-empty string", async () => {
    const mockInvoke = vi.fn().mockResolvedValue("Example Domain");
    const title = await extractLinkTitle("https://example.com", mockInvoke);
    expect(title).toBe("Example Domain");
    expect(mockInvoke).toHaveBeenCalledWith("fetch_page_title", {
      url: "https://example.com",
    });
  });

  it("returns null when invoke resolves with null", async () => {
    const mockInvoke = vi.fn().mockResolvedValue(null);
    const title = await extractLinkTitle("https://example.com", mockInvoke);
    expect(title).toBeNull();
  });

  it("returns null when invoke resolves with an empty string", async () => {
    const mockInvoke = vi.fn().mockResolvedValue("   ");
    const title = await extractLinkTitle("https://example.com", mockInvoke);
    expect(title).toBeNull();
  });

  it("returns null when invoke rejects (network error)", async () => {
    const mockInvoke = vi.fn().mockRejectedValue(new Error("network error"));
    const title = await extractLinkTitle("https://example.com", mockInvoke);
    expect(title).toBeNull();
  });

  it("normalises a www. URL before invoking", async () => {
    const mockInvoke = vi.fn().mockResolvedValue("Some Page");
    await extractLinkTitle("www.example.com", mockInvoke);
    expect(mockInvoke).toHaveBeenCalledWith("fetch_page_title", {
      url: "https://www.example.com",
    });
  });

  it("trims whitespace from the returned title", async () => {
    const mockInvoke = vi.fn().mockResolvedValue("  Spaced Title  ");
    const title = await extractLinkTitle("https://example.com", mockInvoke);
    expect(title).toBe("Spaced Title");
  });

  it("returns null when invoke is null and Tauri is unavailable (test env)", async () => {
    // In vitest / happy-dom there is no @tauri-apps/api/core, so the dynamic
    // import will fail and the function should return null gracefully.
    const title = await extractLinkTitle("https://example.com", null);
    expect(title).toBeNull();
  });

  it("returns null when invoke resolves with a non-string value", async () => {
    const mockInvoke = vi.fn().mockResolvedValue(42);
    const title = await extractLinkTitle("https://example.com", mockInvoke);
    expect(title).toBeNull();
  });
});

describe("buildLinkMarkdown", () => {
  it("builds [title](url) when title is available", async () => {
    const mockInvoke = vi.fn().mockResolvedValue("Example Domain");
    const md = await buildLinkMarkdown("https://example.com", mockInvoke);
    expect(md).toBe("[Example Domain](https://example.com)");
  });

  it("falls back to [Link](url) when no title is available", async () => {
    const mockInvoke = vi.fn().mockResolvedValue(null);
    const md = await buildLinkMarkdown("https://example.com", mockInvoke);
    expect(md).toBe("[Link](https://example.com)");
  });

  it("falls back to [Link](url) when invoke rejects", async () => {
    const mockInvoke = vi.fn().mockRejectedValue(new Error("timeout"));
    const md = await buildLinkMarkdown("https://example.com", mockInvoke);
    expect(md).toBe("[Link](https://example.com)");
  });

  it("normalises www. URL in the produced link", async () => {
    const mockInvoke = vi.fn().mockResolvedValue("My Site");
    const md = await buildLinkMarkdown("www.mysite.com", mockInvoke);
    expect(md).toBe("[My Site](https://www.mysite.com)");
  });

  it("uses [Link] fallback when title is empty string", async () => {
    const mockInvoke = vi.fn().mockResolvedValue("");
    const md = await buildLinkMarkdown("https://example.com", mockInvoke);
    expect(md).toBe("[Link](https://example.com)");
  });

  it("trims whitespace from the pasted URL before building link", async () => {
    const mockInvoke = vi.fn().mockResolvedValue("Page");
    const md = await buildLinkMarkdown("  https://example.com  ", mockInvoke);
    expect(md).toBe("[Page](https://example.com)");
  });
});
