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

import { RECOVERED_VERSION, type Tab, useDocumentStore } from "../store/documentStore";
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
    expect(r).toEqual({ restored: ["b.md"], recovered: [] });
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

  it("skips text that was saved after all, and keeps a gone file's text", async () => {
    disk["/d/a.md"] = "saved";
    writeBuffers([
      { path: "/d/a.md", fileName: "a.md", content: "saved", base: "old" },
      { path: "/d/gone.md", fileName: "gone.md", content: "kept", base: "" },
    ]);
    const r = await restoreBuffers(openPath);
    expect(r).toEqual({ restored: [], recovered: ["gone.md"] });
    const tabs = useDocumentStore.getState().tabs;
    expect(tabs.find((t) => t.path === "/d/a.md")?.isDirty).toBe(false);
    expect(tabs.find((t) => t.path === "/d/gone.md")?.content).toBe("kept");
    expect(useDocumentStore.getState().error).toBeNull();
  });

  it("opens the text of a file that cannot be opened in a tab of its own", async () => {
    // It was reported and dropped: the unsaved text was gone.
    disk["/d/a.md"] = "a disk";
    await openPath("/d/a.md");
    const active = useDocumentStore.getState().activeId;
    writeBuffers([
      { path: "/d/gone.md", fileName: "gone.md", content: "only copy", base: "old" },
    ]);
    const r = await restoreBuffers(openPath);
    expect(r).toEqual({ restored: [], recovered: ["gone.md"] });
    const s = useDocumentStore.getState();
    // The tab that was active stays active, and the error is cleared.
    expect(s.activeId).toBe(active);
    expect(s.error).toBeNull();
    const gone = s.tabs.find((t) => t.path === "/d/gone.md") as Tab;
    expect(gone.content).toBe("only copy");
    expect(gone.isDirty).toBe(true);
    // Flagged as gone: the banner offers Save As, and closing asks first.
    expect(gone.missing).toBe(true);
    expect(gone.diskVersion).toBe(RECOVERED_VERSION);
    // It is kept for the next launch too.
    expect(collectBuffers(s)).toContainEqual({
      path: "/d/gone.md",
      fileName: "gone.md",
      content: "only copy",
      base: "",
    });
    // Shown, it says so.
    useDocumentStore.getState().switchTab(gone.id);
    expect(useDocumentStore.getState().missing).toBe(true);
    expect(useDocumentStore.getState().content).toBe("only copy");
  });

  it("with no tab open, the recovered text's tab is the one shown", async () => {
    writeBuffers([
      { path: "/d/gone.md", fileName: "gone.md", content: "only copy", base: "" },
    ]);
    await restoreBuffers(openPath);
    const s = useDocumentStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.path).toBe("/d/gone.md");
    expect(s.content).toBe("only copy");
    expect(s.missing).toBe(true);
    expect(s.isDirty).toBe(true);
  });

  it("a save of a recovered tab over a file found there again is refused", async () => {
    writeBuffers([
      { path: "/d/back.md", fileName: "back.md", content: "mine", base: "" },
    ]);
    await restoreBuffers(openPath);
    // The file is back (a sync client restored it), with other text.
    disk["/d/back.md"] = "theirs";
    useDocumentStore.getState().handleDiskUpdate("theirs", "v1");
    const s = useDocumentStore.getState();
    expect(s.missing).toBe(false);
    expect(s.externalChange).toBe(true);
    expect(s.pendingDisk).toBe("theirs");
    // A save names the recovered version, which no read matches.
    invokeMock.mockClear();
    await useDocumentStore.getState().save();
    const write = invokeMock.mock.calls.find((c) => c[0] === "write_markdown_file");
    expect(write?.[1]).toMatchObject({
      path: "/d/back.md",
      expected: RECOVERED_VERSION,
    });
  });
});

describe("restoreMessage", () => {
  it("says what came back and what did not, once", () => {
    expect(restoreMessage({ restored: [], recovered: [] })).toBeNull();
    expect(restoreMessage({ restored: ["a.md"], recovered: [] })).toEqual({
      kind: "info",
      text: 'Restored unsaved changes to "a.md"',
    });
    const m = restoreMessage({ restored: ["a.md"], recovered: ["1", "2", "3", "4"] });
    expect(m?.kind).toBe("error");
    expect(m?.text).toContain("Save As");
    expect(m?.text).toContain('"1", "2", "3" and 1 more');
    expect(m?.text).toContain('Restored unsaved changes to "a.md"');
  });
});
