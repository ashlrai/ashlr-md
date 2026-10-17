/**
 * handlers.test.ts — orchestration tests ensuring all handler modules
 * integrate correctly with bridge.ts.
 *
 * These tests verify that:
 *  1. Every mcp:// listener is registered when bridge mounts (handlers are wired)
 *  2. Each handler module's exported function is callable and registers the right event
 *  3. The bridge remains a thin wiring layer — no handler logic leaks back into it
 *
 * Individual handler behavior is tested exhaustively in bridge.test.ts.
 * This file focuses on integration / wiring correctness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── React mock — run useEffect synchronously ─────────────────────────────────

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    useEffect: (fn: () => (() => void) | void, _deps?: unknown[]) => {
      fn();
    },
    useRef: (init: unknown) => ({ current: init }),
  };
});

// ─── Tauri core ───────────────────────────────────────────────────────────────

const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// ─── Tauri event listen ───────────────────────────────────────────────────────

type Payload = Record<string, unknown>;
type ListenerFn = (event: { payload: Payload }) => void | Promise<void>;
const listenHandlers = new Map<string, ListenerFn>();
const unlistenMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: ListenerFn) => {
    listenHandlers.set(event, handler);
    return Promise.resolve(unlistenMock);
  }),
}));

// ─── Store stubs ──────────────────────────────────────────────────────────────

vi.mock("../store/recentStore", () => ({
  useRecentStore: {
    getState: () => ({ recents: [], add: vi.fn() }),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock("../store/activityStore", () => ({
  useActivityStore: {
    getState: () => ({ watchedDir: null, files: [] }),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock("../store/toastStore", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock("../store/sessionPersistenceStore", () => ({
  syncDocToSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/export", () => ({
  exportPdf: vi.fn().mockResolvedValue(undefined),
  exportDocx: vi.fn().mockResolvedValue(undefined),
  exportHtml: vi.fn().mockResolvedValue(undefined),
  exportEpub: vi.fn().mockResolvedValue(undefined),
  buildStandaloneHtml: vi.fn(),
  buildStandaloneHtmlWithActiveTemplate: vi.fn(),
  cloneWithoutInjectedChrome: vi.fn((el: Element) => el),
}));

// ─── Import bridge after mocks ────────────────────────────────────────────────

import { useDocumentStore } from "../store/documentStore";
import { useReviewStore } from "../store/reviewStore";
import { useUiStore } from "../store/uiStore";
import { useMcpBridge } from "./bridge";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mountBridge(): void {
  // biome-ignore lint/correctness/useHookAtTopLevel: test harness mounts the hook against a mocked React whose useEffect runs synchronously.
  useMcpBridge();
}

function resetStores(): void {
  useDocumentStore.setState({
    path: "/test.md",
    fileName: "test.md",
    content: "# Hello\n\nWorld.",
    diskContent: "# Hello\n\nWorld.",
    size: 20,
    isLoading: false,
    error: null,
    viewMode: "read",
    isDirty: false,
    externalChange: false,
    pendingDisk: null,
    reloadNonce: 0,
    tabs: [],
    activeId: null,
    pendingOps: [],
  });
  useUiStore.setState({ exportOpen: false, exportFormat: null, zenMode: false });
  useReviewStore.setState({ pending: null, draftComment: "" } as unknown as Parameters<
    typeof useReviewStore.setState
  >[0]);
}

beforeEach(() => {
  listenHandlers.clear();
  invokeMock.mockClear();
  unlistenMock.mockClear();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "read_markdown_file") {
      return Promise.resolve({
        path: "/opened.md",
        file_name: "opened.md",
        content: "# Opened",
        size: 8,
      });
    }
    return Promise.resolve(undefined);
  });
  resetStores();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// Wiring: every listener registered from handler modules
// ════════════════════════════════════════════════════════════════════════════

describe("handlers integration — bridge wires all handler modules", () => {
  it("registers every mcp:// event listener on mount", () => {
    mountBridge();

    const expected = [
      // conversation
      "mcp://open",
      "mcp://present",
      // review
      "mcp://review",
      // edit
      "mcp://set-content",
      "mcp://edit",
      "mcp://stream-edit",
      "mcp://stream-edit-apply",
      // export
      "mcp://export",
    ];

    for (const ev of expected) {
      expect(listenHandlers.has(ev), `listener for "${ev}" not registered`).toBe(true);
    }
    expect(listenHandlers.size).toBe(expected.length);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Bridge push sync — Rust state sync on mount (not handler logic)
// ════════════════════════════════════════════════════════════════════════════

describe("handlers integration — bridge push sync", () => {
  it("calls mcp_sync_state on mount", () => {
    mountBridge();
    const syncCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_sync_state");
    expect(syncCall).toBeDefined();
    expect(syncCall![1]).toMatchObject({ path: "/test.md" });
  });

  it("calls mcp_sync_vault on mount", () => {
    mountBridge();
    const vaultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_sync_vault");
    expect(vaultCall).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Smoke tests: each handler responds correctly (handler modules are callable)
// ════════════════════════════════════════════════════════════════════════════

async function fireEvent(eventName: string, payload: Payload): Promise<void> {
  const handler = listenHandlers.get(eventName);
  if (!handler) throw new Error(`No listener for "${eventName}"`);
  await handler({ payload });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("handlers integration — smoke tests per module", () => {
  // export module
  it("export handler: opens dialog for pdf format", async () => {
    useDocumentStore.setState({ path: "/doc.md" } as Parameters<
      typeof useDocumentStore.setState
    >[0]);
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf" });
    expect(useUiStore.getState().exportOpen).toBe(true);
  });

  it("export handler: writes to outputPath without the dialog", async () => {
    const { exportHtml, exportDocx } = await import("../lib/export");
    useDocumentStore.setState({ path: "/doc.md", fileName: "doc.md" } as Parameters<
      typeof useDocumentStore.setState
    >[0]);
    mountBridge();
    await fireEvent("mcp://export", { format: "html", outputPath: "/out/doc.html" });
    expect(vi.mocked(exportHtml)).toHaveBeenCalledWith("doc", "/out/doc.html");
    await fireEvent("mcp://export", { format: "docx", outputPath: "/out/doc.docx" });
    expect(vi.mocked(exportDocx)).toHaveBeenCalledWith("doc", "/out/doc.docx");
    expect(useUiStore.getState().exportOpen).toBe(false);
  });

  // edit module
  it("edit handler: applies find/replace to live document", async () => {
    useDocumentStore.setState({ path: "/doc.md", content: "hello world" } as Parameters<
      typeof useDocumentStore.setState
    >[0]);
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await fireEvent("mcp://edit", {
      editId: "e1",
      find: "hello world",
      replace: "hi earth",
    });
    expect(useDocumentStore.getState().content).toBe("hi earth");
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_result");
    expect(result![1]).toMatchObject({ ok: true });
  });

  // review module
  it("review handler: registers review in store", async () => {
    mountBridge();
    await fireEvent("mcp://review", {
      reviewId: "rev1",
      path: "/plan.md",
      content: null,
      timeoutMs: 30000,
    });
    expect(useReviewStore.getState().pending?.reviewId).toBe("rev1");
  });

  // conversation module
  it("conversation handler: mcp://open invokes read_markdown_file", async () => {
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_markdown_file")
        return Promise.resolve({
          path: "/new.md",
          file_name: "new.md",
          content: "hi",
          size: 2,
        });
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://open", { path: "/new.md" });
    const call = invokeMock.mock.calls.find((c) => c[0] === "read_markdown_file");
    expect(call).toBeDefined();
  });

  it("conversation handler: mcp://present enters zen mode when doc is open", async () => {
    useDocumentStore.setState({ path: "/doc.md" } as Parameters<
      typeof useDocumentStore.setState
    >[0]);
    mountBridge();
    await fireEvent("mcp://present", { path: null });
    expect(useUiStore.getState().zenMode).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// An edit that asked to be saved reports a failed save
// ════════════════════════════════════════════════════════════════════════════

describe("handlers integration — edits with save: true", () => {
  function failWrites(): void {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "write_markdown_file"
        ? Promise.reject("Permission denied")
        : Promise.resolve(undefined),
    );
  }

  function reply(cmd: string): Record<string, unknown> {
    const call = invokeMock.mock.calls.find((c) => c[0] === cmd);
    expect(call).toBeDefined();
    return call![1] as Record<string, unknown>;
  }

  beforeEach(() => {
    useDocumentStore.setState({
      path: "/doc.md",
      content: "hello world",
      diskContent: "hello world",
    } as Parameters<typeof useDocumentStore.setState>[0]);
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
  });

  it("edit: a successful save is reported as ok", async () => {
    await fireEvent("mcp://edit", {
      editId: "e1",
      find: "hello",
      replace: "hi",
      save: true,
    });
    expect(invokeMock.mock.calls.some((c) => c[0] === "write_markdown_file")).toBe(
      true,
    );
    expect(reply("mcp_edit_result")).toMatchObject({ ok: true, replaced: 1 });
  });

  it("edit: a failed save is not reported as ok", async () => {
    failWrites();
    await fireEvent("mcp://edit", {
      editId: "e1",
      find: "hello",
      replace: "hi",
      save: true,
    });
    // The edit itself is applied to the open document; only the save failed.
    expect(useDocumentStore.getState().content).toBe("hi world");
    const r = reply("mcp_edit_result");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("not saved");
    expect(String(r.error)).toContain("Permission denied");
  });

  it("edit: save on a document with no file is not reported as ok", async () => {
    useDocumentStore.setState({ path: null } as Parameters<
      typeof useDocumentStore.setState
    >[0]);
    await fireEvent("mcp://edit", {
      editId: "e1",
      find: "hello",
      replace: "hi",
      save: true,
    });
    const r = reply("mcp_edit_result");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("not saved");
  });

  it("set-content: reports the replaced content as ok", async () => {
    await fireEvent("mcp://set-content", { editId: "c1", content: "new body" });
    expect(useDocumentStore.getState().content).toBe("new body");
    expect(reply("mcp_edit_result")).toMatchObject({ editId: "c1", ok: true });
  });

  it("set-content: a successful save is reported as ok", async () => {
    await fireEvent("mcp://set-content", { editId: "c1", content: "new", save: true });
    expect(invokeMock.mock.calls.some((c) => c[0] === "write_markdown_file")).toBe(
      true,
    );
    expect(reply("mcp_edit_result")).toMatchObject({ editId: "c1", ok: true });
  });

  it("set-content: a failed save is not reported as ok", async () => {
    failWrites();
    await fireEvent("mcp://set-content", { editId: "c1", content: "new", save: true });
    expect(useDocumentStore.getState().content).toBe("new");
    const r = reply("mcp_edit_result");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("not saved");
    expect(String(r.error)).toContain("Permission denied");
  });

  it("set-content: save on a document with no file is not reported as ok", async () => {
    useDocumentStore.setState({ path: null } as Parameters<
      typeof useDocumentStore.setState
    >[0]);
    await fireEvent("mcp://set-content", { editId: "c1", content: "new", save: true });
    const r = reply("mcp_edit_result");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("not saved");
  });

  it("stream-edit-apply: a failed save is not reported as ok", async () => {
    failWrites();
    await fireEvent("mcp://stream-edit-apply", {
      editId: "s1",
      find: "hello",
      replace: "hi",
      matchIndex: 0,
      save: true,
    });
    const r = reply("mcp_stream_edit_apply_result");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("not saved");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Open and present report what the window did
// ════════════════════════════════════════════════════════════════════════════

describe("handlers integration — open and present report the outcome", () => {
  function reply(): Record<string, unknown> {
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_result");
    expect(call).toBeDefined();
    return call![1] as Record<string, unknown>;
  }

  function failReads(): void {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "read_markdown_file"
        ? Promise.reject("Could not read /gone.md: No such file or directory")
        : Promise.resolve(undefined),
    );
  }

  beforeEach(() => {
    mountBridge();
    invokeMock.mockClear();
  });

  it("open: reports ok once the document is open", async () => {
    await fireEvent("mcp://open", { editId: "o1", path: "/opened.md", mode: "edit" });
    expect(useDocumentStore.getState().path).toBe("/opened.md");
    expect(useDocumentStore.getState().viewMode).toBe("edit");
    expect(reply()).toMatchObject({ editId: "o1", ok: true, error: null });
  });

  it("open: a failed read is reported with its reason", async () => {
    failReads();
    await fireEvent("mcp://open", { editId: "o1", path: "/gone.md" });
    expect(useDocumentStore.getState().path).toBe("/test.md");
    const r = reply();
    expect(r).toMatchObject({ editId: "o1", ok: false });
    expect(String(r.error)).toContain("No such file or directory");
  });

  it("open: a throwing openPath is still answered", async () => {
    const openPath = vi
      .spyOn(useDocumentStore.getState(), "openPath")
      .mockRejectedValue(new Error("boom"));
    await fireEvent("mcp://open", { editId: "o1", path: "/x.md" });
    openPath.mockRestore();
    const r = reply();
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("boom");
  });

  it("open: with no editId (a review opening its file) nothing is replied", async () => {
    failReads();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fireEvent("mcp://open", { path: "/gone.md", mode: "read" });
    warn.mockRestore();
    expect(invokeMock.mock.calls.some((c) => c[0] === "mcp_edit_result")).toBe(false);
  });

  it("present: a failed open is reported and zen mode is not entered", async () => {
    failReads();
    await fireEvent("mcp://present", { editId: "p1", path: "/gone.md" });
    expect(useUiStore.getState().zenMode).toBe(false);
    const r = reply();
    expect(r).toMatchObject({ editId: "p1", ok: false });
    expect(String(r.error)).toContain("No such file or directory");
  });

  it("present: reports ok once the document is presented", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "read_markdown_file"
        ? Promise.resolve({
            path: "/talk.md",
            file_name: "talk.md",
            content: "# T",
            size: 3,
          })
        : Promise.resolve(undefined),
    );
    await fireEvent("mcp://present", { editId: "p1", path: "/talk.md" });
    expect(useUiStore.getState().zenMode).toBe(true);
    expect(reply()).toMatchObject({ editId: "p1", ok: true });
  });

  it("present: with no document open the failure is reported", async () => {
    useDocumentStore.setState({ path: null } as Parameters<
      typeof useDocumentStore.setState
    >[0]);
    await fireEvent("mcp://present", { editId: "p1", path: null });
    expect(useUiStore.getState().zenMode).toBe(false);
    expect(reply()).toMatchObject({ editId: "p1", ok: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// stream-edit answers even when applying throws
// ════════════════════════════════════════════════════════════════════════════

describe("handlers integration — stream-edit failures are replied", () => {
  it("preview: false replies with the error when applying throws", async () => {
    useDocumentStore.setState({ path: "/doc.md", content: "hello world" } as Parameters<
      typeof useDocumentStore.setState
    >[0]);
    mountBridge();
    invokeMock.mockClear();
    const setContent = vi
      .spyOn(useDocumentStore.getState(), "setContent")
      .mockImplementation(() => {
        throw new Error("editor gone");
      });
    await fireEvent("mcp://stream-edit", {
      editId: "s1",
      find: "hello",
      replace: "hi",
      preview: false,
    });
    setContent.mockRestore();
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    expect(call).toBeDefined();
    const r = call![1] as Record<string, unknown>;
    expect(r).toMatchObject({ editId: "s1", ok: false });
    expect(String(r.error)).toContain("editor gone");
  });
});
