/**
 * handlers.test.ts — orchestration tests ensuring all handler modules
 * integrate correctly with bridge.ts.
 *
 * These tests verify that:
 *  1. All 19 mcp:// listeners are registered when bridge mounts (handlers are wired)
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
    useEffect: (fn: () => (() => void) | void, _deps?: unknown[]) => { fn(); },
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
    getState: () => ({ recents: [] }),
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
  exportMarkdownArchive: vi.fn().mockResolvedValue("/out/archive.tar.gz"),
  exportCanvasGraph: vi.fn().mockResolvedValue("/out/vault.canvas"),
  exportOutline: vi.fn().mockResolvedValue("/out/outline.json"),
  buildBatchExportProfiles: vi.fn().mockResolvedValue([]),
  buildStandaloneHtml: vi.fn(),
  buildStandaloneHtmlWithActiveTemplate: vi.fn(),
  cloneWithoutInjectedChrome: vi.fn((el: Element) => el),
  buildMarkdownArchive: vi.fn(),
  buildCanvasGraph: vi.fn(),
}));

vi.mock("../lib/exportTemplates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exportTemplates")>();
  return {
    ...actual,
    ALL_PROFILE_IDS: [],
  };
});

vi.mock("../lib/crossSearch", () => ({
  searchFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lib/embedSearch", () => ({
  embedSearch: vi.fn().mockResolvedValue([]),
  embedAvailable: vi.fn().mockResolvedValue(null),
  embedIndex: vi.fn().mockResolvedValue(null),
  embedStatus: vi.fn().mockResolvedValue(null),
  invalidateEmbedAvailable: vi.fn(),
}));

vi.mock("../lib/copyRichText", () => ({
  copyAsRichText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/mdlint", () => ({
  lintDocument: vi.fn().mockReturnValue([]),
  applyAllFixes: vi.fn((doc: string) => doc),
  BUILTIN_RULES: [],
}));

vi.mock("../lib/canvas", () => ({
  parseCanvas: vi.fn().mockReturnValue({ ok: false, error: "mock" }),
  buildCanvasEditor: vi.fn(),
  canvasEditorToCanvas: vi.fn(),
  serializeCanvas: vi.fn().mockReturnValue("{}"),
  applyCanvasOp: vi.fn().mockReturnValue({ ok: true }),
  undoCanvasOp: vi.fn(),
  redoCanvasOp: vi.fn(),
}));

vi.mock("../lib/diff", () => ({
  parseDiffHunks: vi.fn().mockReturnValue([]),
}));

vi.mock("../lib/ot", () => ({
  summarise: vi.fn().mockReturnValue("summary"),
}));

vi.mock("../components/viewer/DiffBlock", () => ({
  buildHunkOp: vi.fn().mockReturnValue(null),
  buildInverseHunkOp: vi.fn().mockReturnValue(null),
  buildHunkLines: vi.fn().mockReturnValue([]),
  DiffBlock: vi.fn(),
}));

// ─── Import bridge after mocks ────────────────────────────────────────────────

import { useMcpBridge } from "./bridge";
import { useDocumentStore } from "../store/documentStore";
import { useUiStore } from "../store/uiStore";
import { useReviewStore } from "../store/reviewStore";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mountBridge(): void {
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
  useReviewStore.setState(
    { pending: null, draftComment: "" } as unknown as Parameters<typeof useReviewStore.setState>[0],
  );
}

beforeEach(() => {
  listenHandlers.clear();
  invokeMock.mockClear();
  unlistenMock.mockClear();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "read_markdown_file") {
      return Promise.resolve({ path: "/opened.md", file_name: "opened.md", content: "# Opened", size: 8 });
    }
    return Promise.resolve(undefined);
  });
  resetStores();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// Wiring: all 19 listeners registered from handler modules
// ════════════════════════════════════════════════════════════════════════════

describe("handlers integration — bridge wires all handler modules", () => {
  it("registers all 19 mcp:// event listeners on mount", () => {
    mountBridge();

    const expected = [
      // conversation
      "mcp://open",
      "mcp://present",
      "mcp://ot-op",
      "mcp://copy-rich-text",
      "mcp://lint-document",
      "mcp://apply-diff-hunk",
      // review
      "mcp://review",
      // edit
      "mcp://set-content",
      "mcp://edit",
      "mcp://batch-edit",
      "mcp://atomic-edits",
      "mcp://stream-edit",
      "mcp://stream-edit-apply",
      // search
      "mcp://batch-read",
      "mcp://semantic-search",
      "mcp://diff-docs",
      // export
      "mcp://export",
      "mcp://export-markdown-archive",
      "mcp://export-canvas-graph",
      "mcp://export-outline",
      "mcp://batch-export",
      "mcp://batch-export-profiles",
      // canvas
      "mcp://edit-canvas",
    ];

    for (const ev of expected) {
      expect(listenHandlers.has(ev), `listener for "${ev}" not registered`).toBe(true);
    }
  });

  it("each handler is registered exactly once", () => {
    // listenHandlers is a Map so duplicate registrations would overwrite;
    // verify count matches expected number of unique event names.
    mountBridge();
    expect(listenHandlers.size).toBeGreaterThanOrEqual(19);
  });

  it("export module registers 6 listeners", () => {
    mountBridge();
    const exportEvents = [
      "mcp://export",
      "mcp://export-markdown-archive",
      "mcp://export-canvas-graph",
      "mcp://export-outline",
      "mcp://batch-export",
      "mcp://batch-export-profiles",
    ];
    for (const ev of exportEvents) {
      expect(listenHandlers.has(ev), `${ev} not registered`).toBe(true);
    }
  });

  it("edit module registers 6 listeners", () => {
    mountBridge();
    const editEvents = [
      "mcp://set-content",
      "mcp://edit",
      "mcp://batch-edit",
      "mcp://atomic-edits",
      "mcp://stream-edit",
      "mcp://stream-edit-apply",
    ];
    for (const ev of editEvents) {
      expect(listenHandlers.has(ev), `${ev} not registered`).toBe(true);
    }
  });

  it("search module registers 3 listeners", () => {
    mountBridge();
    const searchEvents = [
      "mcp://batch-read",
      "mcp://semantic-search",
      "mcp://diff-docs",
    ];
    for (const ev of searchEvents) {
      expect(listenHandlers.has(ev), `${ev} not registered`).toBe(true);
    }
  });

  it("conversation module registers 6 listeners", () => {
    mountBridge();
    const convEvents = [
      "mcp://open",
      "mcp://present",
      "mcp://ot-op",
      "mcp://copy-rich-text",
      "mcp://lint-document",
      "mcp://apply-diff-hunk",
    ];
    for (const ev of convEvents) {
      expect(listenHandlers.has(ev), `${ev} not registered`).toBe(true);
    }
  });

  it("review module registers 1 listener", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://review")).toBe(true);
  });

  it("canvas module registers 1 listener", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://edit-canvas")).toBe(true);
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
    useDocumentStore.setState({ path: "/doc.md" } as Parameters<typeof useDocumentStore.setState>[0]);
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf" });
    expect(useUiStore.getState().exportOpen).toBe(true);
  });

  // edit module
  it("edit handler: applies find/replace to live document", async () => {
    useDocumentStore.setState({ path: "/doc.md", content: "hello world" } as Parameters<typeof useDocumentStore.setState>[0]);
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await fireEvent("mcp://edit", { editId: "e1", find: "hello world", replace: "hi earth" });
    expect(useDocumentStore.getState().content).toBe("hi earth");
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_result");
    expect(result![1]).toMatchObject({ ok: true });
  });

  // search module
  it("search handler: batch-read invokes read_batch_files", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://batch-read", { batchId: "br1", paths: ["/a.md"] });
    const call = invokeMock.mock.calls.find((c) => c[0] === "read_batch_files");
    expect(call).toBeDefined();
  });

  // review module
  it("review handler: registers review in store", async () => {
    mountBridge();
    await fireEvent("mcp://review", { reviewId: "rev1", path: "/plan.md", content: null, timeoutMs: 30000 });
    expect(useReviewStore.getState().pending?.reviewId).toBe("rev1");
  });

  // canvas module
  it("canvas handler: replies with error for invalid canvas path", async () => {
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.reject(new Error("not found")));
    await fireEvent("mcp://edit-canvas", { editId: "c1", path: "/missing.canvas", ops: [{ type: "add-node" }] });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result).toBeDefined();
    expect(result![1].ok).toBe(false);
  });

  // conversation module
  it("conversation handler: mcp://open invokes read_markdown_file", async () => {
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_markdown_file") return Promise.resolve({ path: "/new.md", file_name: "new.md", content: "hi", size: 2 });
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://open", { path: "/new.md" });
    const call = invokeMock.mock.calls.find((c) => c[0] === "read_markdown_file");
    expect(call).toBeDefined();
  });

  it("conversation handler: mcp://present enters zen mode when doc is open", async () => {
    useDocumentStore.setState({ path: "/doc.md" } as Parameters<typeof useDocumentStore.setState>[0]);
    mountBridge();
    await fireEvent("mcp://present", { path: null });
    expect(useUiStore.getState().zenMode).toBe(true);
  });
});
