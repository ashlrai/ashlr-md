/**
 * libraryContext.test.ts — tests for src/lib/libraryContext.ts
 *
 * Covers:
 *   (1) Library path collection — recents + watched files + vault, deduped,
 *       exclusions honored, vault enumeration best-effort
 *   (2) Empty-library early return — nothing to search, nothing invoked
 *   (3) Semantic retrieval — scope/score filtering, the 2-confident-hit bar,
 *       per-file and total caps, citation order
 *   (4) Keyword retrieval — term extraction (stopwords, length, dedup, the
 *       6-term cap), per-term concurrent search, match-count ranking, caps
 *   (5) Unicode queries — accented and CJK terms reach the search verbatim
 *       instead of being mangled into ASCII fragments or dropped entirely
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mutable state for the store/IO mocks ────────────────────────────
const state = vi.hoisted(() => ({
  recents: [] as { path: string; fileName: string; openedAt: number }[],
  activityFiles: [] as {
    path: string;
    name: string;
    dir: string;
    mtimeMs: number;
    size: number;
  }[],
  docPath: null as string | null,
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const searchFilesMock = vi.fn();
vi.mock("./crossSearch", () => ({
  searchFiles: (...args: unknown[]) => searchFilesMock(...args),
}));

const embedAvailableMock = vi.fn();
const embedSearchMock = vi.fn();
vi.mock("./embedSearch", () => ({
  embedAvailable: () => embedAvailableMock(),
  embedSearch: (...args: unknown[]) => embedSearchMock(...args),
}));

const effectiveVaultRootMock = vi.fn();
vi.mock("./vault", () => ({
  effectiveVaultRoot: (...args: unknown[]) => effectiveVaultRootMock(...args),
}));

vi.mock("../store/recentStore", () => ({
  useRecentStore: { getState: () => ({ recents: state.recents }) },
}));
vi.mock("../store/activityStore", () => ({
  useActivityStore: { getState: () => ({ files: state.activityFiles }) },
}));
vi.mock("../store/documentStore", () => ({
  useDocumentStore: { getState: () => ({ path: state.docPath }) },
}));

import { retrieveLibraryContext } from "./libraryContext";

// ── Helpers ──────────────────────────────────────────────────────────────────

function addRecent(path: string): void {
  state.recents.push({ path, fileName: path.split("/").pop() ?? path, openedAt: 1 });
}

function addWatched(path: string): void {
  state.activityFiles.push({
    path,
    name: path.split("/").pop() ?? path,
    dir: "/watch",
    mtimeMs: 1,
    size: 10,
  });
}

function fileHit(path: string, matches: { lineNo: number; snippet: string }[]) {
  return { path, fileName: path.split("/").pop() ?? path, matches };
}

function semanticHit(path: string, snippet: string, score: number) {
  return { path, fileName: path.split("/").pop() ?? path, snippet, score };
}

/** Terms the keyword path searched (one searchFiles call per term). */
function searchedTerms(): string[] {
  return searchFilesMock.mock.calls.map((c) => c[1] as string);
}

/** Path lists handed to the keyword search (identical for every term call). */
function searchedPaths(): string[][] {
  return searchFilesMock.mock.calls.map((c) => c[0] as string[]);
}

beforeEach(() => {
  state.recents = [];
  state.activityFiles = [];
  state.docPath = null;
  invokeMock.mockReset();
  searchFilesMock.mockReset().mockResolvedValue([]);
  embedAvailableMock.mockReset().mockResolvedValue(null);
  embedSearchMock.mockReset().mockResolvedValue([]);
  effectiveVaultRootMock.mockReset().mockResolvedValue(null);
});

// ═════════════════════════════════════════════════════════════════════════════
// (1) Library path collection
// ═════════════════════════════════════════════════════════════════════════════

describe("library path collection", () => {
  it("searches the union of recents and watched activity files", async () => {
    addRecent("/docs/one.md");
    addWatched("/docs/two.md");
    await retrieveLibraryContext("quartz crystal");
    expect(searchedPaths()[0]).toEqual(
      expect.arrayContaining(["/docs/one.md", "/docs/two.md"]),
    );
  });

  it("dedupes a path that is both recent and watched", async () => {
    addRecent("/docs/dup.md");
    addWatched("/docs/dup.md");
    await retrieveLibraryContext("quartz crystal");
    const paths = searchedPaths()[0];
    expect(paths.filter((p) => p === "/docs/dup.md")).toHaveLength(1);
  });

  it("adds every vault file when a vault root resolves", async () => {
    state.docPath = "/vault/note.md";
    effectiveVaultRootMock.mockResolvedValue("/vault");
    invokeMock.mockResolvedValue([
      { path: "/vault/deep.md" },
      { path: "/vault/note.md" },
    ]);
    addRecent("/docs/recent.md");
    await retrieveLibraryContext("quartz crystal");
    expect(effectiveVaultRootMock).toHaveBeenCalledWith("/vault/note.md");
    expect(invokeMock).toHaveBeenCalledWith("list_markdown_files", {
      path: "/vault",
      limit: 500,
    });
    expect(searchedPaths()[0]).toEqual(
      expect.arrayContaining(["/docs/recent.md", "/vault/deep.md", "/vault/note.md"]),
    );
  });

  it("asks for no vault listing when no vault root resolves", async () => {
    addRecent("/docs/recent.md");
    await retrieveLibraryContext("quartz crystal");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("still searches recents when vault enumeration fails", async () => {
    state.docPath = "/vault/note.md";
    effectiveVaultRootMock.mockResolvedValue("/vault");
    invokeMock.mockRejectedValue(new Error("permission denied"));
    addRecent("/docs/recent.md");
    const ctx = await retrieveLibraryContext("quartz crystal");
    expect(searchedPaths()[0]).toEqual(["/docs/recent.md"]);
    expect(ctx.citations).toBeDefined();
  });

  it("excludes excludePaths from every source (recents, watched, vault)", async () => {
    addRecent("/docs/self.md");
    addWatched("/docs/watched.md");
    state.docPath = "/vault/v.md";
    effectiveVaultRootMock.mockResolvedValue("/vault");
    invokeMock.mockResolvedValue([{ path: "/vault/v.md" }]);
    await retrieveLibraryContext("quartz crystal", ["/docs/self.md", "/vault/v.md"]);
    const paths = searchedPaths()[0];
    expect(paths).toEqual(["/docs/watched.md"]);
    expect(paths).not.toContain("/docs/self.md");
    expect(paths).not.toContain("/vault/v.md");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (2) Empty-library early return
// ═════════════════════════════════════════════════════════════════════════════

describe("empty library", () => {
  it("returns an empty context without probing embeddings or searching", async () => {
    const ctx = await retrieveLibraryContext("quartz crystal");
    expect(ctx).toEqual({ block: "", citations: [] });
    expect(embedAvailableMock).not.toHaveBeenCalled();
    expect(embedSearchMock).not.toHaveBeenCalled();
    expect(searchFilesMock).not.toHaveBeenCalled();
  });

  it("returns empty when every candidate path is excluded", async () => {
    addRecent("/docs/self.md");
    const ctx = await retrieveLibraryContext("quartz crystal", ["/docs/self.md"]);
    expect(ctx).toEqual({ block: "", citations: [] });
    expect(searchFilesMock).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (3) Semantic retrieval
// ═════════════════════════════════════════════════════════════════════════════

describe("semantic retrieval", () => {
  beforeEach(() => {
    addRecent("/docs/a.md");
    addWatched("/docs/b.md");
    embedAvailableMock.mockResolvedValue("nomic-embed-text");
  });

  it("uses semantic hits when two or more qualify, and skips keyword search", async () => {
    embedSearchMock.mockResolvedValue([
      semanticHit("/docs/a.md", "alpha excerpt", 0.9),
      semanticHit("/docs/b.md", "beta excerpt", 0.7),
    ]);
    const ctx = await retrieveLibraryContext("quartz crystal");
    expect(embedSearchMock).toHaveBeenCalledWith("quartz crystal", 8);
    expect(searchFilesMock).not.toHaveBeenCalled();
    expect(ctx.block).toContain("### a.md\nalpha excerpt");
    expect(ctx.block).toContain("### b.md\nbeta excerpt");
    expect(ctx.citations).toEqual([
      { fileName: "a.md", path: "/docs/a.md" },
      { fileName: "b.md", path: "/docs/b.md" },
    ]);
  });

  it("drops hits outside the current library scope", async () => {
    embedSearchMock.mockResolvedValue([
      semanticHit("/old/removed.md", "stale excerpt", 0.95),
      semanticHit("/docs/a.md", "alpha excerpt", 0.9),
      semanticHit("/docs/b.md", "beta excerpt", 0.7),
    ]);
    const ctx = await retrieveLibraryContext("quartz crystal");
    expect(ctx.block).not.toContain("removed.md");
    expect(ctx.citations.map((c) => c.path)).toEqual(["/docs/a.md", "/docs/b.md"]);
  });

  it("drops hits for excluded paths (the open document)", async () => {
    addWatched("/docs/c.md");
    embedSearchMock.mockResolvedValue([
      semanticHit("/docs/a.md", "alpha excerpt", 0.9),
      semanticHit("/docs/b.md", "beta excerpt", 0.7),
      semanticHit("/docs/c.md", "gamma excerpt", 0.6),
    ]);
    const ctx = await retrieveLibraryContext("quartz crystal", ["/docs/a.md"]);
    expect(ctx.block).not.toContain("alpha excerpt");
    expect(ctx.citations).toEqual([
      { fileName: "b.md", path: "/docs/b.md" },
      { fileName: "c.md", path: "/docs/c.md" },
    ]);
  });

  it("exclusion that leaves under two confident hits falls back to keywords", async () => {
    embedSearchMock.mockResolvedValue([
      semanticHit("/docs/a.md", "alpha excerpt", 0.9),
      semanticHit("/docs/b.md", "beta excerpt", 0.7),
    ]);
    searchFilesMock.mockResolvedValue([
      fileHit("/docs/b.md", [{ lineNo: 2, snippet: "keyword line" }]),
    ]);
    const ctx = await retrieveLibraryContext("quartz crystal", ["/docs/a.md"]);
    expect(searchFilesMock).toHaveBeenCalled();
    expect(ctx.block).toContain("keyword line");
  });

  it("drops hits below the 0.35 confidence floor", async () => {
    embedSearchMock.mockResolvedValue([
      semanticHit("/docs/a.md", "weak excerpt", 0.2),
      semanticHit("/docs/b.md", "beta excerpt", 0.5),
      semanticHit("/docs/a.md", "alpha excerpt", 0.8),
    ]);
    const ctx = await retrieveLibraryContext("quartz crystal");
    expect(ctx.block).not.toContain("weak excerpt");
    expect(ctx.citations.map((c) => c.path)).toEqual(["/docs/b.md", "/docs/a.md"]);
  });

  it("falls back to keyword search with a single confident hit", async () => {
    embedSearchMock.mockResolvedValue([semanticHit("/docs/a.md", "lone hit", 0.9)]);
    searchFilesMock.mockResolvedValue([
      fileHit("/docs/b.md", [{ lineNo: 2, snippet: "keyword line" }]),
    ]);
    const ctx = await retrieveLibraryContext("quartz crystal");
    expect(searchFilesMock).toHaveBeenCalled();
    expect(ctx.block).toContain("keyword line");
  });

  it("falls back to keyword search when embedSearch returns nothing", async () => {
    // embedSearch itself swallows backend errors, so "no hits" reaches the
    // retriever as an empty array — which must still yield keyword excerpts.
    embedSearchMock.mockResolvedValue([]);
    searchFilesMock.mockResolvedValue([
      fileHit("/docs/a.md", [{ lineNo: 1, snippet: "fallback line" }]),
    ]);
    const ctx = await retrieveLibraryContext("quartz crystal");
    expect(ctx.block).toContain("fallback line");
  });

  it("groups up to 4 snippets per file under one heading", async () => {
    embedSearchMock.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) =>
        semanticHit("/docs/a.md", `snippet ${i + 1}`, 0.9 - i * 0.05),
      ),
    );
    const ctx = await retrieveLibraryContext("quartz crystal");
    expect(ctx.block).toContain("snippet 4");
    expect(ctx.block).not.toContain("snippet 5");
    expect(ctx.block.match(/### a\.md/g)).toHaveLength(1);
    expect(ctx.citations).toHaveLength(1);
  });

  it("cites at most 5 files even when more qualify", async () => {
    for (let i = 0; i < 7; i++) addWatched(`/docs/f${i}.md`);
    embedSearchMock.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) =>
        semanticHit(`/docs/f${i}.md`, `hit ${i}`, 0.9 - i * 0.05),
      ),
    );
    const ctx = await retrieveLibraryContext("quartz crystal");
    expect(ctx.citations).toHaveLength(5);
    expect(ctx.citations.map((c) => c.path)).toEqual([
      "/docs/f0.md",
      "/docs/f1.md",
      "/docs/f2.md",
      "/docs/f3.md",
      "/docs/f4.md",
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (4) Keyword retrieval
// ═════════════════════════════════════════════════════════════════════════════

describe("keyword retrieval", () => {
  beforeEach(() => {
    addRecent("/docs/a.md");
    addWatched("/docs/b.md");
  });

  it("searches once per extracted term, with a per-term limit of 50", async () => {
    await retrieveLibraryContext("quartz crystal lattice");
    expect(searchedTerms()).toEqual(["quartz", "crystal", "lattice"]);
    for (const call of searchFilesMock.mock.calls) {
      expect(call[2]).toBe(50);
    }
  });

  it("drops stopwords, short words and duplicates from the term list", async () => {
    await retrieveLibraryContext("what is the best way to do quartz on on quartz?");
    expect(searchedTerms()).toEqual(["best", "way", "quartz"]);
    // "quartz" repeats in the question but is searched once.
    expect(searchedTerms().filter((t) => t === "quartz")).toHaveLength(1);
  });

  it("stops after six real terms (not after six tokens)", async () => {
    await retrieveLibraryContext(
      "the quick brown fox jumps over lazy dogs and extra words beyond",
    );
    // Stopwords ("the", "over", "and") don't count toward the cap; the first
    // six real terms are searched, the rest are dropped.
    expect(searchedTerms()).toEqual(["quick", "brown", "fox", "jumps", "lazy", "dogs"]);
  });

  it("returns an empty context when the query has no usable terms", async () => {
    await retrieveLibraryContext("what is the best way to do it?");
    // "best" and "way" are the only usable terms — so this is not empty.
    expect(searchFilesMock).toHaveBeenCalled();
    const ctx = await retrieveLibraryContext("what is it and how do you do it");
    expect(ctx).toEqual({ block: "", citations: [] });
  });

  it("returns an empty context when nothing matches", async () => {
    const ctx = await retrieveLibraryContext("quartz crystal");
    expect(ctx).toEqual({ block: "", citations: [] });
  });

  it("ranks files by total match count across terms", async () => {
    // "quartz" hits /docs/a.md once; "crystal" hits it twice — /docs/a.md
    // outranks /docs/b.md which matched only once.
    searchFilesMock.mockImplementation((_paths: string[], term: string) => {
      if (term === "quartz")
        return Promise.resolve([
          fileHit("/docs/a.md", [{ lineNo: 1, snippet: "q1" }]),
          fileHit("/docs/b.md", [{ lineNo: 3, snippet: "qb" }]),
        ]);
      return Promise.resolve([
        fileHit("/docs/a.md", [
          { lineNo: 5, snippet: "c1" },
          { lineNo: 9, snippet: "c2" },
        ]),
      ]);
    });
    const ctx = await retrieveLibraryContext("quartz crystal");
    expect(ctx.citations.map((c) => c.path)).toEqual(["/docs/a.md", "/docs/b.md"]);
    expect(ctx.block.indexOf("### a.md")).toBeLessThan(ctx.block.indexOf("### b.md"));
  });

  it("keeps at most 4 snippets per file and takes the first two per term", async () => {
    searchFilesMock.mockImplementation((_paths: string[], term: string) =>
      Promise.resolve([
        fileHit("/docs/a.md", [
          { lineNo: 1, snippet: `${term}-one` },
          { lineNo: 2, snippet: `${term}-two` },
          { lineNo: 3, snippet: `${term}-three` },
        ]),
      ]),
    );
    const ctx = await retrieveLibraryContext("quartz crystal lattice");
    expect(ctx.block).toContain("quartz-one");
    expect(ctx.block).toContain("quartz-two");
    expect(ctx.block).not.toContain("quartz-three");
    // 3 terms × 2 snippets = 6 pushed; the rendered cap of 4 keeps the first
    // two terms' pairs and drops the third term's entirely.
    expect(ctx.block).toContain("crystal-two");
    expect(ctx.block).not.toContain("lattice-one");
  });

  it("cites at most 5 files by score", async () => {
    for (let i = 0; i < 8; i++) addWatched(`/docs/k${i}.md`);
    searchFilesMock.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) =>
        fileHit(`/docs/k${i}.md`, [{ lineNo: 1, snippet: `s${i}` }]),
      ),
    );
    const ctx = await retrieveLibraryContext("quartz crystal");
    expect(ctx.citations).toHaveLength(5);
    expect(ctx.block).toContain("### k4.md");
    expect(ctx.block).not.toContain("### k5.md");
  });

  it("still cites a file when only some of the terms matched it", async () => {
    // A term with zero matches anywhere contributes nothing; other terms'
    // hits still surface.
    searchFilesMock.mockImplementation((_paths: string[], term: string) =>
      term === "crystal"
        ? Promise.resolve([])
        : Promise.resolve([fileHit("/docs/a.md", [{ lineNo: 1, snippet: "hit" }])]),
    );
    const ctx = await retrieveLibraryContext("quartz crystal");
    expect(ctx.block).toContain("hit");
  });

  it("prefixes the context block and separates file sections", async () => {
    searchFilesMock.mockResolvedValue([
      fileHit("/docs/a.md", [{ lineNo: 1, snippet: "alpha" }]),
      fileHit("/docs/b.md", [{ lineNo: 2, snippet: "beta" }]),
    ]);
    const ctx = await retrieveLibraryContext("quartz");
    expect(
      ctx.block.startsWith("Relevant excerpts from the user's Markdown library:"),
    ).toBe(true);
    expect(ctx.block).toContain("### a.md\nalpha");
    expect(ctx.block).toContain("### b.md\nbeta");
    expect(ctx.block).toContain("\n\n### b.md");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (5) Unicode queries — regression for [^a-z0-9] term splitting
// ═════════════════════════════════════════════════════════════════════════════

describe("unicode queries", () => {
  beforeEach(() => {
    addRecent("/docs/a.md");
  });

  it("searches an accented word whole instead of as ASCII fragments", async () => {
    await retrieveLibraryContext("café quality");
    // Before the fix, "café" split on é and searched the fragment "caf".
    expect(searchedTerms()).toEqual(["café", "quality"]);
  });

  it("keeps a word that is only usable after Unicode-aware splitting", async () => {
    await retrieveLibraryContext("naïve approach");
    // "naïve" used to fragment into "na" + "ve" — both under 3 chars, so the
    // whole term vanished; only "approach" was searched.
    expect(searchedTerms()).toEqual(["naïve", "approach"]);
  });

  it("searches CJK terms verbatim", async () => {
    await retrieveLibraryContext("検索 要確認 checklist");
    expect(searchedTerms()).toEqual(["検索", "要確認", "checklist"]);
  });

  it("retrieves context for a query that is entirely non-ASCII", async () => {
    // Before the fix a CJK-only query produced zero terms and an empty
    // context no matter what the library contained.
    searchFilesMock.mockResolvedValue([
      fileHit("/docs/a.md", [{ lineNo: 1, snippet: "要確認の項目を一覧化" }]),
    ]);
    const ctx = await retrieveLibraryContext("要確認 項目");
    expect(searchFilesMock).toHaveBeenCalled();
    expect(ctx.citations).toEqual([{ fileName: "a.md", path: "/docs/a.md" }]);
    expect(ctx.block).toContain("要確認の項目を一覧化");
  });

  it("still drops a single non-ASCII character as too noisy to search", async () => {
    await retrieveLibraryContext("検 索 checklist");
    expect(searchedTerms()).toEqual(["checklist"]);
  });

  it("still drops short ASCII words the length rule always excluded", async () => {
    await retrieveLibraryContext("go to my quartz page");
    expect(searchedTerms()).toEqual(["quartz", "page"]);
  });
});
