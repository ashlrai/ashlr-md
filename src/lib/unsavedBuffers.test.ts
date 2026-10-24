import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  save: vi.fn(),
  message: vi.fn(),
}));
vi.mock("../store/recentStore", () => ({
  isMissingFileError: () => false,
  useRecentStore: { getState: () => ({ add: vi.fn(), remove: vi.fn() }) },
}));

import { type Tab, useDocumentStore } from "../store/documentStore";
import {
  BUFFERS_KEY,
  collectBuffers,
  discardBuffers,
  flushBuffers,
  MAX_BUFFER_CHARS,
  readBuffers,
  restoreBuffers,
  restoreMessage,
  startKeepingBuffers,
  writeBuffers,
} from "./unsavedBuffers";

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    key: `/d/${id}.md`,
    path: `/d/${id}.md`,
    fileName: `${id}.md`,
    content: "x",
    diskContent: "x",
    size: 1,
    viewMode: "read",
    isDirty: false,
    externalChange: false,
    pendingDisk: null,
    diskVersion: null,
    pendingVersion: null,
    missing: false,
    reloadNonce: 0,
    splitView: false,
    ...over,
  };
}

function reset() {
  useDocumentStore.setState({
    path: null,
    fileName: "",
    content: "",
    diskContent: "",
    isDirty: false,
    externalChange: false,
    pendingDisk: null,
    diskVersion: null,
    pendingVersion: null,
    missing: false,
    error: null,
    tabs: [],
    activeId: null,
  });
}

/** Disk files the mocked `read_markdown_file` serves. */
let disk: Record<string, string> = {};

beforeEach(() => {
  reset();
  disk = {};
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args: { path?: string }) => {
    if (cmd === "read_markdown_file") {
      const path = args.path as string;
      if (!(path in disk)) throw new Error("No such file or directory (os error 2)");
      return {
        path,
        file_name: path.split("/").pop(),
        content: disk[path],
        size: disk[path].length,
        version: "v1",
      };
    }
    return undefined;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const openPath = (p: string) => useDocumentStore.getState().openPath(p);

describe("collectBuffers", () => {
  it("keeps only dirty tabs, the active one from the live mirror", () => {
    useDocumentStore.setState({
      tabs: [tab("a"), tab("b", { isDirty: true, content: "b2" })],
      activeId: "a",
      path: "/d/a.md",
      fileName: "a.md",
      content: "a2",
      diskContent: "x",
      isDirty: true,
    });
    expect(collectBuffers(useDocumentStore.getState())).toEqual([
      { path: "/d/a.md", fileName: "a.md", content: "a2", base: "x" },
      { path: "/d/b.md", fileName: "b.md", content: "b2", base: "x" },
    ]);
  });

  it("skips a document past the size limit", () => {
    const big = "y".repeat(MAX_BUFFER_CHARS + 1);
    useDocumentStore.setState({
      tabs: [
        tab("a", { isDirty: true, content: big }),
        tab("b", { isDirty: true, content: "b2" }),
      ],
      activeId: null,
    });
    expect(collectBuffers(useDocumentStore.getState()).map((b) => b.path)).toEqual([
      "/d/b.md",
    ]);
  });
});

describe("readBuffers", () => {
  it("reads what was written and skips damaged entries", () => {
    writeBuffers([{ path: "/d/a.md", fileName: "a.md", content: "a2", base: "x" }]);
    expect(readBuffers()).toHaveLength(1);
    localStorage.setItem(
      BUFFERS_KEY,
      JSON.stringify({
        buffers: [
          { path: "/d/a.md", fileName: "a.md", content: "a2", base: "x" },
          { path: "/d/a.md", fileName: "a.md", content: "dup", base: "x" },
          { path: 3 },
          null,
        ],
      }),
    );
    expect(readBuffers().map((b) => b.content)).toEqual(["a2"]);
    localStorage.setItem(BUFFERS_KEY, "{not json");
    expect(readBuffers()).toEqual([]);
    writeBuffers([]);
    expect(localStorage.getItem(BUFFERS_KEY)).toBeNull();
  });
});

describe("startKeepingBuffers", () => {
  it("writes unsaved text after a pause, and flushes on demand", async () => {
    vi.useFakeTimers();
    disk["/d/a.md"] = "hello";
    await openPath("/d/a.md");
    const k = startKeepingBuffers();
    useDocumentStore.getState().setContent("hello world");
    expect(readBuffers()).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(readBuffers()).toEqual([
      { path: "/d/a.md", fileName: "a.md", content: "hello world", base: "hello" },
    ]);
    useDocumentStore.getState().setContent("hello again");
    flushBuffers();
    expect(readBuffers()[0].content).toBe("hello again");
    // Back to the disk text: nothing unsaved, nothing kept.
    useDocumentStore.getState().setContent("hello");
    vi.advanceTimersByTime(600);
    expect(localStorage.getItem(BUFFERS_KEY)).toBeNull();
    k.stop();
  });

  it("discard forgets the kept text and keeps nothing more", async () => {
    vi.useFakeTimers();
    disk["/d/a.md"] = "hello";
    await openPath("/d/a.md");
    startKeepingBuffers();
    useDocumentStore.getState().setContent("edited");
    flushBuffers();
    expect(readBuffers()).toHaveLength(1);
    discardBuffers();
    expect(localStorage.getItem(BUFFERS_KEY)).toBeNull();
    useDocumentStore.getState().setContent("edited again");
    vi.advanceTimersByTime(600);
    flushBuffers();
    expect(localStorage.getItem(BUFFERS_KEY)).toBeNull();
  });
});

describe("restoreBuffers", () => {
  it("puts unsaved text back in its tab, unsaved, and keeps the active tab", async () => {
    disk["/d/a.md"] = "a disk";
    disk["/d/b.md"] = "b disk";
    await openPath("/d/a.md");
    const active = useDocumentStore.getState().activeId;
    writeBuffers([
      { path: "/d/b.md", fileName: "b.md", content: "b edited", base: "b disk" },
    ]);
    const r = await restoreBuffers(openPath);
    expect(r).toEqual({ restored: ["b.md"], lost: [] });
    const s = useDocumentStore.getState();
    expect(s.activeId).toBe(active);
    const b = s.tabs.find((t) => t.path === "/d/b.md") as Tab;
    expect(b.content).toBe("b edited");
    expect(b.isDirty).toBe(true);
    expect(b.externalChange).toBe(false);
  });

  it("offers the disk text when the file changed since the edits began", async () => {
    disk["/d/a.md"] = "changed elsewhere";
    writeBuffers([
      { path: "/d/a.md", fileName: "a.md", content: "mine", base: "original" },
    ]);
    await restoreBuffers(openPath);
    const s = useDocumentStore.getState();
    expect(s.content).toBe("mine");
    expect(s.isDirty).toBe(true);
    expect(s.externalChange).toBe(true);
    expect(s.pendingDisk).toBe("changed elsewhere");
  });

  it("skips text that was saved after all, and reports a file that is gone", async () => {
    disk["/d/a.md"] = "saved";
    writeBuffers([
      { path: "/d/a.md", fileName: "a.md", content: "saved", base: "old" },
      { path: "/d/gone.md", fileName: "gone.md", content: "lost", base: "" },
    ]);
    const r = await restoreBuffers(openPath);
    expect(r).toEqual({ restored: [], lost: ["gone.md"] });
    expect(useDocumentStore.getState().isDirty).toBe(false);
    expect(useDocumentStore.getState().error).toBeNull();
  });
});

describe("restoreMessage", () => {
  it("says what came back and what did not, once", () => {
    expect(restoreMessage({ restored: [], lost: [] })).toBeNull();
    expect(restoreMessage({ restored: ["a.md"], lost: [] })).toEqual({
      kind: "info",
      text: 'Restored unsaved changes to "a.md"',
    });
    const m = restoreMessage({ restored: ["a.md"], lost: ["1", "2", "3", "4"] });
    expect(m?.kind).toBe("error");
    expect(m?.text).toContain('"1", "2", "3" and 1 more');
    expect(m?.text).toContain('Restored unsaved changes to "a.md"');
  });
});
