import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri bridge so the store runs in plain Node/happy-dom.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Native dialogs: the recreate confirmation and the Save As picker.
const askMock = vi.fn();
const pickMock = vi.fn();
const messageMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...args: unknown[]) => askMock(...args),
  save: (...args: unknown[]) => pickMock(...args),
  message: (...args: unknown[]) => messageMock(...args),
}));

// Isolate the document store from the persisted recents store.
const recentAdd = vi.fn();
const recentRemove = vi.fn();
vi.mock("./recentStore", async (importOriginal) => ({
  isMissingFileError: (await importOriginal<typeof import("./recentStore")>())
    .isMissingFileError,
  useRecentStore: { getState: () => ({ add: recentAdd, remove: recentRemove }) },
}));

import {
  CLOSE_MISSING_DISCARD,
  CLOSE_MISSING_SAVE_AS,
  useDocumentStore,
} from "./documentStore";
import { useToastStore } from "./toastStore";

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
    diskVersion: null,
    pendingVersion: null,
    missing: false,
    reloadNonce: 0,
    tabs: [],
    activeId: null,
    pendingOps: [],
    remoteCursors: {},
    showRemoteCursors: true,
    opLog: [],
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

    const nonce = useDocumentStore.getState().tabs[0].reloadNonce;
    await useDocumentStore.getState().openPath("/a.md");
    const s = useDocumentStore.getState();
    expect(s.tabs).toHaveLength(2); // no new tab
    expect(s.path).toBe("/a.md"); // switched to existing
    const readsAfter = invokeMock.mock.calls.filter(
      (c) => c[0] === "read_markdown_file",
    ).length;
    // One read checks the file for changes made while it was in the
    // background; the file is unchanged, so nothing reloads.
    expect(readsAfter).toBe(reads + 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(useDocumentStore.getState().reloadNonce).toBe(nonce);
    expect(useDocumentStore.getState().content).toBe("content of /a.md");
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

  it("says so when a file cannot be watched", async () => {
    // The failure was dropped: changes on disk went unnoticed, unsaid.
    useToastStore.getState().clear();
    readReturnsByPath();
    const read = invokeMock.getMockImplementation();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "watch_file"
        ? Promise.reject(
            "Changes made to /w/a.md outside Ashlr MD will not be noticed: x",
          )
        : read?.(cmd, args),
    );
    await useDocumentStore.getState().openPath("/w/a.md");
    await new Promise((r) => setTimeout(r, 0));
    const toasts = useToastStore.getState().toasts;
    expect(toasts.map((t) => [t.kind, t.message])).toEqual([
      ["error", "Changes made to /w/a.md outside Ashlr MD will not be noticed: x"],
    ]);
  });

  it("follows the open file when it is renamed on disk", async () => {
    // A rename read as the file being gone: the tab was flagged missing.
    readReturnsByPath();
    await useDocumentStore.getState().openPath("/d/a.md");
    useDocumentStore.getState().setContent("edited");
    invokeMock.mockClear();
    await useDocumentStore.getState().followRename("/d/a.md", "/d/b.md");
    const s = useDocumentStore.getState();
    expect(s.path).toBe("/d/b.md");
    expect(s.fileName).toBe("b.md");
    expect(s.missing).toBe(false);
    expect(s.tabs[0]).toMatchObject({
      path: "/d/b.md",
      fileName: "b.md",
      key: "/d/b.md",
    });
    expect(invokeMock).toHaveBeenCalledWith("watch_file", { path: "/d/b.md" });
    // Its unsaved text is kept.
    expect(s.content).toBe("edited");
    expect(s.isDirty).toBe(true);
    // A rename of another file changes nothing.
    await useDocumentStore.getState().followRename("/d/x.md", "/d/y.md");
    expect(useDocumentStore.getState().path).toBe("/d/b.md");
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
  if (offset < docLength)
    components.push({ type: "retain", count: docLength - offset });
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

// ── applyAttributedOp — attribution + merge rules ────────────────────────────

describe("documentStore — applyAttributedOp", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    reset();
  });

  it("applyAttributedOp applies the op and updates content", () => {
    useDocumentStore.setState({
      content: "hello world",
      diskContent: "hello world",
      pendingOps: [],
      remoteCursors: {},
      opLog: [],
    });
    const op = makeOtInsert(11, 5, "!");
    op.agentId = "agentZ";
    const ok = useDocumentStore.getState().applyAttributedOp(op, "agent");
    expect(ok).toBe(true);
    expect(useDocumentStore.getState().content).toBe("hello! world");
  });

  it("applyAttributedOp updates remoteCursors for the op's agent", () => {
    useDocumentStore.setState({
      content: "hello",
      diskContent: "hello",
      pendingOps: [],
      remoteCursors: {},
      opLog: [],
    });
    const op = makeOtInsert(5, 3, "XY");
    op.agentId = "bot1";
    useDocumentStore.getState().applyAttributedOp(op, "agent");
    const cursors = useDocumentStore.getState().remoteCursors;
    expect(cursors["bot1"]).toBeDefined();
    expect(cursors["bot1"].agentId).toBe("bot1");
    expect(typeof cursors["bot1"].offset).toBe("number");
    expect(typeof cursors["bot1"].line).toBe("number");
    expect(typeof cursors["bot1"].col).toBe("number");
  });

  it("applyAttributedOp appends to opLog with correct source", () => {
    useDocumentStore.setState({
      content: "abc",
      diskContent: "abc",
      pendingOps: [],
      remoteCursors: {},
      opLog: [],
      path: "/test.md",
    });
    const op = makeOtInsert(3, 0, "Z");
    op.agentId = "agentA";
    useDocumentStore.getState().applyAttributedOp(op, "agent");
    const log = useDocumentStore.getState().opLog;
    expect(log).toHaveLength(1);
    expect(log[0].source).toBe("agent");
    expect(log[0].docPath).toBe("/test.md");
    expect(log[0].op.id).toBe(op.id);
  });

  it("applyAttributedOp returns false for an invalid op (does not throw)", () => {
    useDocumentStore.setState({
      content: "hi",
      diskContent: "hi",
      pendingOps: [],
      remoteCursors: {},
      opLog: [],
    });
    const badOp: OtOperation = {
      id: "bad",
      agentId: "a",
      seq: 1,
      clock: {},
      components: [{ type: "retain", count: 999 }],
    };
    const ok = useDocumentStore.getState().applyAttributedOp(badOp, "agent");
    expect(ok).toBe(false);
    expect(useDocumentStore.getState().content).toBe("hi");
    expect(useDocumentStore.getState().opLog).toHaveLength(0);
  });

  it("human-attributed op in prose is accepted and logged", () => {
    useDocumentStore.setState({
      content: "Hello world",
      diskContent: "Hello world",
      pendingOps: [],
      remoteCursors: {},
      opLog: [],
      path: "/prose.md",
    });
    const op = makeOtInsert(11, 6, "beautiful ");
    op.agentId = "user1";
    useDocumentStore.getState().applyAttributedOp(op, "human");
    const log = useDocumentStore.getState().opLog;
    expect(log[0].source).toBe("human");
    expect(useDocumentStore.getState().content).toBe("Hello beautiful world");
  });

  it("multiple attributed ops accumulate in opLog", () => {
    useDocumentStore.setState({
      content: "abc",
      diskContent: "abc",
      pendingOps: [],
      remoteCursors: {},
      opLog: [],
      path: "/x.md",
    });
    const op1 = makeOtInsert(3, 0, "X");
    op1.id = "op-1";
    useDocumentStore.getState().applyAttributedOp(op1, "agent");
    // content is now "Xabc"
    const op2 = makeOtInsert(4, 4, "Y");
    op2.id = "op-2";
    useDocumentStore.getState().applyAttributedOp(op2, "human");
    expect(useDocumentStore.getState().opLog).toHaveLength(2);
    expect(useDocumentStore.getState().opLog.map((e) => e.source)).toEqual([
      "agent",
      "human",
    ]);
  });
});

// ── setRemoteCursor ───────────────────────────────────────────────────────────

describe("documentStore — setRemoteCursor", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    reset();
  });

  it("setRemoteCursor stores cursor with correct line/col derived from offset", () => {
    useDocumentStore.setState({ content: "line0\nline1\nline2", remoteCursors: {} });
    // Offset 6 is start of "line1" → line 1, col 0
    useDocumentStore.getState().setRemoteCursor("agentBot", 6);
    const cursor = useDocumentStore.getState().remoteCursors["agentBot"];
    expect(cursor).toBeDefined();
    expect(cursor.line).toBe(1);
    expect(cursor.col).toBe(0);
    expect(cursor.offset).toBe(6);
  });

  it("setRemoteCursor updates an existing cursor entry", () => {
    useDocumentStore.setState({
      content: "abcde",
      remoteCursors: {
        bot: { agentId: "bot", offset: 0, line: 0, col: 0, updatedAt: 0 },
      },
    });
    useDocumentStore.getState().setRemoteCursor("bot", 3);
    const cursor = useDocumentStore.getState().remoteCursors["bot"];
    expect(cursor.offset).toBe(3);
    expect(cursor.col).toBe(3);
  });

  it("multiple agents can have independent cursors", () => {
    useDocumentStore.setState({ content: "hello world", remoteCursors: {} });
    useDocumentStore.getState().setRemoteCursor("agent1", 2);
    useDocumentStore.getState().setRemoteCursor("agent2", 8);
    const cursors = useDocumentStore.getState().remoteCursors;
    expect(cursors["agent1"].offset).toBe(2);
    expect(cursors["agent2"].offset).toBe(8);
  });
});

// ── showRemoteCursors / toggleShowRemoteCursors ───────────────────────────────

describe("documentStore — showRemoteCursors toggle", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    reset();
  });

  it("showRemoteCursors defaults to true", () => {
    expect(useDocumentStore.getState().showRemoteCursors).toBe(true);
  });

  it("toggleShowRemoteCursors flips the flag", () => {
    useDocumentStore.getState().toggleShowRemoteCursors();
    expect(useDocumentStore.getState().showRemoteCursors).toBe(false);
    useDocumentStore.getState().toggleShowRemoteCursors();
    expect(useDocumentStore.getState().showRemoteCursors).toBe(true);
  });
});

// ── getOpLog / clearOpLog ─────────────────────────────────────────────────────

describe("documentStore — getOpLog / clearOpLog", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    reset();
  });

  it("getOpLog returns only entries for the given path", () => {
    useDocumentStore.setState({
      content: "x",
      diskContent: "x",
      pendingOps: [],
      remoteCursors: {},
      opLog: [
        {
          docPath: "/a.md",
          op: makeOtInsert(1, 0, "Z") as OtOperation,
          appliedAt: 1,
          source: "agent",
        },
        {
          docPath: "/b.md",
          op: makeOtInsert(1, 0, "W") as OtOperation,
          appliedAt: 2,
          source: "human",
        },
      ],
    });
    const log = useDocumentStore.getState().getOpLog("/a.md");
    expect(log).toHaveLength(1);
    expect(log[0].docPath).toBe("/a.md");
  });

  it("clearOpLog removes only entries for the given path", () => {
    useDocumentStore.setState({
      content: "x",
      diskContent: "x",
      pendingOps: [],
      remoteCursors: {},
      opLog: [
        {
          docPath: "/a.md",
          op: makeOtInsert(1, 0, "Z") as OtOperation,
          appliedAt: 1,
          source: "agent",
        },
        {
          docPath: "/b.md",
          op: makeOtInsert(1, 0, "W") as OtOperation,
          appliedAt: 2,
          source: "human",
        },
      ],
    });
    useDocumentStore.getState().clearOpLog("/a.md");
    const log = useDocumentStore.getState().opLog;
    expect(log).toHaveLength(1);
    expect(log[0].docPath).toBe("/b.md");
  });

  it("getOpLog returns empty array when no entries match", () => {
    useDocumentStore.setState({
      content: "x",
      diskContent: "x",
      pendingOps: [],
      remoteCursors: {},
      opLog: [],
    });
    expect(useDocumentStore.getState().getOpLog("/missing.md")).toEqual([]);
  });
});

describe("openPath of a file that is gone", () => {
  beforeEach(() => {
    reset();
    recentRemove.mockReset();
    invokeMock.mockReset();
  });

  it("drops it from the recents, so list_recent stops offering it", async () => {
    invokeMock.mockRejectedValueOnce(
      "Could not read /gone.md: No such file or directory (os error 2)",
    );
    await useDocumentStore.getState().openPath("/gone.md");
    expect(useDocumentStore.getState().error).toContain("os error 2");
    expect(recentRemove).toHaveBeenCalledWith("/gone.md");
  });

  it("resolves to the reason, so a caller need not infer it from `path`", async () => {
    invokeMock.mockRejectedValueOnce(
      "Could not read /gone.md: No such file or directory",
    );
    await expect(useDocumentStore.getState().openPath("/gone.md")).resolves.toBe(
      "Could not read /gone.md: No such file or directory",
    );
  });

  it("keeps it when the read failed for another reason", async () => {
    invokeMock.mockRejectedValueOnce(
      "Could not read /locked.md: Permission denied (os error 13)",
    );
    await useDocumentStore.getState().openPath("/locked.md");
    expect(recentRemove).not.toHaveBeenCalled();
  });
});

describe("documentStore — saves and disk changes stay with their tab", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    reset();
  });

  /** read_markdown_file answers from `files`; write_markdown_file waits for `gate`. */
  function disk(files: Record<string, string>, gate?: Promise<void>) {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      const p = args?.path ?? "";
      if (cmd === "read_markdown_file") {
        if (!(p in files)) return Promise.reject("No such file");
        return Promise.resolve({
          path: p,
          file_name: p.split("/").pop(),
          content: files[p],
          size: files[p].length,
        });
      }
      if (cmd === "write_markdown_file") return gate ?? Promise.resolve();
      return Promise.resolve();
    });
  }

  it("keeps an edit typed while the save was writing unsaved", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    disk({ "/a.md": "v0" }, gate);
    await useDocumentStore.getState().openPath("/a.md");
    useDocumentStore.getState().setContent("v1");
    const saving = useDocumentStore.getState().save();
    useDocumentStore.getState().setContent("v2");
    release();
    await saving;
    const s = useDocumentStore.getState();
    expect(s.diskContent).toBe("v1");
    expect(s.content).toBe("v2");
    expect(s.isDirty).toBe(true);
    expect(s.tabs[0].isDirty).toBe(true);
  });

  it("marks the saved tab clean, not the tab switched to during the write", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    disk({ "/a.md": "a0", "/b.md": "b0" }, gate);
    await useDocumentStore.getState().openPath("/a.md");
    await useDocumentStore.getState().openPath("/b.md");
    const [aId, bId] = useDocumentStore.getState().tabs.map((t) => t.id);
    useDocumentStore.getState().setContent("b edited");
    useDocumentStore.getState().switchTab(aId);
    useDocumentStore.getState().setContent("a edited");
    const saving = useDocumentStore.getState().save();
    useDocumentStore.getState().switchTab(bId);
    release();
    await saving;
    const s = useDocumentStore.getState();
    // B is still active, and still has its unsaved edit.
    expect(s.path).toBe("/b.md");
    expect(s.content).toBe("b edited");
    expect(s.diskContent).toBe("b0");
    expect(s.isDirty).toBe(true);
    const a = s.tabs.find((t) => t.id === aId);
    expect(a?.diskContent).toBe("a edited");
    expect(a?.isDirty).toBe(false);
  });

  it("does not flag a conflict when the file on disk did not change", () => {
    useDocumentStore.setState({
      path: "/a.md",
      content: "mine",
      diskContent: "old",
      isDirty: true,
    });
    // A metadata-only event (touch, chmod) re-reads the same text.
    useDocumentStore.getState().handleDiskUpdate("old");
    let s = useDocumentStore.getState();
    expect(s.externalChange).toBe(false);
    expect(s.pendingDisk).toBeNull();
    expect(s.content).toBe("mine");
    expect(s.isDirty).toBe(true);
    // A change offered and then undone on disk takes its banner away.
    useDocumentStore.getState().handleDiskUpdate("theirs");
    expect(useDocumentStore.getState().externalChange).toBe(true);
    useDocumentStore.getState().handleDiskUpdate("old");
    s = useDocumentStore.getState();
    expect(s.externalChange).toBe(false);
    expect(s.pendingDisk).toBeNull();
    expect(s.content).toBe("mine");
  });

  it("reads a background tab's file again when switching to it", async () => {
    const files: Record<string, string> = { "/a.md": "a0", "/b.md": "b0" };
    disk(files);
    await useDocumentStore.getState().openPath("/a.md");
    await useDocumentStore.getState().openPath("/b.md");
    const aId = useDocumentStore.getState().tabs[0].id;
    // Another app changes A while B is active (only B is watched).
    files["/a.md"] = "a changed elsewhere";
    useDocumentStore.getState().switchTab(aId);
    await vi.waitFor(() =>
      expect(useDocumentStore.getState().content).toBe("a changed elsewhere"),
    );
    expect(useDocumentStore.getState().isDirty).toBe(false);

    // With edits in the tab, the change is offered instead.
    const bId = useDocumentStore.getState().tabs[1].id;
    useDocumentStore.getState().switchTab(bId);
    await vi.waitFor(() => expect(useDocumentStore.getState().path).toBe("/b.md"));
    useDocumentStore.getState().setContent("b mine");
    useDocumentStore.getState().switchTab(aId);
    files["/b.md"] = "b theirs";
    useDocumentStore.getState().switchTab(bId);
    await vi.waitFor(() =>
      expect(useDocumentStore.getState().externalChange).toBe(true),
    );
    const s = useDocumentStore.getState();
    expect(s.content).toBe("b mine");
    expect(s.pendingDisk).toBe("b theirs");
  });
});

/**
 * A fake disk with `write_markdown_file`'s check: a file's version is its
 * text, and a write whose `expected` is not the file's version (or whose file
 * is gone) is refused with the backend's tag.
 */
function versionedDisk(files: Record<string, string>) {
  const writes: { path: string; content: string; expected?: string }[] = [];
  invokeMock.mockImplementation(
    (cmd: string, args?: { path?: string; content?: string; expected?: string }) => {
      const p = args?.path ?? "";
      if (cmd === "read_markdown_file") {
        if (!(p in files))
          return Promise.reject("No such file or directory (os error 2)");
        return Promise.resolve({
          path: p,
          file_name: p.split("/").pop(),
          content: files[p],
          size: files[p].length,
          version: `v:${files[p]}`,
        });
      }
      if (cmd === "write_markdown_file") {
        writes.push({
          path: p,
          content: args?.content ?? "",
          expected: args?.expected,
        });
        if (args?.expected !== undefined) {
          if (!(p in files)) {
            return Promise.reject(`Could not save ${p}: it was deleted [save-missing]`);
          }
          if (`v:${files[p]}` !== args.expected) {
            return Promise.reject(`Could not save ${p}: it changed [save-conflict]`);
          }
        }
        files[p] = args?.content ?? "";
        return Promise.resolve(`v:${files[p]}`);
      }
      return Promise.resolve();
    },
  );
  return writes;
}

describe("documentStore — a save never overwrites a change it has not seen", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    reset();
  });

  it("sends the read's version, and offers the disk text when the save is refused", async () => {
    const files: Record<string, string> = { "/a.md": "v0" };
    const writes = versionedDisk(files);
    await useDocumentStore.getState().openPath("/a.md");
    useDocumentStore.getState().setContent("mine");
    // Another app writes while the tab is open (no watcher event seen yet).
    files["/a.md"] = "theirs";
    await useDocumentStore.getState().save();
    expect(writes[0].expected).toBe("v:v0");
    expect(files["/a.md"]).toBe("theirs");
    await vi.waitFor(() =>
      expect(useDocumentStore.getState().externalChange).toBe(true),
    );
    let s = useDocumentStore.getState();
    expect(s.pendingDisk).toBe("theirs");
    expect(s.content).toBe("mine");
    expect(s.isDirty).toBe(true);

    // "Keep mine": the change was seen, so the next save replaces it.
    useDocumentStore.getState().dismissExternalChange();
    await useDocumentStore.getState().save();
    expect(writes[1].expected).toBe("v:theirs");
    expect(files["/a.md"]).toBe("mine");
    s = useDocumentStore.getState();
    expect(s.isDirty).toBe(false);
    expect(s.diskVersion).toBe("v:mine");

    // The saved version is the baseline for the save after it.
    useDocumentStore.getState().setContent("mine 2");
    await useDocumentStore.getState().save();
    expect(writes[2].expected).toBe("v:mine");
    expect(files["/a.md"]).toBe("mine 2");
  });
});

describe("documentStore — a file deleted or moved while open", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    askMock.mockReset();
    pickMock.mockReset();
    messageMock.mockReset();
    reset();
  });

  it("is shown as missing, and a save writes it again only when the user confirms", async () => {
    const files: Record<string, string> = { "/a.md": "v0" };
    const writes = versionedDisk(files);
    await useDocumentStore.getState().openPath("/a.md");
    useDocumentStore.getState().setContent("mine");
    // Deleted in Finder: the watcher reports it and the re-read fails.
    delete files["/a.md"];
    await useDocumentStore.getState().refreshFromDisk("/a.md");
    let s = useDocumentStore.getState();
    expect(s.missing).toBe(true);
    expect(s.tabs[0].missing).toBe(true);
    expect(s.content).toBe("mine");

    // Declined: nothing written, the text kept.
    askMock.mockResolvedValueOnce(false);
    expect(await useDocumentStore.getState().save()).toBe("cancelled");
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(0);
    expect("/a.md" in files).toBe(false);

    // An agent's save never asks, and is refused.
    expect(await useDocumentStore.getState().save({ agent: true })).toMatch(
      /deleted or moved/,
    );
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(0);

    // Confirmed: written again, and no longer missing.
    askMock.mockResolvedValueOnce(true);
    expect(await useDocumentStore.getState().save()).toBeNull();
    expect(files["/a.md"]).toBe("mine");
    s = useDocumentStore.getState();
    expect(s.missing).toBe(false);
    expect(s.isDirty).toBe(false);
  });

  it("asks even when the save is what finds the file gone", async () => {
    const files: Record<string, string> = { "/a.md": "v0" };
    const writes = versionedDisk(files);
    await useDocumentStore.getState().openPath("/a.md");
    useDocumentStore.getState().setContent("mine");
    delete files["/a.md"];
    askMock.mockResolvedValueOnce(false);
    expect(await useDocumentStore.getState().save()).toBe("cancelled");
    expect(useDocumentStore.getState().missing).toBe(true);
    // The checked write was refused; nothing was written without asking.
    expect(writes).toHaveLength(1);
    expect("/a.md" in files).toBe(false);
  });

  it("Save As writes the text under a new name, which the tab follows", async () => {
    const files: Record<string, string> = { "/a.md": "v0" };
    versionedDisk(files);
    await useDocumentStore.getState().openPath("/a.md");
    useDocumentStore.getState().setContent("mine");
    delete files["/a.md"];
    await useDocumentStore.getState().refreshFromDisk("/a.md");
    pickMock.mockResolvedValueOnce("/moved/b.md");
    expect(await useDocumentStore.getState().saveAs()).toBeNull();
    expect(files["/moved/b.md"]).toBe("mine");
    const s = useDocumentStore.getState();
    expect(s.path).toBe("/moved/b.md");
    expect(s.fileName).toBe("b.md");
    expect(s.tabs[0].path).toBe("/moved/b.md");
    expect(s.missing).toBe(false);
    expect(s.isDirty).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("watch_file", { path: "/moved/b.md" });
  });

  it("closing it with no edits asks first, and offers Save As", async () => {
    const files: Record<string, string> = { "/a.md": "v0" };
    versionedDisk(files);
    await useDocumentStore.getState().openPath("/a.md");
    delete files["/a.md"];
    await useDocumentStore.getState().refreshFromDisk("/a.md");
    const id = useDocumentStore.getState().activeId as string;
    expect(useDocumentStore.getState().isDirty).toBe(false);
    const settle = () => new Promise((r) => setTimeout(r, 0));

    // Cancel: the tab and its text stay. It used to close at once.
    messageMock.mockResolvedValueOnce("Cancel");
    useDocumentStore.getState().closeTab(id);
    await settle();
    expect(messageMock).toHaveBeenCalledTimes(1);
    expect(String(messageMock.mock.calls[0][0])).toMatch(/only in this tab/);
    expect(useDocumentStore.getState().tabs).toHaveLength(1);

    // Save As: written under the new name, then the tab closes.
    messageMock.mockResolvedValueOnce(CLOSE_MISSING_SAVE_AS);
    pickMock.mockResolvedValueOnce("/kept/a.md");
    useDocumentStore.getState().closeTab(id);
    await settle();
    await settle();
    expect(files["/kept/a.md"]).toBe("v0");
    expect(useDocumentStore.getState().tabs).toHaveLength(0);
  });

  it("closing it can discard the text, and a cancelled Save As keeps the tab", async () => {
    const files: Record<string, string> = { "/a.md": "v0" };
    versionedDisk(files);
    await useDocumentStore.getState().openPath("/a.md");
    delete files["/a.md"];
    await useDocumentStore.getState().refreshFromDisk("/a.md");
    const id = useDocumentStore.getState().activeId as string;
    const settle = () => new Promise((r) => setTimeout(r, 0));

    messageMock.mockResolvedValueOnce(CLOSE_MISSING_SAVE_AS);
    pickMock.mockResolvedValueOnce(null);
    useDocumentStore.getState().closeTab(id);
    await settle();
    await settle();
    expect(useDocumentStore.getState().tabs).toHaveLength(1);

    messageMock.mockResolvedValueOnce(CLOSE_MISSING_DISCARD);
    useDocumentStore.getState().closeTab(id);
    await settle();
    expect(useDocumentStore.getState().tabs).toHaveLength(0);
    // The unsaved-changes question is not asked on top.
    expect(askMock).not.toHaveBeenCalled();
  });

  it("a file that comes back is no longer missing", async () => {
    const files: Record<string, string> = { "/a.md": "v0" };
    versionedDisk(files);
    await useDocumentStore.getState().openPath("/a.md");
    delete files["/a.md"];
    await useDocumentStore.getState().refreshFromDisk("/a.md");
    expect(useDocumentStore.getState().missing).toBe(true);
    files["/a.md"] = "back";
    await useDocumentStore.getState().refreshFromDisk("/a.md");
    const s = useDocumentStore.getState();
    expect(s.missing).toBe(false);
    expect(s.content).toBe("back");
  });
});

describe("documentStore — changes on disk in quick succession", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    reset();
  });

  it("shows the last read's text when an earlier read answers after it", async () => {
    readReturns("v0");
    await useDocumentStore.getState().openPath("/a.md");
    // Two changes on disk; the first read is slow, and answers last.
    const answers: ((content: string) => void)[] = [];
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "read_markdown_file"
        ? new Promise((resolve) =>
            answers.push((content) =>
              resolve({
                path: "/a.md",
                file_name: "a.md",
                content,
                size: content.length,
                version: `v:${content}`,
              }),
            ),
          )
        : Promise.resolve(),
    );
    const first = useDocumentStore.getState().refreshFromDisk("/a.md");
    const second = useDocumentStore.getState().refreshFromDisk("/a.md");
    answers[1]("v2");
    await second;
    answers[0]("v1");
    await first;
    const s = useDocumentStore.getState();
    // It used to end on v1, the older text, as its baseline too.
    expect(s.content).toBe("v2");
    expect(s.diskContent).toBe("v2");
    expect(s.diskVersion).toBe("v:v2");
  });

  it("a slow read that finds the file gone does not undo a later one", async () => {
    readReturns("v0");
    await useDocumentStore.getState().openPath("/a.md");
    const answers: ((content: string | null) => void)[] = [];
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "read_markdown_file"
        ? new Promise((resolve, reject) =>
            answers.push((content) =>
              content === null
                ? reject("No such file or directory (os error 2)")
                : resolve({ path: "/a.md", file_name: "a.md", content, size: 1 }),
            ),
          )
        : Promise.resolve(),
    );
    const first = useDocumentStore.getState().refreshFromDisk("/a.md");
    const second = useDocumentStore.getState().refreshFromDisk("/a.md");
    answers[1]("back");
    await second;
    answers[0](null);
    await first;
    expect(useDocumentStore.getState().missing).toBe(false);
    expect(useDocumentStore.getState().content).toBe("back");
  });
});

describe("documentStore — one file opened by two paths is one tab", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    reset();
  });

  /** read_markdown_file names `canonical` for every path, with `rules`. */
  function sameFile(
    canonical: (p: string) => string,
    rules: { case_insensitive?: boolean; normalization_insensitive?: boolean } = {},
  ) {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      const p = args?.path ?? "";
      if (cmd === "read_markdown_file") {
        return Promise.resolve({
          path: p,
          file_name: p.split("/").pop(),
          content: "text",
          size: 4,
          version: "v",
          canonical_path: canonical(p),
          ...rules,
        });
      }
      return Promise.resolve();
    });
  }

  it("Save As keys the tab by the new file's canonical path", async () => {
    sameFile((p) => p.replace("/vault/link/", "/real/"));
    const base = invokeMock.getMockImplementation();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "write_markdown_file" ? Promise.resolve("v2") : base?.(cmd, args),
    );
    await useDocumentStore.getState().openPath("/vault/a.md");
    pickMock.mockResolvedValueOnce("/vault/link/b.md");
    expect(await useDocumentStore.getState().saveAs()).toBeNull();
    let s = useDocumentStore.getState();
    expect(s.tabs[0].key).toBe("/real/b.md");
    // The same file by its real path is the same tab, not a second one.
    await useDocumentStore.getState().openPath("/real/b.md");
    s = useDocumentStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.path).toBe("/vault/link/b.md");
  });

  /** A disk of `files`, each its own canonical path, saves written into it. */
  function disk(files: Record<string, string>) {
    invokeMock.mockImplementation(
      (cmd: string, args?: { path?: string; content?: string }) => {
        const p = args?.path ?? "";
        if (cmd === "read_markdown_file") {
          if (!(p in files))
            return Promise.reject("No such file or directory (os error 2)");
          return Promise.resolve({
            path: p,
            file_name: p.split("/").pop(),
            content: files[p],
            size: files[p].length,
            version: `v-${files[p]}`,
            canonical_path: p,
          });
        }
        if (cmd === "write_markdown_file") {
          files[p] = args?.content ?? "";
          return Promise.resolve(`v-${files[p]}`);
        }
        return Promise.resolve();
      },
    );
  }

  it("Save As onto a file open in another tab leaves one tab for it", async () => {
    // It used to leave both tabs, with the same key: the other one showed
    // the text this save replaced, and its next save wrote it back.
    const files: Record<string, string> = { "/v/a.md": "A", "/v/b.md": "B" };
    disk(files);
    await useDocumentStore.getState().openPath("/v/b.md");
    await useDocumentStore.getState().openPath("/v/a.md");
    useDocumentStore.getState().setContent("A2");
    pickMock.mockResolvedValueOnce("/v/b.md");
    expect(await useDocumentStore.getState().saveAs()).toBeNull();
    const s = useDocumentStore.getState();
    expect(files["/v/b.md"]).toBe("A2");
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].key).toBe("/v/b.md");
    expect(s.path).toBe("/v/b.md");
    expect(s.content).toBe("A2");
    expect(askMock).not.toHaveBeenCalled();
  });

  it("asks before replacing a file whose tab has unsaved changes", async () => {
    const files: Record<string, string> = { "/v/a.md": "A", "/v/b.md": "B" };
    disk(files);
    askMock.mockReset();
    await useDocumentStore.getState().openPath("/v/b.md");
    useDocumentStore.getState().setContent("B edited");
    await useDocumentStore.getState().openPath("/v/a.md");

    // No: nothing is written and both tabs stay, the other one's edits too.
    askMock.mockResolvedValueOnce(false);
    pickMock.mockResolvedValueOnce("/v/b.md");
    expect(await useDocumentStore.getState().saveAs()).toBe("cancelled");
    expect(String(askMock.mock.calls[0][0])).toMatch(/b\.md.*unsaved changes/);
    expect(files["/v/b.md"]).toBe("B");
    let s = useDocumentStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs.find((t) => t.path === "/v/b.md")?.content).toBe("B edited");

    // Yes: written, and the other tab is closed.
    askMock.mockResolvedValueOnce(true);
    pickMock.mockResolvedValueOnce("/v/b.md");
    expect(await useDocumentStore.getState().saveAs()).toBeNull();
    s = useDocumentStore.getState();
    expect(files["/v/b.md"]).toBe("A");
    expect(s.tabs).toHaveLength(1);
    expect(s.path).toBe("/v/b.md");
  });

  it("switches to the tab of a file opened through a symbolic link", async () => {
    sameFile(() => "/real/notes.md");
    await useDocumentStore.getState().openPath("/vault/notes.md");
    await useDocumentStore.getState().openPath("/vault/link-to-notes.md");
    const s = useDocumentStore.getState();
    expect(s.tabs).toHaveLength(1);
    // The tab keeps the path it was opened by (links resolve from there).
    expect(s.path).toBe("/vault/notes.md");
    expect(s.isLoading).toBe(false);
  });

  it("folds case only where the filesystem ignores it", async () => {
    sameFile((p) => p, { case_insensitive: true });
    await useDocumentStore.getState().openPath("/v/Notes.md");
    await useDocumentStore.getState().openPath("/v/notes.md");
    expect(useDocumentStore.getState().tabs).toHaveLength(1);

    reset();
    sameFile((p) => p, { case_insensitive: false });
    await useDocumentStore.getState().openPath("/v/Notes.md");
    await useDocumentStore.getState().openPath("/v/notes.md");
    expect(useDocumentStore.getState().tabs).toHaveLength(2);
  });

  it("treats composed and decomposed names as one where the filesystem does", async () => {
    const nfc = "/v/café.md";
    const nfd = "/v/café.md";
    sameFile((p) => p, { normalization_insensitive: true });
    await useDocumentStore.getState().openPath(nfc);
    await useDocumentStore.getState().openPath(nfd);
    expect(useDocumentStore.getState().tabs).toHaveLength(1);

    reset();
    sameFile((p) => p);
    await useDocumentStore.getState().openPath(nfc);
    await useDocumentStore.getState().openPath(nfd);
    expect(useDocumentStore.getState().tabs).toHaveLength(2);
  });
});
