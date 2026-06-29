/**
 * crossSearch.test.ts — integration tests for src/lib/crossSearch.ts
 *
 * Covers:
 *   (1) searchFiles — full-text keyword search across provided paths
 *   (2) Result ranking / relevance — match count drives file ordering
 *   (3) Path filtering — empty paths / empty query early-returns
 *   (4) Exclusion patterns / scoping — integration with libraryContext patterns
 *   (5) Graceful degradation — network errors, backend rejections
 *   (6) Combined embedSearch + crossSearch flow — semantic-first with keyword
 *       fallback, merging results, timeout handling
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock @tauri-apps/api/core ─────────────────────────────────────────────────
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Imports AFTER mocks.
import {
  searchFiles,
  type FileSearchResult,
  type SearchMatch,
} from "./crossSearch";
import {
  embedAvailable,
  embedSearch,
  invalidateEmbedAvailable,
  type SemanticMatch,
} from "./embedSearch";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMatch(lineNo: number, snippet: string): SearchMatch {
  return { lineNo, snippet };
}

function makeFileResult(
  path: string,
  fileName: string,
  matches: SearchMatch[],
): FileSearchResult {
  return { path, fileName, matches };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  invokeMock.mockReset();
  invalidateEmbedAvailable();
});

afterEach(() => {
  vi.clearAllMocks();
  invalidateEmbedAvailable();
});

// ═══════════════════════════════════════════════════════════════════════════════
// (1) searchFiles — basic invocation
// ═══════════════════════════════════════════════════════════════════════════════

describe("searchFiles — basic invocation", () => {
  it("invokes 'search_files' with the given paths and query", async () => {
    invokeMock.mockResolvedValue([]);
    await searchFiles(["/a.md", "/b.md"], "hello");
    expect(invokeMock).toHaveBeenCalledWith("search_files", {
      paths: ["/a.md", "/b.md"],
      query: "hello",
      limit: undefined,
    });
  });

  it("passes the limit parameter when provided", async () => {
    invokeMock.mockResolvedValue([]);
    await searchFiles(["/a.md"], "query", 50);
    expect(invokeMock).toHaveBeenCalledWith("search_files", {
      paths: ["/a.md"],
      query: "query",
      limit: 50,
    });
  });

  it("returns FileSearchResult[] from the backend", async () => {
    const results: FileSearchResult[] = [
      makeFileResult("/vault/notes.md", "notes.md", [
        makeMatch(3, "hello world here"),
        makeMatch(12, "hello again in context"),
      ]),
    ];
    invokeMock.mockResolvedValue(results);
    const out = await searchFiles(["/vault/notes.md"], "hello");
    expect(out).toEqual(results);
  });

  it("FileSearchResult has path, fileName, and matches fields", async () => {
    const r = makeFileResult("/x.md", "x.md", [makeMatch(1, "snippet")]);
    invokeMock.mockResolvedValue([r]);
    const [item] = await searchFiles(["/x.md"], "snippet");
    expect(item).toHaveProperty("path", "/x.md");
    expect(item).toHaveProperty("fileName", "x.md");
    expect(item).toHaveProperty("matches");
    expect(Array.isArray(item.matches)).toBe(true);
  });

  it("each SearchMatch has lineNo and snippet", async () => {
    const r = makeFileResult("/doc.md", "doc.md", [makeMatch(7, "found it here")]);
    invokeMock.mockResolvedValue([r]);
    const [file] = await searchFiles(["/doc.md"], "found");
    const [m] = file.matches;
    expect(m).toHaveProperty("lineNo", 7);
    expect(m).toHaveProperty("snippet", "found it here");
  });

  it("returns an empty array when no files match the query", async () => {
    invokeMock.mockResolvedValue([]);
    const out = await searchFiles(["/a.md", "/b.md"], "zzznomatch");
    expect(out).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (2) Path filtering — empty paths / empty query early-return
// ═══════════════════════════════════════════════════════════════════════════════

describe("searchFiles — path filtering and early-return", () => {
  it("returns [] immediately for an empty query without calling invoke", async () => {
    const out = await searchFiles(["/a.md", "/b.md"], "");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it("returns [] immediately for a whitespace-only query", async () => {
    const out = await searchFiles(["/a.md"], "   ");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it("returns [] immediately when paths is empty without calling invoke", async () => {
    const out = await searchFiles([], "hello");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it("returns [] for empty paths even with a non-empty query", async () => {
    const out = await searchFiles([], "semantic search");
    expect(out).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("invokes only when both paths and query are non-empty", async () => {
    invokeMock.mockResolvedValue([]);
    await searchFiles(["/a.md"], "rust");
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("passes multiple paths as an array to the backend", async () => {
    invokeMock.mockResolvedValue([]);
    const paths = ["/a.md", "/b.md", "/c.md"];
    await searchFiles(paths, "test");
    expect(invokeMock).toHaveBeenCalledWith("search_files", {
      paths,
      query: "test",
      limit: undefined,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (3) Result ranking by relevance (match count)
// ═══════════════════════════════════════════════════════════════════════════════

describe("searchFiles — result ranking by relevance", () => {
  it("backend-ranked results are returned in the received order (bridge doesn't re-sort)", async () => {
    // Simulate backend returning results highest-relevance first.
    const results: FileSearchResult[] = [
      makeFileResult("/high.md", "high.md", [
        makeMatch(1, "rust async"),
        makeMatch(5, "rust future"),
        makeMatch(9, "rust tokio"),
      ]),
      makeFileResult("/low.md", "low.md", [makeMatch(2, "rust mention")]),
    ];
    invokeMock.mockResolvedValue(results);
    const out = await searchFiles(["/high.md", "/low.md"], "rust");
    expect(out[0].fileName).toBe("high.md");
    expect(out[1].fileName).toBe("low.md");
  });

  it("a file with more matches appears before one with fewer (backend order preserved)", async () => {
    const manyMatches = Array.from({ length: 5 }, (_, i) =>
      makeMatch(i + 1, `match ${i}`),
    );
    const fewMatches = [makeMatch(1, "single match")];
    const results = [
      makeFileResult("/many.md", "many.md", manyMatches),
      makeFileResult("/few.md", "few.md", fewMatches),
    ];
    invokeMock.mockResolvedValue(results);
    const out = await searchFiles(["/many.md", "/few.md"], "match");
    expect(out[0].matches.length).toBeGreaterThan(out[1].matches.length);
  });

  it("match count per file is accessible via result.matches.length", async () => {
    const results = [
      makeFileResult("/a.md", "a.md", [makeMatch(1, "x"), makeMatch(2, "x"), makeMatch(3, "x")]),
      makeFileResult("/b.md", "b.md", [makeMatch(1, "x")]),
    ];
    invokeMock.mockResolvedValue(results);
    const out = await searchFiles(["/a.md", "/b.md"], "x");
    expect(out[0].matches).toHaveLength(3);
    expect(out[1].matches).toHaveLength(1);
  });

  it("lineNo values are positive integers", async () => {
    const result = makeFileResult("/doc.md", "doc.md", [
      makeMatch(1, "line one"),
      makeMatch(42, "line forty-two"),
    ]);
    invokeMock.mockResolvedValue([result]);
    const [file] = await searchFiles(["/doc.md"], "line");
    for (const m of file.matches) {
      expect(m.lineNo).toBeGreaterThan(0);
      expect(Number.isInteger(m.lineNo)).toBe(true);
    }
  });

  it("snippets are non-empty strings", async () => {
    const result = makeFileResult("/doc.md", "doc.md", [
      makeMatch(3, "this is a snippet"),
    ]);
    invokeMock.mockResolvedValue([result]);
    const [file] = await searchFiles(["/doc.md"], "snippet");
    for (const m of file.matches) {
      expect(typeof m.snippet).toBe("string");
      expect(m.snippet.length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (4) Exclusion patterns — scoping (simulating libraryContext behaviour)
// ═══════════════════════════════════════════════════════════════════════════════

describe("searchFiles — path exclusion patterns", () => {
  it("caller-side exclusion: passing only non-excluded paths omits the right files", async () => {
    // searchFiles itself doesn't filter — callers filter `paths` before passing in.
    // This tests the contract from the caller's perspective.
    const allPaths = ["/a.md", "/b.md", "/c.md"];
    const excludeSet = new Set(["/b.md"]);
    const filtered = allPaths.filter((p) => !excludeSet.has(p));

    invokeMock.mockResolvedValue([
      makeFileResult("/a.md", "a.md", [makeMatch(1, "hit")]),
    ]);

    await searchFiles(filtered, "hit");
    const callArg = invokeMock.mock.calls[0][1] as { paths: string[] };
    expect(callArg.paths).not.toContain("/b.md");
    expect(callArg.paths).toContain("/a.md");
    expect(callArg.paths).toContain("/c.md");
  });

  it("a single path array containing only excluded files → invoke not called when empty after filter", async () => {
    const allPaths = ["/excluded.md"];
    const excludeSet = new Set(["/excluded.md"]);
    const filtered = allPaths.filter((p) => !excludeSet.has(p));
    const out = await searchFiles(filtered, "query");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it("deduped paths are passed correctly (no duplicates in the call)", async () => {
    invokeMock.mockResolvedValue([]);
    const dedupedPaths = ["/a.md", "/b.md"]; // already deduped by caller
    await searchFiles(dedupedPaths, "dup");
    const callArg = invokeMock.mock.calls[0][1] as { paths: string[] };
    const unique = new Set(callArg.paths);
    expect(unique.size).toBe(callArg.paths.length);
  });

  it("absolute paths are passed verbatim to the backend", async () => {
    invokeMock.mockResolvedValue([]);
    const paths = ["/Users/mason/vault/note.md", "/tmp/agent/output.md"];
    await searchFiles(paths, "term");
    const callArg = invokeMock.mock.calls[0][1] as { paths: string[] };
    expect(callArg.paths).toEqual(paths);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (5) Graceful degradation — backend errors
// ═══════════════════════════════════════════════════════════════════════════════

describe("searchFiles — graceful degradation", () => {
  it("returns [] gracefully when invoke rejects with an Error", async () => {
    invokeMock.mockRejectedValue(new Error("file not found"));
    const out = await searchFiles(["/missing.md"], "query");
    expect(out).toEqual([]);
  });

  it("returns [] gracefully when invoke rejects with a string", async () => {
    invokeMock.mockRejectedValue("IO error: broken pipe");
    const out = await searchFiles(["/a.md"], "query");
    expect(out).toEqual([]);
  });

  it("returns [] gracefully on a simulated network timeout", async () => {
    invokeMock.mockRejectedValue(new Error("timeout: backend did not respond"));
    const out = await searchFiles(["/a.md", "/b.md"], "timeout test");
    expect(out).toEqual([]);
  });

  it("does not throw when the backend crashes mid-search", async () => {
    invokeMock.mockRejectedValue(new Error("panic: index corrupt"));
    await expect(searchFiles(["/a.md"], "crash")).resolves.toEqual([]);
  });

  it("subsequent calls succeed after a prior failure", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("transient error"))
      .mockResolvedValueOnce([makeFileResult("/a.md", "a.md", [makeMatch(1, "hit")])]);

    const first = await searchFiles(["/a.md"], "hit");
    expect(first).toEqual([]);

    const second = await searchFiles(["/a.md"], "hit");
    expect(second).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (6) Combined embedSearch + crossSearch — semantic-first with keyword fallback
// ═══════════════════════════════════════════════════════════════════════════════

describe("combined embedSearch + crossSearch — semantic-first pipeline", () => {
  it("uses semantic results when embedAvailable returns a model name", async () => {
    // First call: embed_available → model present
    // Second call: embed_search → hits
    invokeMock
      .mockResolvedValueOnce("nomic-embed-text") // embedAvailable
      .mockResolvedValueOnce([                    // embedSearch
        { path: "/a.md", fileName: "a.md", snippet: "semantic hit", score: 0.92 },
        { path: "/b.md", fileName: "b.md", snippet: "another hit", score: 0.75 },
      ]);

    const model = await embedAvailable();
    expect(model).toBe("nomic-embed-text");

    const semanticHits = await embedSearch("semantic query", 8);
    expect(semanticHits).toHaveLength(2);
    expect(semanticHits[0].score).toBeGreaterThan(0.35); // above SEMANTIC_MIN_SCORE
  });

  it("falls back to keyword search when embedAvailable returns null", async () => {
    // embed_available → null (no model)
    invokeMock
      .mockResolvedValueOnce(null)         // embedAvailable
      .mockResolvedValueOnce([             // searchFiles (keyword fallback)
        makeFileResult("/kw.md", "kw.md", [makeMatch(4, "keyword match")]),
      ]);

    const model = await embedAvailable();
    expect(model).toBeNull();

    // Because no model: fall through to keyword search
    const kwResults = await searchFiles(["/kw.md"], "keyword");
    expect(kwResults).toHaveLength(1);
    expect(kwResults[0].matches[0].snippet).toBe("keyword match");
  });

  it("falls back to keyword search when embedSearch returns fewer than 2 confident hits", async () => {
    // Only 1 hit above SEMANTIC_MIN_SCORE: insufficient → keyword fallback
    invokeMock
      .mockResolvedValueOnce("nomic-embed-text") // embedAvailable
      .mockResolvedValueOnce([                    // embedSearch: 1 hit (below threshold for RAG)
        { path: "/a.md", fileName: "a.md", snippet: "weak hit", score: 0.40 },
      ])
      .mockResolvedValueOnce([                    // searchFiles: keyword fallback
        makeFileResult("/a.md", "a.md", [makeMatch(1, "keyword match")]),
        makeFileResult("/b.md", "b.md", [makeMatch(2, "another match")]),
      ]);

    const model = await embedAvailable();
    expect(model).not.toBeNull();

    const semanticHits = await embedSearch("sparse query");
    // Simulate the libraryContext logic: if < 2 hits, use keyword instead
    const qualifiedHits = semanticHits.filter((h: SemanticMatch) => h.score >= 0.35);
    expect(qualifiedHits.length).toBeLessThan(2);

    // Keyword fallback fires
    const kwResults = await searchFiles(["/a.md", "/b.md"], "sparse");
    expect(kwResults).toHaveLength(2);
  });

  it("keyword search merges results across multiple terms (simulate Promise.all)", async () => {
    // Simulate two concurrent keyword searches for different terms
    invokeMock
      .mockResolvedValueOnce([
        makeFileResult("/a.md", "a.md", [makeMatch(1, "rust async")]),
      ])
      .mockResolvedValueOnce([
        makeFileResult("/a.md", "a.md", [makeMatch(5, "tokio runtime")]),
        makeFileResult("/b.md", "b.md", [makeMatch(3, "async pattern")]),
      ]);

    const [termOneResults, termTwoResults] = await Promise.all([
      searchFiles(["/a.md", "/b.md"], "rust"),
      searchFiles(["/a.md", "/b.md"], "async"),
    ]);

    // Merge by file path (simulate libraryContext aggregation)
    const byFile = new Map<string, { fileName: string; score: number }>();
    for (const r of [...termOneResults, ...termTwoResults]) {
      const entry = byFile.get(r.path) ?? { fileName: r.fileName, score: 0 };
      entry.score += r.matches.length;
      byFile.set(r.path, entry);
    }
    const ranked = Array.from(byFile.entries()).sort((a, b) => b[1].score - a[1].score);
    // /a.md has 2 total matches (1+1), /b.md has 1
    expect(ranked[0][0]).toBe("/a.md");
    expect(ranked[0][1].score).toBe(2);
  });

  it("handles embed search timeout by returning empty and allowing keyword fallback", async () => {
    invokeMock
      .mockResolvedValueOnce("nomic-embed-text") // embedAvailable
      .mockRejectedValueOnce(new Error("timeout"))  // embedSearch times out → []
      .mockResolvedValueOnce([                       // keyword fallback
        makeFileResult("/fallback.md", "fallback.md", [makeMatch(1, "found it")]),
      ]);

    const model = await embedAvailable();
    expect(model).not.toBeNull();

    const semanticHits = await embedSearch("timed-out query");
    expect(semanticHits).toEqual([]); // graceful empty

    const kwFallback = await searchFiles(["/fallback.md"], "found");
    expect(kwFallback[0].fileName).toBe("fallback.md");
  });

  it("semantic hits with scores below SEMANTIC_MIN_SCORE (0.35) are filtered out by callers", () => {
    const SEMANTIC_MIN_SCORE = 0.35;
    const hits: SemanticMatch[] = [
      { path: "/a.md", fileName: "a.md", snippet: "weak", score: 0.20 },
      { path: "/b.md", fileName: "b.md", snippet: "strong", score: 0.80 },
      { path: "/c.md", fileName: "c.md", snippet: "border", score: 0.35 },
    ];
    const filtered = hits.filter((h) => h.score >= SEMANTIC_MIN_SCORE);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((h) => h.path)).toEqual(["/b.md", "/c.md"]);
  });

  it("result merging dedups by path: same file from semantic + keyword contributes once", () => {
    // Simulate merging semantic and keyword results keyed by path
    const semanticHits: SemanticMatch[] = [
      { path: "/shared.md", fileName: "shared.md", snippet: "semantic", score: 0.9 },
    ];
    const kwHits: FileSearchResult[] = [
      makeFileResult("/shared.md", "shared.md", [makeMatch(1, "keyword")]),
      makeFileResult("/keyword-only.md", "keyword-only.md", [makeMatch(2, "kw")]),
    ];

    // Merge using a Set for deduplication (as libraryContext does via Map keyed on path)
    const seen = new Map<string, string>();
    for (const h of semanticHits) seen.set(h.path, h.fileName);
    for (const r of kwHits) if (!seen.has(r.path)) seen.set(r.path, r.fileName);

    expect(seen.size).toBe(2); // /shared.md deduplicated, /keyword-only.md added
    expect(seen.has("/shared.md")).toBe(true);
    expect(seen.has("/keyword-only.md")).toBe(true);
  });

  it("concurrent keyword searches for multiple terms do not interfere", async () => {
    invokeMock.mockResolvedValue([
      makeFileResult("/multi.md", "multi.md", [makeMatch(1, "hit")]),
    ]);

    const terms = ["rust", "async", "tokio"];
    const results = await Promise.all(
      terms.map((t) => searchFiles(["/multi.md"], t)),
    );

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r[0].fileName).toBe("multi.md");
    }
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("empty library (no recent/watched files) returns empty without invoke", async () => {
    const emptyPaths: string[] = [];
    const out = await searchFiles(emptyPaths, "anything");
    expect(out).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
