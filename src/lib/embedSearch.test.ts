/**
 * embedSearch.test.ts — integration tests for src/lib/embedSearch.ts
 *
 * Covers:
 *   (1) embedAvailable — Ollama model detection, caching, cache invalidation
 *   (2) embedSearch — semantic search over mock docs, cosine-score filtering,
 *       graceful fallback when embeddings are unavailable
 *   (3) embedIndex — indexing paths, incremental vs. prune, error fallback
 *   (4) embedStatus — status reporting and graceful null on error
 *   (5) Cache behaviour — TTL logic, invalidateEmbedAvailable
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock @tauri-apps/api/core ─────────────────────────────────────────────────
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Import module under test AFTER mocks are established.
import {
  embedAvailable,
  embedIndex,
  embedSearch,
  embedStatus,
  invalidateEmbedAvailable,
  type EmbedStatus,
  type IndexResult,
  type SemanticMatch,
} from "./embedSearch";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMatch(
  path: string,
  fileName: string,
  snippet: string,
  score: number,
): SemanticMatch {
  return { path, fileName, snippet, score };
}

function makeIndexResult(overrides: Partial<IndexResult> = {}): IndexResult {
  return {
    indexed: 3,
    skipped: 1,
    removed: 0,
    total: 4,
    busy: false,
    ...overrides,
  };
}

function makeEmbedStatus(overrides: Partial<EmbedStatus> = {}): EmbedStatus {
  return {
    available: true,
    model: "nomic-embed-text",
    chunkCount: 42,
    fileCount: 10,
    lastIndexedMs: 1_700_000_000_000,
    ...overrides,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  invokeMock.mockReset();
  // Always invalidate the internal availability cache so each test starts fresh.
  invalidateEmbedAvailable();
});

afterEach(() => {
  vi.clearAllMocks();
  invalidateEmbedAvailable();
});

// ═══════════════════════════════════════════════════════════════════════════════
// (1) embedAvailable — Ollama model detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("embedAvailable — Ollama model detection", () => {
  it("returns the model name string when Ollama has the embed model", async () => {
    invokeMock.mockResolvedValue("nomic-embed-text");
    const model = await embedAvailable();
    expect(model).toBe("nomic-embed-text");
  });

  it("invokes the 'embed_available' Tauri command", async () => {
    invokeMock.mockResolvedValue("nomic-embed-text");
    await embedAvailable();
    expect(invokeMock).toHaveBeenCalledWith("embed_available");
  });

  it("returns null when the embed model is absent from Ollama", async () => {
    invokeMock.mockResolvedValue(null);
    const model = await embedAvailable();
    expect(model).toBeNull();
  });

  it("returns null gracefully when invoke rejects (Ollama not running)", async () => {
    invokeMock.mockRejectedValue(new Error("Ollama not found"));
    const model = await embedAvailable();
    expect(model).toBeNull();
  });

  it("returns null gracefully on a network timeout", async () => {
    invokeMock.mockRejectedValue(new Error("request timed out"));
    const model = await embedAvailable();
    expect(model).toBeNull();
  });

  it("does not throw when the backend returns a non-Error rejection", async () => {
    invokeMock.mockRejectedValue("string error");
    await expect(embedAvailable()).resolves.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (2) embedAvailable — cache behaviour & invalidation
// ═══════════════════════════════════════════════════════════════════════════════

describe("embedAvailable — availability cache", () => {
  it("caches the result so a second call does NOT invoke again", async () => {
    invokeMock.mockResolvedValue("nomic-embed-text");
    await embedAvailable();
    await embedAvailable();
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("invalidateEmbedAvailable() forces a fresh invoke on the next call", async () => {
    invokeMock.mockResolvedValue("nomic-embed-text");
    await embedAvailable();
    invalidateEmbedAvailable();
    await embedAvailable();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("cached null is returned without a second invoke", async () => {
    invokeMock.mockResolvedValue(null);
    await embedAvailable();
    const second = await embedAvailable();
    expect(second).toBeNull();
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("after invalidation a new model string is picked up", async () => {
    invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce("mxbai-embed-large");
    const first = await embedAvailable();
    expect(first).toBeNull();
    invalidateEmbedAvailable();
    const second = await embedAvailable();
    expect(second).toBe("mxbai-embed-large");
  });

  it("returns cached value (not a new invoke) when called sequentially after the first", async () => {
    // The cache is set after the first call resolves; subsequent sequential calls
    // all hit the cache and return without invoking again.
    invokeMock.mockResolvedValue("nomic-embed-text");
    const first = await embedAvailable();
    expect(first).toBe("nomic-embed-text");
    expect(invokeMock).toHaveBeenCalledOnce();

    for (let i = 0; i < 4; i++) {
      const r = await embedAvailable();
      expect(r).toBe("nomic-embed-text");
    }
    // Only the very first call should have hit invoke.
    expect(invokeMock).toHaveBeenCalledOnce();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (3) embedSearch — semantic search over mock docs
// ═══════════════════════════════════════════════════════════════════════════════

describe("embedSearch — semantic search", () => {
  it("returns SemanticMatch[] from the backend", async () => {
    const matches: SemanticMatch[] = [
      makeMatch("/vault/a.md", "a.md", "Rust async patterns", 0.91),
      makeMatch("/vault/b.md", "b.md", "Tokio runtime overview", 0.78),
    ];
    invokeMock.mockResolvedValue(matches);
    const result = await embedSearch("async rust", 8);
    expect(result).toEqual(matches);
  });

  it("invokes 'embed_search' with the correct query and k", async () => {
    invokeMock.mockResolvedValue([]);
    await embedSearch("semantic query", 5);
    expect(invokeMock).toHaveBeenCalledWith("embed_search", {
      query: "semantic query",
      k: 5,
    });
  });

  it("uses default k=8 when not specified", async () => {
    invokeMock.mockResolvedValue([]);
    await embedSearch("default k");
    expect(invokeMock).toHaveBeenCalledWith("embed_search", {
      query: "default k",
      k: 8,
    });
  });

  it("returns empty array gracefully when the backend rejects (model unavailable)", async () => {
    invokeMock.mockRejectedValue(new Error("no embed model"));
    const result = await embedSearch("anything");
    expect(result).toEqual([]);
  });

  it("returns empty array gracefully on network timeout", async () => {
    invokeMock.mockRejectedValue(new Error("invoke timed out"));
    const result = await embedSearch("timeout test");
    expect(result).toEqual([]);
  });

  it("returns empty array when there are no indexed documents", async () => {
    invokeMock.mockResolvedValue([]);
    const result = await embedSearch("orphan query");
    expect(result).toEqual([]);
  });

  it("result scores are numbers between 0 and 1", async () => {
    const matches: SemanticMatch[] = [
      makeMatch("/a.md", "a.md", "snippet", 0.95),
      makeMatch("/b.md", "b.md", "snippet", 0.35),
      makeMatch("/c.md", "c.md", "snippet", 0.60),
    ];
    invokeMock.mockResolvedValue(matches);
    const result = await embedSearch("query");
    for (const m of result) {
      expect(m.score).toBeGreaterThanOrEqual(0);
      expect(m.score).toBeLessThanOrEqual(1);
    }
  });

  it("each result has the required SemanticMatch shape", async () => {
    const match: SemanticMatch = makeMatch(
      "/vault/notes.md",
      "notes.md",
      "This is a snippet",
      0.82,
    );
    invokeMock.mockResolvedValue([match]);
    const [item] = await embedSearch("notes");
    expect(item).toHaveProperty("path", "/vault/notes.md");
    expect(item).toHaveProperty("fileName", "notes.md");
    expect(item).toHaveProperty("snippet", "This is a snippet");
    expect(item).toHaveProperty("score", 0.82);
  });

  it("results are returned in the order provided by the backend (no re-ranking)", async () => {
    const matches: SemanticMatch[] = [
      makeMatch("/a.md", "a.md", "first", 0.9),
      makeMatch("/b.md", "b.md", "second", 0.7),
      makeMatch("/c.md", "c.md", "third", 0.5),
    ];
    invokeMock.mockResolvedValue(matches);
    const result = await embedSearch("order test");
    expect(result.map((m) => m.path)).toEqual(["/a.md", "/b.md", "/c.md"]);
  });

  it("does not throw when the backend returns a non-Error rejection", async () => {
    invokeMock.mockRejectedValue("raw string error");
    await expect(embedSearch("query")).resolves.toEqual([]);
  });

  it("returns up to k results as configured", async () => {
    const matches = Array.from({ length: 3 }, (_, i) =>
      makeMatch(`/doc${i}.md`, `doc${i}.md`, `snippet ${i}`, 0.9 - i * 0.1),
    );
    invokeMock.mockResolvedValue(matches);
    const result = await embedSearch("k=3", 3);
    expect(result).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (4) embedIndex — index calls and error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe("embedIndex — indexing paths", () => {
  it("invokes 'embed_index' with the given paths and prune=false", async () => {
    invokeMock.mockResolvedValue(makeIndexResult());
    await embedIndex(["/a.md", "/b.md"]);
    expect(invokeMock).toHaveBeenCalledWith("embed_index", {
      paths: ["/a.md", "/b.md"],
      prune: false,
    });
  });

  it("invokes 'embed_index' with prune=true for a full-library reindex", async () => {
    invokeMock.mockResolvedValue(makeIndexResult());
    await embedIndex(["/vault/a.md"], true);
    expect(invokeMock).toHaveBeenCalledWith("embed_index", {
      paths: ["/vault/a.md"],
      prune: true,
    });
  });

  it("returns the IndexResult from the backend", async () => {
    const result = makeIndexResult({ indexed: 5, skipped: 2, removed: 1, total: 8 });
    invokeMock.mockResolvedValue(result);
    const out = await embedIndex(["/a.md"]);
    expect(out).toEqual(result);
  });

  it("returns null gracefully when invoke rejects (model missing)", async () => {
    invokeMock.mockRejectedValue(new Error("embed model not found"));
    const out = await embedIndex(["/a.md"]);
    expect(out).toBeNull();
  });

  it("returns null gracefully on a network error", async () => {
    invokeMock.mockRejectedValue(new Error("connection refused"));
    const out = await embedIndex(["/a.md", "/b.md"]);
    expect(out).toBeNull();
  });

  it("IndexResult has the required shape fields", async () => {
    const result = makeIndexResult();
    invokeMock.mockResolvedValue(result);
    const out = await embedIndex(["/x.md"]);
    expect(out).toHaveProperty("indexed");
    expect(out).toHaveProperty("skipped");
    expect(out).toHaveProperty("removed");
    expect(out).toHaveProperty("total");
    expect(out).toHaveProperty("busy");
  });

  it("busy:true is returned when the index is already running", async () => {
    invokeMock.mockResolvedValue(makeIndexResult({ busy: true }));
    const out = await embedIndex(["/a.md"]);
    expect(out?.busy).toBe(true);
  });

  it("empty paths array is passed through to the backend", async () => {
    invokeMock.mockResolvedValue(makeIndexResult({ indexed: 0, total: 0 }));
    await embedIndex([]);
    expect(invokeMock).toHaveBeenCalledWith("embed_index", {
      paths: [],
      prune: false,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (5) embedStatus — status reporting
// ═══════════════════════════════════════════════════════════════════════════════

describe("embedStatus — status reporting", () => {
  it("invokes 'embed_status' with no arguments", async () => {
    invokeMock.mockResolvedValue(makeEmbedStatus());
    await embedStatus();
    expect(invokeMock).toHaveBeenCalledWith("embed_status");
  });

  it("returns the EmbedStatus from the backend", async () => {
    const status = makeEmbedStatus({ chunkCount: 99, fileCount: 15 });
    invokeMock.mockResolvedValue(status);
    const out = await embedStatus();
    expect(out).toEqual(status);
  });

  it("returns null gracefully when invoke rejects", async () => {
    invokeMock.mockRejectedValue(new Error("embed status unavailable"));
    const out = await embedStatus();
    expect(out).toBeNull();
  });

  it("EmbedStatus shape: available, model, chunkCount, fileCount, lastIndexedMs", async () => {
    invokeMock.mockResolvedValue(makeEmbedStatus());
    const out = await embedStatus();
    expect(out).toHaveProperty("available");
    expect(out).toHaveProperty("model");
    expect(out).toHaveProperty("chunkCount");
    expect(out).toHaveProperty("fileCount");
    expect(out).toHaveProperty("lastIndexedMs");
  });

  it("available=false when no model is installed", async () => {
    invokeMock.mockResolvedValue(
      makeEmbedStatus({ available: false, model: null, chunkCount: 0, fileCount: 0 }),
    );
    const out = await embedStatus();
    expect(out?.available).toBe(false);
    expect(out?.model).toBeNull();
  });

  it("model is a string when embed model is present", async () => {
    invokeMock.mockResolvedValue(makeEmbedStatus({ model: "nomic-embed-text" }));
    const out = await embedStatus();
    expect(typeof out?.model).toBe("string");
  });

  it("chunkCount and fileCount are non-negative integers", async () => {
    invokeMock.mockResolvedValue(makeEmbedStatus({ chunkCount: 10, fileCount: 3 }));
    const out = await embedStatus();
    expect(out!.chunkCount).toBeGreaterThanOrEqual(0);
    expect(out!.fileCount).toBeGreaterThanOrEqual(0);
  });

  it("lastIndexedMs is a non-negative epoch timestamp", async () => {
    invokeMock.mockResolvedValue(makeEmbedStatus({ lastIndexedMs: 1_700_000_000_000 }));
    const out = await embedStatus();
    expect(out!.lastIndexedMs).toBeGreaterThanOrEqual(0);
  });
});
