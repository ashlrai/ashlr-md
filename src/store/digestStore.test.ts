import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── External dependency mocks ────────────────────────────────────────────────
// These must be hoisted before any import of digestStore.

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Control which AI provider the store sees.
const getCachedProviderMock = vi.fn<() => null>();
const detectProviderMock = vi.fn();
vi.mock("../ai/registry", () => ({
  getCachedProvider: () => getCachedProviderMock(),
  detectProvider: () => detectProviderMock(),
}));

// Control the file listing returned to generate().
const listMarkdownFilesMock = vi.fn();
vi.mock("../lib/activity", () => ({
  listMarkdownFiles: (...args: unknown[]) => listMarkdownFilesMock(...args),
}));

// Control which watched directory is set.
const watchedDir = { value: "/watch" };
vi.mock("./activityStore", () => ({
  useActivityStore: {
    getState: () => ({ watchedDir: watchedDir.value }),
  },
}));

import { useDigestStore } from "./digestStore";
import type { MdFileInfo } from "../lib/activity";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(name: string, mtimeMs: number): MdFileInfo {
  return { name, path: `/watch/${name}`, dir: "/watch", mtimeMs, size: 0 };
}

/** Noop AI provider — generate() returns an empty async iterable. */
const NOOP_PROVIDER = {
  id: "noop",
  generate: vi.fn(),
};

/** A provider that streams a fixed summary. */
function makeStreamingProvider(summary: string) {
  return {
    id: "ollama",
    generate: vi.fn(async function* () {
      yield summary;
    }),
  };
}

function reset() {
  useDigestStore.setState({
    status: "hidden",
    changedFiles: [],
    summary: "",
    genId: 0,
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("digestStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCachedProviderMock.mockReturnValue(null);
    detectProviderMock.mockResolvedValue(NOOP_PROVIDER);
    invokeMock.mockResolvedValue({ content: "# test content" });
    watchedDir.value = "/watch";
    reset();
  });

  afterEach(() => {
    reset();
  });

  // ── Default / initial state ─────────────────────────────────────────────

  it("starts with status=hidden, empty files, and empty summary", () => {
    const s = useDigestStore.getState();
    expect(s.status).toBe("hidden");
    expect(s.changedFiles).toHaveLength(0);
    expect(s.summary).toBe("");
    expect(s.genId).toBe(0);
  });

  // ── generate() guard conditions ─────────────────────────────────────────

  it("generate() is a no-op when no watchedDir is set", async () => {
    watchedDir.value = null as unknown as string;
    await useDigestStore.getState().generate(0);
    expect(useDigestStore.getState().status).toBe("hidden");
    expect(listMarkdownFilesMock).not.toHaveBeenCalled();
  });

  it("generate() is a no-op when status is already computing", async () => {
    useDigestStore.setState({ status: "computing" });
    await useDigestStore.getState().generate(0);
    // Should not have scanned files.
    expect(listMarkdownFilesMock).not.toHaveBeenCalled();
  });

  it("generate() is a no-op when no files changed since sinceMs", async () => {
    const past = Date.now() - 10_000;
    // All files are older than sinceMs.
    listMarkdownFilesMock.mockResolvedValue([makeFile("old.md", past - 1000)]);
    await useDigestStore.getState().generate(past);
    expect(useDigestStore.getState().status).toBe("hidden");
  });

  it("generate() is a no-op when listMarkdownFiles throws", async () => {
    listMarkdownFilesMock.mockRejectedValue(new Error("fs error"));
    await useDigestStore.getState().generate(0);
    expect(useDigestStore.getState().status).toBe("hidden");
  });

  // ── generate() happy path (noop AI provider) ────────────────────────────

  it("transitions to computing then ready when files changed", async () => {
    const sinceMs = Date.now() - 5000;
    const changed = [makeFile("notes.md", sinceMs + 1000)];
    listMarkdownFilesMock.mockResolvedValue(changed);

    const gen = useDigestStore.getState().generate(sinceMs);
    // Status should flip to computing as the promise begins.
    // (We check after awaiting since everything is sync-enough in happy-dom.)
    await gen;

    const s = useDigestStore.getState();
    expect(s.status).toBe("ready");
    expect(s.changedFiles).toHaveLength(1);
    expect(s.changedFiles[0].name).toBe("notes.md");
  });

  it("uses cached provider when available (skips detectProvider)", async () => {
    const sinceMs = Date.now() - 5000;
    listMarkdownFilesMock.mockResolvedValue([makeFile("a.md", sinceMs + 100)]);
    const cachedProvider = makeStreamingProvider("cached summary");
    getCachedProviderMock.mockReturnValue(cachedProvider as unknown as null);

    await useDigestStore.getState().generate(sinceMs);

    expect(detectProviderMock).not.toHaveBeenCalled();
    expect(getCachedProviderMock).toHaveBeenCalled();
  });

  it("falls back to a plain file list when AI provider is noop", async () => {
    const sinceMs = Date.now() - 5000;
    listMarkdownFilesMock.mockResolvedValue([makeFile("report.md", sinceMs + 100)]);
    detectProviderMock.mockResolvedValue(NOOP_PROVIDER);

    await useDigestStore.getState().generate(sinceMs);

    const s = useDigestStore.getState();
    expect(s.status).toBe("ready");
    // Fallback list includes the filename.
    expect(s.summary).toContain("report.md");
  });

  it("uses the streaming provider summary when AI is available", async () => {
    const sinceMs = Date.now() - 5000;
    listMarkdownFilesMock.mockResolvedValue([makeFile("sprint.md", sinceMs + 100)]);
    const provider = makeStreamingProvider("Sprint 42 wrapped up.");
    detectProviderMock.mockResolvedValue(provider);
    invokeMock.mockResolvedValue({ content: "# sprint notes" });

    await useDigestStore.getState().generate(sinceMs);

    expect(useDigestStore.getState().summary).toBe("Sprint 42 wrapped up.");
  });

  // ── dismiss() ────────────────────────────────────────────────────────────

  it("dismiss() resets status to hidden and clears files/summary", () => {
    useDigestStore.setState({
      status: "ready",
      changedFiles: [makeFile("x.md", 1000)],
      summary: "something changed",
      genId: 1,
    });
    useDigestStore.getState().dismiss();
    const s = useDigestStore.getState();
    expect(s.status).toBe("hidden");
    expect(s.changedFiles).toHaveLength(0);
    expect(s.summary).toBe("");
  });

  it("dismiss() increments genId to invalidate in-flight generate()", () => {
    useDigestStore.setState({ genId: 3 });
    useDigestStore.getState().dismiss();
    expect(useDigestStore.getState().genId).toBe(4);
  });

  it("dismiss() is idempotent when already hidden", () => {
    useDigestStore.getState().dismiss();
    useDigestStore.getState().dismiss();
    const s = useDigestStore.getState();
    expect(s.status).toBe("hidden");
    expect(s.genId).toBe(2);
  });

  // ── genId supersession (stale result guard) ──────────────────────────────

  it("dismiss() while computing bumps genId so in-flight result is discarded", async () => {
    // Verify the guard mechanism: generate() increments genId by 1 when it starts,
    // dismiss() also increments by 1 — if both fire, genId at commit differs from
    // what generate() captured, so the commit is skipped.
    useDigestStore.setState({ genId: 5 });
    useDigestStore.getState().dismiss(); // genId → 6, status → hidden

    expect(useDigestStore.getState().genId).toBe(6);
    expect(useDigestStore.getState().status).toBe("hidden");

    // A fresh generate() captures genId=6, increments to 7, then commits at 7.
    const sinceMs = Date.now() - 5000;
    listMarkdownFilesMock.mockResolvedValue([makeFile("fresh.md", sinceMs + 100)]);
    await useDigestStore.getState().generate(sinceMs);

    expect(useDigestStore.getState().status).toBe("ready");
    // generate() incremented genId from 6 → 7 when it started.
    expect(useDigestStore.getState().genId).toBe(7);
  });

  it("genId mismatch: dismiss mid-flight discards the summarize result", async () => {
    // The barrier is placed inside the AI generator (after listMarkdownFiles resolves
    // and generate() has already set status=computing and captured genId).
    let resolveGen!: () => void;
    const genBarrier = new Promise<void>((res) => { resolveGen = res; });
    detectProviderMock.mockResolvedValue({
      id: "ollama",
      generate: vi.fn(async function* () {
        await genBarrier;
        yield "summary text";
      }),
    });
    invokeMock.mockResolvedValue({ content: "# content" });

    const sinceMs = Date.now() - 5000;
    listMarkdownFilesMock.mockResolvedValue([makeFile("x.md", sinceMs + 100)]);

    // Start generate() — it will pause inside the AI generator at genBarrier.
    const genPromise = useDigestStore.getState().generate(sinceMs);

    // Yield the microtask queue so generate() advances past listMarkdownFiles and
    // sets status=computing before we dismiss.
    await Promise.resolve();
    await Promise.resolve();

    // At this point generate() is paused inside summarize() waiting for genBarrier.
    // dismiss() bumps genId → the captured genId inside generate() is now stale.
    useDigestStore.getState().dismiss();

    // Unblock the AI generator and let generate() finish.
    resolveGen();
    await genPromise;

    // The stale result must NOT have overwritten the dismissed state.
    expect(useDigestStore.getState().status).toBe("hidden");
  });

  // ── Clock-skew guard ─────────────────────────────────────────────────────

  it("filters out future-dated files (clock-skew guard)", async () => {
    const sinceMs = Date.now() - 5000;
    const futureFile = makeFile("future.md", Date.now() + 100_000);
    const presentFile = makeFile("present.md", sinceMs + 100);
    listMarkdownFilesMock.mockResolvedValue([futureFile, presentFile]);

    await useDigestStore.getState().generate(sinceMs);

    const { changedFiles } = useDigestStore.getState();
    expect(changedFiles.find((f) => f.name === "future.md")).toBeUndefined();
    expect(changedFiles.find((f) => f.name === "present.md")).toBeDefined();
  });

  // ── MAX_FILES cap (only first 8 files forwarded to AI) ──────────────────

  it("caps changedFiles passed to AI at MAX_FILES=8", async () => {
    const sinceMs = Date.now() - 5000;
    const manyFiles = Array.from({ length: 15 }, (_, i) =>
      makeFile(`file${i}.md`, sinceMs + 100 + i),
    );
    listMarkdownFilesMock.mockResolvedValue(manyFiles);
    const provider = makeStreamingProvider("lots changed");
    detectProviderMock.mockResolvedValue(provider);
    invokeMock.mockResolvedValue({ content: "content" });

    await useDigestStore.getState().generate(sinceMs);

    // invoke (read_markdown_file) should have been called at most MAX_FILES=8 times.
    const readCalls = invokeMock.mock.calls.filter(
      (c) => c[0] === "read_markdown_file",
    );
    expect(readCalls.length).toBeLessThanOrEqual(8);
  });

  // ── AI failure fallback ─────────────────────────────────────────────────

  it("falls back to file list when AI throws", async () => {
    const sinceMs = Date.now() - 5000;
    listMarkdownFilesMock.mockResolvedValue([makeFile("err.md", sinceMs + 100)]);
    detectProviderMock.mockResolvedValue({
      id: "ollama",
      generate: vi.fn(async function* () {
        throw new Error("AI offline");
      }),
    });
    invokeMock.mockResolvedValue({ content: "# content" });

    await useDigestStore.getState().generate(sinceMs);

    const s = useDigestStore.getState();
    expect(s.status).toBe("ready");
    expect(s.summary).toContain("err.md");
  });
});
