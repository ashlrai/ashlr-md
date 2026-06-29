import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri bridge so the store runs in plain Node/happy-dom.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Isolate the document store from the persisted recents store.
const recentAdd = vi.fn();
vi.mock("./recentStore", () => ({
  useRecentStore: { getState: () => ({ add: recentAdd }) },
}));

import { useDocumentStore } from "./documentStore";

function reset() {
  useDocumentStore.setState({
    path: null,
    fileName: "",
    content: "",
    diskContent: "",
    size: 0,
    isLoading: false,
    error: null,
    viewMode: "read",
    isDirty: false,
    externalChange: false,
    pendingDisk: null,
    reloadNonce: 0,
    tabs: [],
    activeId: null,
  });
}

function readReturns(content: string) {
  invokeMock.mockImplementation((cmd: string) =>
    cmd === "read_markdown_file"
      ? Promise.resolve({
          path: "/a.md",
          file_name: "a.md",
          content,
          size: content.length,
        })
      : Promise.resolve(),
  );
}

/** Resolve read_markdown_file by echoing the requested path back as the file. */
function readReturnsByPath() {
  invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
    if (cmd === "read_markdown_file") {
      const p = args?.path ?? "/a.md";
      const name = p.split("/").pop() ?? p;
      return Promise.resolve({
        path: p,
        file_name: name,
        content: `content of ${p}`,
        size: p.length,
      });
    }
    return Promise.resolve();
  });
}

describe("documentStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    reset();
  });

  it("opens a file clean and starts watching it", async () => {
    readReturns("# Hello");
    await useDocumentStore.getState().openPath("/a.md");
    const s = useDocumentStore.getState();
    expect(s.path).toBe("/a.md");
    expect(s.content).toBe("# Hello");
    expect(s.diskContent).toBe("# Hello");
    expect(s.isDirty).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("watch_file", { path: "/a.md" });
  });

  it("marks dirty on edit and clean again on save", async () => {
    readReturns("x");
    await useDocumentStore.getState().openPath("/a.md");

    useDocumentStore.getState().setContent("x changed");
    expect(useDocumentStore.getState().isDirty).toBe(true);

    await useDocumentStore.getState().save();
    expect(invokeMock).toHaveBeenCalledWith("write_markdown_file", {
      path: "/a.md",
      content: "x changed",
    });
    const s = useDocumentStore.getState();
    expect(s.isDirty).toBe(false);
    expect(s.diskContent).toBe("x changed");
  });

  it("editing back to the on-disk content clears dirty", async () => {
    readReturns("original");
    await useDocumentStore.getState().openPath("/a.md");
    useDocumentStore.getState().setContent("edited");
    expect(useDocumentStore.getState().isDirty).toBe(true);
    useDocumentStore.getState().setContent("original");
    expect(useDocumentStore.getState().isDirty).toBe(false);
  });

  it("auto-reloads on external change when there are no local edits", () => {
    useDocumentStore.setState({
      path: "/a.md",
      content: "old",
      diskContent: "old",
      isDirty: false,
    });
    const before = useDocumentStore.getState().reloadNonce;
    useDocumentStore.getState().handleDiskUpdate("new from disk");
    const s = useDocumentStore.getState();
    expect(s.content).toBe("new from disk");
    expect(s.diskContent).toBe("new from disk");
    expect(s.externalChange).toBe(false);
    expect(s.reloadNonce).toBe(before + 1);
  });

  it("flags a conflict on external change with local edits, then accept reloads", () => {
    useDocumentStore.setState({
      path: "/a.md",
      content: "mine",
      diskContent: "old",
      isDirty: true,
    });
    useDocumentStore.getState().handleDiskUpdate("theirs");
    let s = useDocumentStore.getState();
    expect(s.externalChange).toBe(true);
    expect(s.pendingDisk).toBe("theirs");
    expect(s.content).toBe("mine"); // edits preserved until the user decides

    useDocumentStore.getState().acceptExternalChange();
    s = useDocumentStore.getState();
    expect(s.content).toBe("theirs");
    expect(s.isDirty).toBe(false);
    expect(s.externalChange).toBe(false);
    expect(s.pendingDisk).toBeNull();
  });

  it("dismissing a conflict keeps the local edits", () => {
    useDocumentStore.setState({
      path: "/a.md",
      content: "mine",
      diskContent: "old",
      isDirty: true,
      externalChange: true,
      pendingDisk: "theirs",
    });
    useDocumentStore.getState().dismissExternalChange();
    const s = useDocumentStore.getState();
    expect(s.externalChange).toBe(false);
    expect(s.content).toBe("mine");
    expect(s.isDirty).toBe(true);
  });

  it("treats our own save echo (disk == content) as a no-op resync", () => {
    useDocumentStore.setState({
      path: "/a.md",
      content: "same",
      diskContent: "old",
      isDirty: true,
    });
    useDocumentStore.getState().handleDiskUpdate("same");
    const s = useDocumentStore.getState();
    expect(s.isDirty).toBe(false);
    expect(s.diskContent).toBe("same");
    expect(s.externalChange).toBe(false);
  });

  it("opening a file creates a single tab that mirrors the active doc", async () => {
    readReturnsByPath();
    await useDocumentStore.getState().openPath("/a.md");
    const s = useDocumentStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe(s.tabs[0].id);
    expect(s.tabs[0].path).toBe("/a.md");
    // Top-level mirror equals the active tab.
    expect(s.path).toBe(s.tabs[0].path);
    expect(s.content).toBe(s.tabs[0].content);
  });

  it("opening two distinct paths creates two tabs", async () => {
    readReturnsByPath();
    await useDocumentStore.getState().openPath("/a.md");
    await useDocumentStore.getState().openPath("/b.md");
    const s = useDocumentStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(["/a.md", "/b.md"]);
    expect(s.path).toBe("/b.md"); // newest is active
    expect(s.activeId).toBe(s.tabs[1].id);
  });

  it("opening an already-open path switches without reloading", async () => {
    readReturnsByPath();
    await useDocumentStore.getState().openPath("/a.md");
    await useDocumentStore.getState().openPath("/b.md");
    const reads = invokeMock.mock.calls.filter(
      (c) => c[0] === "read_markdown_file",
    ).length;

    await useDocumentStore.getState().openPath("/a.md");
    const s = useDocumentStore.getState();
    expect(s.tabs).toHaveLength(2); // no new tab
    expect(s.path).toBe("/a.md"); // switched to existing
    const readsAfter = invokeMock.mock.calls.filter(
      (c) => c[0] === "read_markdown_file",
    ).length;
    expect(readsAfter).toBe(reads); // no extra read_markdown_file call
  });

  it("switchTab preserves each tab's content, viewMode, and dirty flag", async () => {
    readReturnsByPath();
    await useDocumentStore.getState().openPath("/a.md");
    // Edit + change view mode on tab A.
    useDocumentStore.getState().setContent("A edited");
    useDocumentStore.getState().setViewMode("source");
    expect(useDocumentStore.getState().isDirty).toBe(true);
    const aId = useDocumentStore.getState().activeId as string;

    await useDocumentStore.getState().openPath("/b.md");
    // Tab B is clean, default view mode (inherited "source" at open time).
    useDocumentStore.getState().setViewMode("edit");
    const bId = useDocumentStore.getState().activeId as string;
    expect(bId).not.toBe(aId);

    // Back to A — its dirty edit and view mode are restored.
    useDocumentStore.getState().switchTab(aId);
    let s = useDocumentStore.getState();
    expect(s.path).toBe("/a.md");
    expect(s.content).toBe("A edited");
    expect(s.viewMode).toBe("source");
    expect(s.isDirty).toBe(true);

    // Back to B — its clean state and view mode are restored.
    useDocumentStore.getState().switchTab(bId);
    s = useDocumentStore.getState();
    expect(s.path).toBe("/b.md");
    expect(s.content).toBe("content of /b.md");
    expect(s.viewMode).toBe("edit");
    expect(s.isDirty).toBe(false);
  });

  it("switchTab re-issues watch_file for the newly active document", async () => {
    readReturnsByPath();
    await useDocumentStore.getState().openPath("/a.md");
    await useDocumentStore.getState().openPath("/b.md");
    const aId = useDocumentStore.getState().tabs[0].id;
    invokeMock.mockClear();
    useDocumentStore.getState().switchTab(aId);
    expect(invokeMock).toHaveBeenCalledWith("watch_file", { path: "/a.md" });
  });

  it("closeTab activates the nearest neighbor (right, else left)", async () => {
    readReturnsByPath();
    await useDocumentStore.getState().openPath("/a.md");
    await useDocumentStore.getState().openPath("/b.md");
    await useDocumentStore.getState().openPath("/c.md");
    const [, b] = useDocumentStore.getState().tabs;

    // Active is C (rightmost); switch to B and close it → activates C (right).
    useDocumentStore.getState().switchTab(b.id);
    useDocumentStore.getState().closeTab(b.id);
    let s = useDocumentStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(["/a.md", "/c.md"]);
    expect(s.path).toBe("/c.md");

    // Now close C (rightmost active) → activates A (left).
    useDocumentStore.getState().closeTab(s.activeId as string);
    s = useDocumentStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(["/a.md"]);
    expect(s.path).toBe("/a.md");
  });

  it("closing a non-active tab keeps the active document unchanged", async () => {
    readReturnsByPath();
    await useDocumentStore.getState().openPath("/a.md");
    await useDocumentStore.getState().openPath("/b.md");
    const aId = useDocumentStore.getState().tabs[0].id;
    // Active is B; close A (non-active).
    useDocumentStore.getState().closeTab(aId);
    const s = useDocumentStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(["/b.md"]);
    expect(s.path).toBe("/b.md");
  });

  it("closing the last tab returns to the empty state", async () => {
    readReturnsByPath();
    await useDocumentStore.getState().openPath("/a.md");
    useDocumentStore
      .getState()
      .closeTab(useDocumentStore.getState().activeId as string);
    const s = useDocumentStore.getState();
    expect(s.tabs).toHaveLength(0);
    expect(s.activeId).toBeNull();
    expect(s.path).toBeNull();
    expect(s.content).toBe("");
    expect(s.fileName).toBe("");
  });

  it("close() closes the active tab", async () => {
    readReturnsByPath();
    await useDocumentStore.getState().openPath("/a.md");
    await useDocumentStore.getState().openPath("/b.md");
    useDocumentStore.getState().close();
    const s = useDocumentStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(["/a.md"]);
    expect(s.path).toBe("/a.md");
  });

  it("next/prevTab cycle and wrap around", async () => {
    readReturnsByPath();
    await useDocumentStore.getState().openPath("/a.md");
    await useDocumentStore.getState().openPath("/b.md");
    await useDocumentStore.getState().openPath("/c.md");
    // Active is C (index 2). next → wraps to A.
    useDocumentStore.getState().nextTab();
    expect(useDocumentStore.getState().path).toBe("/a.md");
    // next → B.
    useDocumentStore.getState().nextTab();
    expect(useDocumentStore.getState().path).toBe("/b.md");
    // prev → A.
    useDocumentStore.getState().prevTab();
    expect(useDocumentStore.getState().path).toBe("/a.md");
    // prev → wraps to C.
    useDocumentStore.getState().prevTab();
    expect(useDocumentStore.getState().path).toBe("/c.md");
  });

  it("editing one tab does not leak content into another", async () => {
    readReturnsByPath();
    await useDocumentStore.getState().openPath("/a.md");
    await useDocumentStore.getState().openPath("/b.md");
    useDocumentStore.getState().setContent("only B");
    const aId = useDocumentStore.getState().tabs[0].id;
    useDocumentStore.getState().switchTab(aId);
    expect(useDocumentStore.getState().content).toBe("content of /a.md");
    expect(useDocumentStore.getState().tabs[1].content).toBe("only B");
  });
});

// ── OT: applyOp / clearPendingOps ────────────────────────────────────────────

import type { OtOperation } from "../lib/ot";

function makeOtInsert(docLength: number, offset: number, text: string): OtOperation {
  const components: OtOperation["components"] = [];
  if (offset > 0) components.push({ type: "retain", count: offset });
  components.push({ type: "insert", text });
  if (offset < docLength) components.push({ type: "retain", count: docLength - offset });
  return {
    id: "test-op-1",
    agentId: "agentX",
    seq: 1,
    clock: {},
    components,
  };
}

function makeOtDelete(docLength: number, offset: number, length: number): OtOperation {
  const components: OtOperation["components"] = [];
  if (offset > 0) components.push({ type: "retain", count: offset });
  components.push({ type: "delete", count: length });
  const trailing = docLength - offset - length;
  if (trailing > 0) components.push({ type: "retain", count: trailing });
  return {
    id: "test-op-2",
    agentId: "agentY",
    seq: 1,
    clock: {},
    components,
  };
}

describe("documentStore — applyOp", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    reset();
  });

  it("applyOp inserts text at the correct position", () => {
    useDocumentStore.setState({ content: "hello world", diskContent: "hello world" });
    const op = makeOtInsert(11, 5, "!");
    const ok = useDocumentStore.getState().applyOp(op);
    expect(ok).toBe(true);
    expect(useDocumentStore.getState().content).toBe("hello! world");
  });

  it("applyOp deletes the specified range", () => {
    useDocumentStore.setState({ content: "hello world", diskContent: "hello world" });
    const op = makeOtDelete(11, 5, 6);
    const ok = useDocumentStore.getState().applyOp(op);
    expect(ok).toBe(true);
    expect(useDocumentStore.getState().content).toBe("hello");
  });

  it("applyOp marks the document dirty when content changes from diskContent", () => {
    useDocumentStore.setState({ content: "abc", diskContent: "abc", isDirty: false });
    const op = makeOtInsert(3, 3, "X");
    useDocumentStore.getState().applyOp(op);
    expect(useDocumentStore.getState().isDirty).toBe(true);
  });

  it("applyOp returns false for an op inconsistent with doc length", () => {
    useDocumentStore.setState({ content: "hi", diskContent: "hi" });
    const badOp: OtOperation = {
      id: "bad",
      agentId: "a",
      seq: 1,
      clock: {},
      components: [{ type: "retain", count: 999 }],
    };
    const ok = useDocumentStore.getState().applyOp(badOp);
    expect(ok).toBe(false);
  });

  it("applyOp does not change content when it returns false", () => {
    useDocumentStore.setState({ content: "original", diskContent: "original" });
    const badOp: OtOperation = {
      id: "bad",
      agentId: "a",
      seq: 1,
      clock: {},
      components: [{ type: "retain", count: 500 }],
    };
    useDocumentStore.getState().applyOp(badOp);
    expect(useDocumentStore.getState().content).toBe("original");
  });

  it("applyOp accumulates ops in pendingOps", () => {
    useDocumentStore.setState({ content: "abc", diskContent: "abc", pendingOps: [] });
    const op1 = makeOtInsert(3, 0, "X");
    op1.id = "op-a";
    useDocumentStore.getState().applyOp(op1);
    // After first op, content is "Xabc"
    const op2 = makeOtInsert(4, 4, "Y");
    op2.id = "op-b";
    useDocumentStore.getState().applyOp(op2);
    const { pendingOps } = useDocumentStore.getState();
    expect(pendingOps).toHaveLength(2);
    expect(pendingOps.map((o) => o.id)).toEqual(["op-a", "op-b"]);
  });

  it("clearPendingOps empties the pendingOps array", () => {
    const op = makeOtInsert(3, 0, "X");
    useDocumentStore.setState({
      content: "abc",
      diskContent: "abc",
      pendingOps: [op],
    });
    useDocumentStore.getState().clearPendingOps();
    expect(useDocumentStore.getState().pendingOps).toHaveLength(0);
  });

  it("failed applyOp does not add anything to pendingOps", () => {
    useDocumentStore.setState({ content: "abc", diskContent: "abc", pendingOps: [] });
    const badOp: OtOperation = {
      id: "bad",
      agentId: "a",
      seq: 1,
      clock: {},
      components: [{ type: "retain", count: 999 }],
    };
    useDocumentStore.getState().applyOp(badOp);
    expect(useDocumentStore.getState().pendingOps).toHaveLength(0);
  });
});
