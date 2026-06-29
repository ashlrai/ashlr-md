/**
 * bridge.test.ts — tests for the MCP bridge event routing logic.
 *
 * Strategy: mock `react` so useEffect runs its callback synchronously and
 * useRef returns a writable plain object. This lets useMcpBridge() register
 * all its Tauri event listeners immediately without a React renderer.
 *
 * The `listen` mock captures each handler by event name; tests fire events
 * by calling those handlers directly and then assert on Zustand store state
 * and `invoke` calls.
 *
 * Key invariants verified:
 *  1. mcp://export → uiStore.openExport() when a document is open
 *  2. mcp://export with no open doc → toast shown, dialog NOT opened
 *  3. All three formats (pdf/html/docx) trigger the dialog
 *  4. mcp://set-content → documentStore.content updated + sync pushed
 *  5. mcp://edit → correct find/replace on live content; mcp_edit_result called
 *  6. mcp://review → review registered in reviewStore
 *  7. mcp://present → zenMode=true + viewMode=read
 *  8. mcp://open → read_markdown_file invoked
 *  9. Mount: mcp_sync_state + mcp_sync_vault both called with correct data
 * 10. All six mcp:// listeners registered
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── React mock — run useEffect synchronously, provide stub useRef ────────────
//
// Must be FIRST vi.mock call and must not reference any variable defined later
// in this file (hoisting limitation).

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  let effectCleanup: (() => void) | undefined;
  return {
    ...real,
    useEffect: (fn: () => (() => void) | void, _deps?: unknown[]) => {
      const cleanup = fn();
      if (typeof cleanup === "function") effectCleanup = cleanup;
    },
    useRef: (init: unknown) => ({ current: init }),
    // Expose the cleanup so tests can call it via getLastCleanup().
    __getLastCleanup: () => effectCleanup,
  };
});

// ─── Tauri core invoke ────────────────────────────────────────────────────────

const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// ─── Export function mocks ────────────────────────────────────────────────────
//
// We mock the three export functions from src/lib/export so bridge tests are
// fully isolated from DOM/Tauri-dialog dependencies.  Individual tests can
// override these with mockResolvedValue / mockRejectedValue as needed.

const exportPdfMock = vi.fn().mockResolvedValue(undefined);
const exportDocxMock = vi.fn().mockResolvedValue(undefined);
const exportHtmlMock = vi.fn().mockResolvedValue(undefined);
const exportMarkdownArchiveMock = vi.fn().mockResolvedValue("/out/archive.tar.gz");
const exportCanvasGraphMock = vi.fn().mockResolvedValue("/out/vault.canvas");
// ─── DiffBlock mock — buildHunkOp used by mcp://apply-diff-hunk ──────────────

const buildHunkOpMock = vi.fn();
vi.mock("../components/viewer/DiffBlock", () => ({
  buildHunkOp: (...args: unknown[]) => buildHunkOpMock(...args),
  buildInverseHunkOp: vi.fn().mockReturnValue(null),
  buildHunkLines: vi.fn().mockReturnValue([]),
  DiffBlock: vi.fn(),
}));

vi.mock("../lib/export", () => ({
  exportPdf: (...args: unknown[]) => exportPdfMock(...args),
  exportDocx: (...args: unknown[]) => exportDocxMock(...args),
  exportHtml: (...args: unknown[]) => exportHtmlMock(...args),
  exportMarkdownArchive: (...args: unknown[]) => exportMarkdownArchiveMock(...args),
  exportCanvasGraph: (...args: unknown[]) => exportCanvasGraphMock(...args),
  // Re-export anything else export.ts might expose so other imports don't break.
  buildStandaloneHtml: vi.fn(),
  buildStandaloneHtmlWithActiveTemplate: vi.fn(),
  cloneWithoutInjectedChrome: vi.fn((el: Element) => el),
  buildMarkdownArchive: vi.fn(),
  buildCanvasGraph: vi.fn(),
}));

// ─── Tauri event listen ───────────────────────────────────────────────────────
//
// Capture handlers by event name so tests can fire fake events directly.

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
    getState: () => ({ recents: ["/a.md", "/b.md"] }),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock("../store/activityStore", () => ({
  useActivityStore: {
    getState: () => ({
      watchedDir: "/vault",
      files: [
        { path: "/vault/a.md", name: "a.md", dir: "/vault", mtimeMs: 1000, size: 100 },
        { path: "/vault/b.md", name: "b.md", dir: "/vault", mtimeMs: 2000, size: 200 },
      ],
    }),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

// ─── crossSearch / embedSearch mocks ─────────────────────────────────────────

const searchFilesMock = vi.fn().mockResolvedValue([]);
vi.mock("../lib/crossSearch", () => ({
  searchFiles: (...args: unknown[]) => searchFilesMock(...args),
}));

const embedSearchMock = vi.fn().mockResolvedValue([]);
const embedAvailableMock = vi.fn().mockResolvedValue(null);
vi.mock("../lib/embedSearch", () => ({
  embedSearch: (...args: unknown[]) => embedSearchMock(...args),
  embedAvailable: (...args: unknown[]) => embedAvailableMock(...args),
  embedIndex: vi.fn().mockResolvedValue(null),
  embedStatus: vi.fn().mockResolvedValue(null),
  invalidateEmbedAvailable: vi.fn(),
}));

// ─── Toast capture ────────────────────────────────────────────────────────────

const toastInfoMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock("../store/toastStore", () => ({
  toast: {
    info: (...a: unknown[]) => toastInfoMock(...a),
    success: (...a: unknown[]) => toastSuccessMock(...a),
    error: (...a: unknown[]) => toastErrorMock(...a),
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { useDocumentStore } from "../store/documentStore";
import { useUiStore } from "../store/uiStore";
import { useReviewStore } from "../store/reviewStore";
import { useMcpBridge } from "./bridge";

// ─── Fire a fake Tauri event ──────────────────────────────────────────────────

async function fireEvent(eventName: string, payload: Payload): Promise<void> {
  const handler = listenHandlers.get(eventName);
  if (!handler) throw new Error(`No listener registered for "${eventName}". Registered: [${[...listenHandlers.keys()].join(", ")}]`);
  await handler({ payload });
  // Flush microtask queue so async handler chains (Promises) settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ─── Mount the bridge once per test ──────────────────────────────────────────

function mountBridge(): void {
  // useMcpBridge() calls useEffect(fn, []).  Because of our react mock,
  // the effect callback fires synchronously here and registers all listeners
  // via listen() (which immediately sets entries in listenHandlers).
  useMcpBridge();
}

// ─── Store reset helpers ──────────────────────────────────────────────────────

type DocState = Parameters<typeof useDocumentStore.setState>[0];

function resetDocumentStore(patch: Partial<DocState> = {}): void {
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
    ...patch,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Setup / teardown
// ════════════════════════════════════════════════════════════════════════════

beforeEach(() => {
  listenHandlers.clear();
  invokeMock.mockClear();
  unlistenMock.mockClear();
  toastInfoMock.mockClear();
  toastSuccessMock.mockClear();
  toastErrorMock.mockClear();
  exportPdfMock.mockClear();
  exportDocxMock.mockClear();
  exportHtmlMock.mockClear();
  exportMarkdownArchiveMock.mockClear();
  exportCanvasGraphMock.mockClear();
  buildHunkOpMock.mockClear();
  searchFilesMock.mockClear();
  embedSearchMock.mockClear();
  embedAvailableMock.mockClear();
  // Default: all export functions succeed.
  exportPdfMock.mockResolvedValue(undefined);
  exportDocxMock.mockResolvedValue(undefined);
  exportHtmlMock.mockResolvedValue(undefined);
  exportMarkdownArchiveMock.mockResolvedValue("/out/archive.tar.gz");
  exportCanvasGraphMock.mockResolvedValue("/out/vault.canvas");
  // Default: no embedding model, no keyword hits.
  searchFilesMock.mockResolvedValue([]);
  embedSearchMock.mockResolvedValue([]);
  embedAvailableMock.mockResolvedValue(null);

  resetDocumentStore();
  useUiStore.setState({ exportOpen: false, exportFormat: null, zenMode: false });
  useReviewStore.setState(
    { pending: null, draftComment: "" } as unknown as Parameters<typeof useReviewStore.setState>[0]
  );

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
});

afterEach(() => {
  vi.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// Bridge mount — listeners registered + initial Rust state push
// ════════════════════════════════════════════════════════════════════════════

describe("useMcpBridge — mount", () => {
  it("registers listeners for all sixteen mcp:// events", () => {
    mountBridge();
    const expected = [
      "mcp://open",
      "mcp://set-content",
      "mcp://edit",
      "mcp://export",
      "mcp://review",
      "mcp://present",
      "mcp://export-markdown-archive",
      "mcp://export-canvas-graph",
      "mcp://batch-read",
      "mcp://batch-edit",
      "mcp://semantic-search",
      "mcp://batch-export",
      "mcp://diff-docs",
      "mcp://apply-diff-hunk",
      "mcp://atomic-edits",
      "mcp://edit-canvas",
    ];
    for (const ev of expected) {
      expect(listenHandlers.has(ev), `listener for "${ev}" not registered`).toBe(true);
    }
  });

  it("pushes current document state via mcp_sync_state on mount", () => {
    mountBridge();
    const syncCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_sync_state");
    expect(syncCall).toBeDefined();
    expect(syncCall![1]).toMatchObject({ path: "/test.md" });
  });

  it("pushes vault state via mcp_sync_vault on mount", () => {
    mountBridge();
    const vaultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_sync_vault");
    expect(vaultCall).toBeDefined();
    expect(vaultCall![1]).toMatchObject({ watchedDir: "/vault" });
  });

  it("does not open export dialog on mount", () => {
    mountBridge();
    expect(useUiStore.getState().exportOpen).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://export — export dialog flow
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://export event — export dialog flow", () => {
  it("opens the export dialog when a document is open (pdf)", async () => {
    resetDocumentStore({ path: "/my-doc.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf" });
    expect(useUiStore.getState().exportOpen).toBe(true);
  });

  it("opens the export dialog for html format", async () => {
    resetDocumentStore({ path: "/report.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "html" });
    expect(useUiStore.getState().exportOpen).toBe(true);
  });

  it("opens the export dialog for docx format", async () => {
    resetDocumentStore({ path: "/report.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "docx" });
    expect(useUiStore.getState().exportOpen).toBe(true);
  });

  it("does NOT open the export dialog when no document is open", async () => {
    resetDocumentStore({ path: null });
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf" });
    expect(useUiStore.getState().exportOpen).toBe(false);
  });

  it("shows an info toast when no document is open", async () => {
    resetDocumentStore({ path: null });
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf" });
    expect(toastInfoMock).toHaveBeenCalledWith(
      expect.stringMatching(/open a document/i),
    );
  });

  it("export dialog stays closed before any export event fires", () => {
    resetDocumentStore({ path: "/doc.md" });
    mountBridge();
    expect(useUiStore.getState().exportOpen).toBe(false);
  });

  it("export dialog can be opened, closed, then opened again", async () => {
    resetDocumentStore({ path: "/doc.md" });
    mountBridge();

    await fireEvent("mcp://export", { format: "pdf" });
    expect(useUiStore.getState().exportOpen).toBe(true);

    useUiStore.getState().closeExport();
    expect(useUiStore.getState().exportOpen).toBe(false);

    await fireEvent("mcp://export", { format: "html" });
    expect(useUiStore.getState().exportOpen).toBe(true);
  });

  it("export event with outputPath payload uses the direct pipeline (dialog stays closed)", async () => {
    // When outputPath is provided the bridge bypasses the dialog and runs the
    // export function directly, so exportOpen stays false.
    resetDocumentStore({ path: "/doc.md", fileName: "doc.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf", outputPath: "/tmp/out.pdf" });
    expect(useUiStore.getState().exportOpen).toBe(false);
    expect(exportPdfMock).toHaveBeenCalled();
  });

  it("does not show any toast when export dialog opens successfully", async () => {
    resetDocumentStore({ path: "/doc.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf" });
    expect(toastInfoMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("all three valid formats open the dialog", async () => {
    resetDocumentStore({ path: "/doc.md" });
    mountBridge();
    for (const format of ["pdf", "html", "docx"]) {
      useUiStore.getState().closeExport();
      await fireEvent("mcp://export", { format });
      expect(useUiStore.getState().exportOpen).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://set-content — content replacement events
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://set-content event", () => {
  it("updates documentStore content from the payload", async () => {
    resetDocumentStore({ content: "old content" });
    mountBridge();
    await fireEvent("mcp://set-content", { content: "# New content" });
    expect(useDocumentStore.getState().content).toBe("# New content");
  });

  it("triggers an immediate mcp_sync_state after updating content", async () => {
    resetDocumentStore({ path: "/doc.md", content: "old" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://set-content", { content: "new content" });
    const syncCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_sync_state");
    expect(syncCall).toBeDefined();
  });

  it("does not trigger a save by default (no write_markdown_file call)", async () => {
    resetDocumentStore({ path: "/doc.md", content: "old" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://set-content", { content: "new content" });
    const saveCall = invokeMock.mock.calls.find((c) => c[0] === "write_markdown_file");
    expect(saveCall).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://edit — precise find/replace on live document content
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://edit event", () => {
  it("applies a unique find/replace against live document content", async () => {
    resetDocumentStore({ content: "# Title\n\nHello world.\n" });
    mountBridge();
    await fireEvent("mcp://edit", {
      editId: "edit-001",
      find: "Hello world.",
      replace: "Hello there.",
    });
    expect(useDocumentStore.getState().content).toBe("# Title\n\nHello there.\n");
  });

  it("calls mcp_edit_result with ok=true on a successful edit", async () => {
    resetDocumentStore({ content: "unique phrase here" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://edit", {
      editId: "edit-002",
      find: "unique phrase here",
      replace: "replaced phrase",
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ editId: "edit-002", ok: true });
  });

  it("calls mcp_edit_result with ok=false when find string is not found", async () => {
    resetDocumentStore({ content: "some other content" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://edit", {
      editId: "edit-003",
      find: "text that does not exist",
      replace: "replacement",
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ editId: "edit-003", ok: false });
  });

  it("always calls mcp_edit_result when find is not unique (prevents Rust timeout)", async () => {
    // "the" appears twice — applyUniqueEdit rejects the ambiguous match.
    resetDocumentStore({ content: "the cat and the dog" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://edit", {
      editId: "edit-004",
      find: "the",
      replace: "a",
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
    expect(typeof resultCall![1].error).toBe("string");
  });

  it("includes a descriptive error string when find is missing from the document", async () => {
    resetDocumentStore({ content: "abc def" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://edit", {
      editId: "edit-005",
      find: "xyz not here",
      replace: "something",
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_result");
    expect(resultCall).toBeDefined();
    const err = resultCall![1].error as string | null;
    expect(err).toBeTruthy();
    expect(err!.length).toBeGreaterThan(0);
  });

  it("does not mutate document content when edit fails", async () => {
    const originalContent = "unchanged content";
    resetDocumentStore({ content: originalContent });
    mountBridge();
    await fireEvent("mcp://edit", {
      editId: "edit-006",
      find: "does not exist",
      replace: "anything",
    });
    expect(useDocumentStore.getState().content).toBe(originalContent);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://review — human review registration
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://review event", () => {
  it("registers a path-based review in the review store", async () => {
    mountBridge();
    await fireEvent("mcp://review", {
      reviewId: "rev-abc",
      path: "/plan.md",
      content: null,
      timeoutMs: 60000,
    });
    const { pending } = useReviewStore.getState();
    expect(pending).not.toBeNull();
    expect(pending!.reviewId).toBe("rev-abc");
  });

  it("registers an inline-content review (no path) in the review store", async () => {
    mountBridge();
    await fireEvent("mcp://review", {
      reviewId: "rev-inline",
      path: null,
      content: "# Inline plan\n\nStep 1.",
      timeoutMs: 30000,
    });
    const { pending } = useReviewStore.getState();
    expect(pending).not.toBeNull();
    expect(pending!.reviewId).toBe("rev-inline");
    expect(pending!.content).toBe("# Inline plan\n\nStep 1.");
  });

  it("stores a registeredAt timestamp on the review", async () => {
    const before = Date.now();
    mountBridge();
    await fireEvent("mcp://review", {
      reviewId: "rev-ts",
      path: "/doc.md",
      content: null,
      timeoutMs: 10000,
    });
    const { pending } = useReviewStore.getState();
    expect(pending).not.toBeNull();
    expect(pending!.registeredAt).toBeGreaterThanOrEqual(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://present — distraction-free presentation mode
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://present event", () => {
  it("enters zen mode when a document is open and no path is given", async () => {
    resetDocumentStore({ path: "/doc.md" });
    mountBridge();
    await fireEvent("mcp://present", { path: null });
    expect(useUiStore.getState().zenMode).toBe(true);
  });

  it("sets viewMode to read when entering presentation mode", async () => {
    resetDocumentStore({ path: "/doc.md", viewMode: "edit" });
    mountBridge();
    await fireEvent("mcp://present", { path: null });
    expect(useDocumentStore.getState().viewMode).toBe("read");
  });

  it("does not enter zen mode when no document is open and no path given", async () => {
    resetDocumentStore({ path: null });
    mountBridge();
    await fireEvent("mcp://present", { path: null });
    expect(useUiStore.getState().zenMode).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://open — file open routing
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://open event", () => {
  it("invokes read_markdown_file with the provided path", async () => {
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://open", { path: "/new.md" });
    const readCall = invokeMock.mock.calls.find((c) => c[0] === "read_markdown_file");
    expect(readCall).toBeDefined();
  });

  it("sets viewMode to edit when mode=edit is specified", async () => {
    resetDocumentStore({ viewMode: "read" });
    mountBridge();
    await fireEvent("mcp://open", { path: "/doc.md", mode: "edit" });
    expect(useDocumentStore.getState().viewMode).toBe("edit");
  });

  it("keeps viewMode as read when mode=read is specified", async () => {
    resetDocumentStore({ viewMode: "edit" });
    mountBridge();
    await fireEvent("mcp://open", { path: "/doc.md", mode: "read" });
    expect(useDocumentStore.getState().viewMode).toBe("read");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://ot-op — OT operation application
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://ot-op event", () => {
  it("registers listener for mcp://ot-op on mount", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://ot-op")).toBe(true);
  });

  it("applies a valid insert op to the document", async () => {
    resetDocumentStore({ content: "hello world" });
    mountBridge();
    await fireEvent("mcp://ot-op", {
      opId: "ot-001",
      agentId: "agentA",
      seq: 1,
      clock: {},
      // insert "!" at position 11 (end of "hello world")
      components: [{ type: "retain", count: 11 }, { type: "insert", text: "!" }],
    });
    expect(useDocumentStore.getState().content).toBe("hello world!");
  });

  it("calls mcp_ot_result with ok=true on successful apply", async () => {
    resetDocumentStore({ content: "hello" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://ot-op", {
      opId: "ot-002",
      agentId: "agentA",
      seq: 1,
      clock: {},
      components: [{ type: "retain", count: 5 }, { type: "insert", text: " world" }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_ot_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ opId: "ot-002", ok: true });
  });

  it("calls mcp_ot_result with ok=false when op is inconsistent with document", async () => {
    // Doc is 5 chars but op retains 20 — out of bounds
    resetDocumentStore({ content: "hello" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://ot-op", {
      opId: "ot-003",
      agentId: "agentA",
      seq: 1,
      clock: {},
      components: [{ type: "retain", count: 20 }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_ot_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ opId: "ot-003", ok: false });
  });

  it("does not mutate document content when op fails", async () => {
    resetDocumentStore({ content: "unchanged" });
    mountBridge();
    await fireEvent("mcp://ot-op", {
      opId: "ot-004",
      agentId: "agentA",
      seq: 1,
      clock: {},
      // retain 100 chars on a 9-char doc → invalid
      components: [{ type: "retain", count: 100 }],
    });
    expect(useDocumentStore.getState().content).toBe("unchanged");
  });

  it("adds the op to pendingOps after successful apply", async () => {
    resetDocumentStore({ content: "abc" });
    mountBridge();
    await fireEvent("mcp://ot-op", {
      opId: "ot-005",
      agentId: "agentB",
      seq: 1,
      clock: { agentB: 0 },
      components: [{ type: "insert", text: "X" }, { type: "retain", count: 3 }],
    });
    const { pendingOps } = useDocumentStore.getState();
    expect(pendingOps.length).toBeGreaterThan(0);
    expect(pendingOps[0].id).toBe("ot-005");
  });

  it("applies a delete op correctly", async () => {
    resetDocumentStore({ content: "hello world" });
    mountBridge();
    await fireEvent("mcp://ot-op", {
      opId: "ot-006",
      agentId: "agentA",
      seq: 1,
      clock: {},
      // delete " world" (6 chars starting at position 5)
      components: [{ type: "retain", count: 5 }, { type: "delete", count: 6 }],
    });
    expect(useDocumentStore.getState().content).toBe("hello");
  });

  it("always calls mcp_ot_result even on failure (prevents Rust timeout)", async () => {
    resetDocumentStore({ content: "short" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://ot-op", {
      opId: "ot-007",
      agentId: "agentA",
      seq: 1,
      clock: {},
      components: [{ type: "retain", count: 9999 }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_ot_result");
    expect(resultCall).toBeDefined();
  });

  it("triggers mcp_sync_state after a successful apply", async () => {
    resetDocumentStore({ path: "/doc.md", content: "test" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://ot-op", {
      opId: "ot-008",
      agentId: "agentA",
      seq: 1,
      clock: {},
      components: [{ type: "retain", count: 4 }, { type: "insert", text: "!" }],
    });
    const syncCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_sync_state");
    expect(syncCall).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://export — format pre-selection (dialog path, no outputPath)
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://export — format pre-selection in dialog", () => {
  it("passes pdf format hint to uiStore so the dialog can pre-select it", async () => {
    resetDocumentStore({ path: "/report.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf" });
    expect(useUiStore.getState().exportFormat).toBe("pdf");
  });

  it("passes html format hint to uiStore", async () => {
    resetDocumentStore({ path: "/report.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "html" });
    expect(useUiStore.getState().exportFormat).toBe("html");
  });

  it("passes docx format hint to uiStore", async () => {
    resetDocumentStore({ path: "/report.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "docx" });
    expect(useUiStore.getState().exportFormat).toBe("docx");
  });

  it("opens the dialog and stores format together (both set atomically)", async () => {
    resetDocumentStore({ path: "/doc.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "html" });
    const ui = useUiStore.getState();
    expect(ui.exportOpen).toBe(true);
    expect(ui.exportFormat).toBe("html");
  });

  it("clears exportFormat when dialog is closed", async () => {
    resetDocumentStore({ path: "/doc.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf" });
    useUiStore.getState().closeExport();
    expect(useUiStore.getState().exportFormat).toBeNull();
    expect(useUiStore.getState().exportOpen).toBe(false);
  });

  it("does NOT call mcp_export_result when no outputPath (dialog path)", async () => {
    resetDocumentStore({ path: "/doc.md" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export", { format: "pdf" });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_export_result");
    expect(resultCall).toBeUndefined();
  });

  it("does NOT invoke any export function when no outputPath (dialog path)", async () => {
    resetDocumentStore({ path: "/doc.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf" });
    expect(exportPdfMock).not.toHaveBeenCalled();
    expect(exportDocxMock).not.toHaveBeenCalled();
    expect(exportHtmlMock).not.toHaveBeenCalled();
  });

  it("format hint is null initially (before any MCP export event)", () => {
    mountBridge();
    expect(useUiStore.getState().exportFormat).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://export — direct export pipeline (outputPath provided)
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://export — direct export pipeline with outputPath", () => {
  // ── PDF ──────────────────────────────────────────────────────────────────

  it("calls exportPdf with the document title when format=pdf and outputPath is set", async () => {
    resetDocumentStore({ path: "/notes/my-report.md", fileName: "my-report.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf", outputPath: "/tmp/out.pdf" });
    expect(exportPdfMock).toHaveBeenCalledWith("my-report");
    expect(exportDocxMock).not.toHaveBeenCalled();
    expect(exportHtmlMock).not.toHaveBeenCalled();
  });

  it("calls mcp_export_result with ok=true after successful pdf export", async () => {
    resetDocumentStore({ path: "/doc.md", fileName: "doc.md" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export", { format: "pdf", outputPath: "/tmp/out.pdf" });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_export_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({
      format: "pdf",
      ok: true,
      path: "/tmp/out.pdf",
      error: null,
    });
  });

  // ── DOCX ─────────────────────────────────────────────────────────────────

  it("calls exportDocx with the document title when format=docx and outputPath is set", async () => {
    resetDocumentStore({ path: "/notes/spec.md", fileName: "spec.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "docx", outputPath: "/tmp/spec.docx" });
    expect(exportDocxMock).toHaveBeenCalledWith("spec");
    expect(exportPdfMock).not.toHaveBeenCalled();
    expect(exportHtmlMock).not.toHaveBeenCalled();
  });

  it("calls mcp_export_result with ok=true after successful docx export", async () => {
    resetDocumentStore({ path: "/doc.md", fileName: "doc.md" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export", { format: "docx", outputPath: "/tmp/doc.docx" });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_export_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({
      format: "docx",
      ok: true,
      path: "/tmp/doc.docx",
      error: null,
    });
  });

  // ── HTML ─────────────────────────────────────────────────────────────────

  it("calls exportHtml with the document title when format=html and outputPath is set", async () => {
    resetDocumentStore({ path: "/notes/index.md", fileName: "index.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "html", outputPath: "/tmp/index.html" });
    expect(exportHtmlMock).toHaveBeenCalledWith("index");
    expect(exportPdfMock).not.toHaveBeenCalled();
    expect(exportDocxMock).not.toHaveBeenCalled();
  });

  it("calls mcp_export_result with ok=true after successful html export", async () => {
    resetDocumentStore({ path: "/doc.md", fileName: "doc.md" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export", { format: "html", outputPath: "/tmp/doc.html" });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_export_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({
      format: "html",
      ok: true,
      path: "/tmp/doc.html",
      error: null,
    });
  });

  // ── Title derivation ──────────────────────────────────────────────────────

  it("strips the .md extension when deriving the title for the export call", async () => {
    resetDocumentStore({ path: "/docs/readme.md", fileName: "readme.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "html", outputPath: "/tmp/readme.html" });
    expect(exportHtmlMock).toHaveBeenCalledWith("readme");
  });

  it("strips .markdown extension when deriving the title", async () => {
    resetDocumentStore({ path: "/docs/notes.markdown", fileName: "notes.markdown" });
    mountBridge();
    await fireEvent("mcp://export", { format: "html", outputPath: "/tmp/notes.html" });
    expect(exportHtmlMock).toHaveBeenCalledWith("notes");
  });

  it("falls back to 'export' when fileName is empty", async () => {
    resetDocumentStore({ path: "/doc.md", fileName: "" });
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf", outputPath: "/tmp/out.pdf" });
    expect(exportPdfMock).toHaveBeenCalledWith("export");
  });

  // ── Does NOT open dialog when outputPath is provided ─────────────────────

  it("does NOT open the export dialog when outputPath is provided", async () => {
    resetDocumentStore({ path: "/doc.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf", outputPath: "/tmp/out.pdf" });
    expect(useUiStore.getState().exportOpen).toBe(false);
  });

  // ── Error path ────────────────────────────────────────────────────────────

  it("calls mcp_export_result with ok=false when exportPdf throws", async () => {
    exportPdfMock.mockRejectedValue(new Error("print dialog closed"));
    resetDocumentStore({ path: "/doc.md", fileName: "doc.md" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export", { format: "pdf", outputPath: "/tmp/out.pdf" });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_export_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ format: "pdf", ok: false });
    expect(typeof resultCall![1].error).toBe("string");
    expect((resultCall![1].error as string).length).toBeGreaterThan(0);
  });

  it("calls mcp_export_result with ok=false when exportDocx throws", async () => {
    exportDocxMock.mockRejectedValue(new Error("html-to-docx failed"));
    resetDocumentStore({ path: "/doc.md", fileName: "doc.md" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export", { format: "docx", outputPath: "/tmp/doc.docx" });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_export_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ format: "docx", ok: false });
    expect(resultCall![1].error).toContain("html-to-docx failed");
  });

  it("calls mcp_export_result with ok=false when exportHtml throws", async () => {
    exportHtmlMock.mockRejectedValue(new Error("disk write error"));
    resetDocumentStore({ path: "/doc.md", fileName: "doc.md" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export", { format: "html", outputPath: "/tmp/doc.html" });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_export_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ format: "html", ok: false });
    expect(resultCall![1].error).toContain("disk write error");
  });

  it("shows an error toast when export fails", async () => {
    exportPdfMock.mockRejectedValue(new Error("print failed"));
    resetDocumentStore({ path: "/doc.md", fileName: "doc.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf", outputPath: "/tmp/out.pdf" });
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringMatching(/print failed/i),
    );
  });

  it("always calls mcp_export_result even on export error (prevents Rust timeout)", async () => {
    exportHtmlMock.mockRejectedValue("Something went wrong");
    resetDocumentStore({ path: "/doc.md", fileName: "doc.md" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export", { format: "html", outputPath: "/tmp/out.html" });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_export_result");
    expect(resultCall).toBeDefined();
  });

  // ── No-document guard with outputPath ────────────────────────────────────

  it("calls mcp_export_result with ok=false and error when no doc is open (outputPath set)", async () => {
    resetDocumentStore({ path: null });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export", { format: "pdf", outputPath: "/tmp/out.pdf" });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_export_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ ok: false });
    expect(typeof resultCall![1].error).toBe("string");
  });

  it("does NOT call any export function when no doc is open (outputPath set)", async () => {
    resetDocumentStore({ path: null });
    mountBridge();
    await fireEvent("mcp://export", { format: "html", outputPath: "/tmp/out.html" });
    expect(exportHtmlMock).not.toHaveBeenCalled();
    expect(exportPdfMock).not.toHaveBeenCalled();
    expect(exportDocxMock).not.toHaveBeenCalled();
  });

  it("shows an info toast (not error) when no doc is open and outputPath is set", async () => {
    resetDocumentStore({ path: null });
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf", outputPath: "/tmp/out.pdf" });
    expect(toastInfoMock).toHaveBeenCalledWith(
      expect.stringMatching(/open a document/i),
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://export-markdown-archive — archive export event
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://export-markdown-archive event", () => {
  it("registers listener for mcp://export-markdown-archive on mount", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://export-markdown-archive")).toBe(true);
  });

  it("calls exportMarkdownArchive with outputPath and includeAssets", async () => {
    mountBridge();
    await fireEvent("mcp://export-markdown-archive", {
      outputPath: "/out/archive.tar.gz",
      includeAssets: true,
    });
    expect(exportMarkdownArchiveMock).toHaveBeenCalledWith({
      outputPath: "/out/archive.tar.gz",
      includeAssets: true,
    });
  });

  it("defaults includeAssets to true when omitted from payload", async () => {
    mountBridge();
    await fireEvent("mcp://export-markdown-archive", {
      outputPath: "/out/archive.tar.gz",
    });
    expect(exportMarkdownArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({ includeAssets: true }),
    );
  });

  it("calls mcp_archive_result with ok=true on success when outputPath is set", async () => {
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export-markdown-archive", {
      outputPath: "/out/archive.tar.gz",
      includeAssets: true,
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_archive_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ ok: true });
  });

  it("does NOT call mcp_archive_result when no outputPath (dialog path)", async () => {
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export-markdown-archive", { outputPath: null });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_archive_result");
    expect(resultCall).toBeUndefined();
  });

  it("calls mcp_archive_result with ok=false when exportMarkdownArchive throws", async () => {
    exportMarkdownArchiveMock.mockRejectedValue(new Error("pack failed"));
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export-markdown-archive", {
      outputPath: "/out/archive.tar.gz",
      includeAssets: false,
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_archive_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ ok: false });
    expect(typeof resultCall![1].error).toBe("string");
  });

  it("passes includeAssets=false through to exportMarkdownArchive", async () => {
    mountBridge();
    await fireEvent("mcp://export-markdown-archive", {
      outputPath: "/out/slim.tar.gz",
      includeAssets: false,
    });
    expect(exportMarkdownArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({ includeAssets: false }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://export-canvas-graph — canvas graph export event
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://export-canvas-graph event", () => {
  it("registers listener for mcp://export-canvas-graph on mount", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://export-canvas-graph")).toBe(true);
  });

  it("calls exportCanvasGraph with outputPath and includeIsolated", async () => {
    mountBridge();
    await fireEvent("mcp://export-canvas-graph", {
      outputPath: "/out/vault.canvas",
      includeIsolated: true,
    });
    expect(exportCanvasGraphMock).toHaveBeenCalledWith({
      outputPath: "/out/vault.canvas",
      includeIsolated: true,
    });
  });

  it("defaults includeIsolated to true when omitted from payload", async () => {
    mountBridge();
    await fireEvent("mcp://export-canvas-graph", {
      outputPath: "/out/vault.canvas",
    });
    expect(exportCanvasGraphMock).toHaveBeenCalledWith(
      expect.objectContaining({ includeIsolated: true }),
    );
  });

  it("calls mcp_canvas_result with ok=true on success when outputPath is set", async () => {
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export-canvas-graph", {
      outputPath: "/out/vault.canvas",
      includeIsolated: true,
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_canvas_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ ok: true });
  });

  it("does NOT call mcp_canvas_result when no outputPath (dialog path)", async () => {
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export-canvas-graph", { outputPath: null });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_canvas_result");
    expect(resultCall).toBeUndefined();
  });

  it("calls mcp_canvas_result with ok=false when exportCanvasGraph throws", async () => {
    exportCanvasGraphMock.mockRejectedValue(new Error("graph build failed"));
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export-canvas-graph", {
      outputPath: "/out/vault.canvas",
      includeIsolated: false,
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_canvas_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ ok: false });
    expect(typeof resultCall![1].error).toBe("string");
  });

  it("passes includeIsolated=false through to exportCanvasGraph", async () => {
    mountBridge();
    await fireEvent("mcp://export-canvas-graph", {
      outputPath: "/out/connected.canvas",
      includeIsolated: false,
    });
    expect(exportCanvasGraphMock).toHaveBeenCalledWith(
      expect.objectContaining({ includeIsolated: false }),
    );
  });

  it("error message from thrown string is passed to mcp_canvas_result", async () => {
    exportCanvasGraphMock.mockRejectedValue("vault is empty");
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://export-canvas-graph", {
      outputPath: "/out/vault.canvas",
      includeIsolated: true,
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_canvas_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].error).toContain("vault is empty");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://batch-read — multi-file read
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://batch-read event", () => {
  it("registers listener for mcp://batch-read on mount", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://batch-read")).toBe(true);
  });

  it("invokes read_batch_files with the provided paths", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.resolve([]);
      if (cmd === "read_markdown_file") return Promise.resolve({ path: "/opened.md", file_name: "opened.md", content: "# Opened", size: 8 });
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://batch-read", {
      batchId: "br-001",
      paths: ["/vault/a.md", "/vault/b.md"],
    });
    const readCall = invokeMock.mock.calls.find((c) => c[0] === "read_batch_files");
    expect(readCall).toBeDefined();
    expect(readCall![1]).toMatchObject({ paths: ["/vault/a.md", "/vault/b.md"] });
  });

  it("calls mcp_batch_read_result with ok=true on success", async () => {
    const fakeResults = [
      { path: "/vault/a.md", ok: true, content: "# A", headers: {}, metadata: { sizeBytes: 3, mtimeMs: 1000 } },
      { path: "/vault/b.md", ok: true, content: "# B", headers: {}, metadata: { sizeBytes: 3, mtimeMs: 2000 } },
    ];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.resolve(fakeResults);
      if (cmd === "read_markdown_file") return Promise.resolve({ path: "/opened.md", file_name: "opened.md", content: "# Opened", size: 8 });
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.resolve(fakeResults);
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://batch-read", { batchId: "br-002", paths: ["/vault/a.md", "/vault/b.md"] });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_batch_read_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ batchId: "br-002", ok: true });
    expect(resultCall![1].results).toHaveLength(2);
  });

  it("returns per-file results including content, headers, and metadata", async () => {
    const fakeResults = [
      {
        path: "/vault/notes.md",
        ok: true,
        content: "---\ntitle: Notes\n---\n# Notes",
        headers: { title: "Notes" },
        metadata: { sizeBytes: 28, mtimeMs: 5000 },
      },
    ];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.resolve(fakeResults);
      if (cmd === "read_markdown_file") return Promise.resolve({ path: "/opened.md", file_name: "opened.md", content: "# Opened", size: 8 });
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.resolve(fakeResults);
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://batch-read", { batchId: "br-003", paths: ["/vault/notes.md"] });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_batch_read_result");
    expect(resultCall).toBeDefined();
    const file = resultCall![1].results[0];
    expect(file.content).toBe("---\ntitle: Notes\n---\n# Notes");
    expect(file.headers).toMatchObject({ title: "Notes" });
    expect(file.metadata).toMatchObject({ sizeBytes: 28 });
  });

  it("calls mcp_batch_read_result with ok=false when read_batch_files throws", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.reject(new Error("permission denied"));
      if (cmd === "read_markdown_file") return Promise.resolve({ path: "/opened.md", file_name: "opened.md", content: "# Opened", size: 8 });
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.reject(new Error("permission denied"));
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://batch-read", { batchId: "br-004", paths: ["/vault/secret.md"] });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_batch_read_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ batchId: "br-004", ok: false });
    expect(resultCall![1].results).toHaveLength(0);
    expect(typeof resultCall![1].error).toBe("string");
  });

  it("always calls mcp_batch_read_result even on error (prevents Rust timeout)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.reject("IPC error");
      if (cmd === "read_markdown_file") return Promise.resolve({ path: "/opened.md", file_name: "opened.md", content: "#", size: 1 });
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.reject("IPC error");
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://batch-read", { batchId: "br-005", paths: [] });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_batch_read_result");
    expect(resultCall).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://batch-edit — multi-file find/replace
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://batch-edit event", () => {
  it("registers listener for mcp://batch-edit on mount", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://batch-edit")).toBe(true);
  });

  it("applies live edit against the open document without invoking apply_batch_edit", async () => {
    resetDocumentStore({ path: "/vault/open.md", content: "Hello world" });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await fireEvent("mcp://batch-edit", {
      batchId: "be-001",
      ops: [{ path: "/vault/open.md", find: "Hello world", replace: "Hello there" }],
    });
    expect(useDocumentStore.getState().content).toBe("Hello there");
    const diskCall = invokeMock.mock.calls.find((c) => c[0] === "apply_batch_edit");
    expect(diskCall).toBeUndefined();
  });

  it("forwards non-open file ops to apply_batch_edit", async () => {
    resetDocumentStore({ path: "/vault/open.md", content: "current doc" });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "apply_batch_edit") return Promise.resolve([{ path: "/vault/other.md", ok: true, replaced: 1 }]);
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "apply_batch_edit") return Promise.resolve([{ path: "/vault/other.md", ok: true, replaced: 1 }]);
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://batch-edit", {
      batchId: "be-002",
      ops: [{ path: "/vault/other.md", find: "old text", replace: "new text" }],
    });
    const diskCall = invokeMock.mock.calls.find((c) => c[0] === "apply_batch_edit");
    expect(diskCall).toBeDefined();
    expect(diskCall![1].ops[0].path).toBe("/vault/other.md");
  });

  it("calls mcp_batch_edit_result with ok=true when all ops succeed", async () => {
    resetDocumentStore({ path: "/vault/open.md", content: "unique phrase" });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await fireEvent("mcp://batch-edit", {
      batchId: "be-003",
      ops: [{ path: "/vault/open.md", find: "unique phrase", replace: "replaced" }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_batch_edit_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ batchId: "be-003", ok: true });
  });

  it("calls mcp_batch_edit_result with ok=false when a live edit fails (find not found)", async () => {
    resetDocumentStore({ path: "/vault/open.md", content: "some content" });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await fireEvent("mcp://batch-edit", {
      batchId: "be-004",
      ops: [{ path: "/vault/open.md", find: "not present", replace: "x" }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_batch_edit_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
    const failedOp = resultCall![1].results.find((r: { path: string }) => r.path === "/vault/open.md");
    expect(failedOp.ok).toBe(false);
    expect(typeof failedOp.error).toBe("string");
  });

  it("reports partial failure: one live op fails, result reflects per-op status", async () => {
    resetDocumentStore({ path: "/vault/open.md", content: "only once here" });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "apply_batch_edit") return Promise.resolve([{ path: "/vault/other.md", ok: true, replaced: 1 }]);
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://batch-edit", {
      batchId: "be-005",
      ops: [
        { path: "/vault/open.md", find: "not present", replace: "x" },
        { path: "/vault/other.md", find: "anything", replace: "y" },
      ],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_batch_edit_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
    expect(resultCall![1].results).toHaveLength(2);
  });

  it("always calls mcp_batch_edit_result even when apply_batch_edit throws (prevents Rust timeout)", async () => {
    resetDocumentStore({ path: "/vault/open.md", content: "doc" });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "apply_batch_edit") return Promise.reject(new Error("disk locked"));
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "apply_batch_edit") return Promise.reject(new Error("disk locked"));
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://batch-edit", {
      batchId: "be-006",
      ops: [{ path: "/vault/locked.md", find: "a", replace: "b" }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_batch_edit_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
  });

  it("does not mutate live document when live edit find is ambiguous", async () => {
    resetDocumentStore({ path: "/vault/open.md", content: "the cat and the dog" });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await fireEvent("mcp://batch-edit", {
      batchId: "be-007",
      ops: [{ path: "/vault/open.md", find: "the", replace: "a" }],
    });
    expect(useDocumentStore.getState().content).toBe("the cat and the dog");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://semantic-search — embeddings + BM25 vault search
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://semantic-search event", () => {
  it("registers listener for mcp://semantic-search on mount", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://semantic-search")).toBe(true);
  });

  it("falls back to keyword search when no embedding model is available", async () => {
    embedAvailableMock.mockResolvedValue(null);
    searchFilesMock.mockResolvedValue([
      { path: "/vault/a.md", fileName: "a.md", matches: [{ lineNo: 1, snippet: "result line" }] },
    ]);
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://semantic-search", { searchId: "ss-001", query: "test query" });
    expect(searchFilesMock).toHaveBeenCalled();
    expect(embedSearchMock).not.toHaveBeenCalled();
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_semantic_search_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ searchId: "ss-001", ok: true, usedEmbeddings: false });
    expect(resultCall![1].results.length).toBeGreaterThan(0);
  });

  it("uses embed_search when an embedding model is available", async () => {
    embedAvailableMock.mockResolvedValue("nomic-embed-text");
    embedSearchMock.mockResolvedValue([
      { path: "/vault/a.md", fileName: "a.md", snippet: "semantic hit", score: 0.9 },
    ]);
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://semantic-search", { searchId: "ss-002", query: "semantic query", rerank: false });
    expect(embedSearchMock).toHaveBeenCalled();
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_semantic_search_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ searchId: "ss-002", ok: true, usedEmbeddings: true });
  });

  it("applies RRF reranking when rerank=true and embedding model is available", async () => {
    embedAvailableMock.mockResolvedValue("nomic-embed-text");
    embedSearchMock.mockResolvedValue([
      { path: "/vault/a.md", fileName: "a.md", snippet: "semantic A", score: 0.95 },
      { path: "/vault/b.md", fileName: "b.md", snippet: "semantic B", score: 0.7 },
    ]);
    searchFilesMock.mockResolvedValue([
      { path: "/vault/b.md", fileName: "b.md", matches: [{ lineNo: 1, snippet: "keyword B" }] },
      { path: "/vault/c.md", fileName: "c.md", matches: [{ lineNo: 2, snippet: "keyword C" }] },
    ]);
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://semantic-search", { searchId: "ss-003", query: "reranked", rerank: true });
    expect(embedSearchMock).toHaveBeenCalled();
    expect(searchFilesMock).toHaveBeenCalled();
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_semantic_search_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(true);
    // /vault/b.md appears in both lists — should rank higher after RRF fusion.
    const paths = resultCall![1].results.map((r: { path: string }) => r.path);
    expect(paths).toContain("/vault/b.md");
    // /vault/c.md (keyword only) should also appear in merged results.
    expect(paths).toContain("/vault/c.md");
  });

  it("trims results to k when more are available", async () => {
    embedAvailableMock.mockResolvedValue(null);
    searchFilesMock.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({
        path: `/vault/doc${i}.md`,
        fileName: `doc${i}.md`,
        matches: [{ lineNo: 1, snippet: `snippet ${i}` }],
      })),
    );
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://semantic-search", { searchId: "ss-004", query: "many results", k: 5 });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_semantic_search_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].results).toHaveLength(5);
  });

  it("calls mcp_semantic_search_result with ok=false when embedSearch throws", async () => {
    embedAvailableMock.mockResolvedValue("nomic-embed-text");
    embedSearchMock.mockRejectedValue(new Error("embed model crashed"));
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://semantic-search", { searchId: "ss-005", query: "crash test" });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_semantic_search_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ searchId: "ss-005", ok: false });
    expect(typeof resultCall![1].error).toBe("string");
  });

  it("always calls mcp_semantic_search_result (prevents Rust timeout)", async () => {
    embedAvailableMock.mockRejectedValue(new Error("availability check failed"));
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://semantic-search", { searchId: "ss-006", query: "timeout test" });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_semantic_search_result");
    expect(resultCall).toBeDefined();
  });

  it("skips BM25 reranking when rerank=false even with model available", async () => {
    embedAvailableMock.mockResolvedValue("nomic-embed-text");
    embedSearchMock.mockResolvedValue([
      { path: "/vault/a.md", fileName: "a.md", snippet: "hit", score: 0.9 },
    ]);
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://semantic-search", { searchId: "ss-007", query: "no rerank", rerank: false });
    expect(searchFilesMock).not.toHaveBeenCalled();
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_semantic_search_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(true);
  });

  it("returns empty results array (not undefined) when vault has no files", async () => {
    embedAvailableMock.mockResolvedValue(null);
    searchFilesMock.mockResolvedValue([]);
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://semantic-search", { searchId: "ss-008", query: "empty vault" });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_semantic_search_result");
    expect(resultCall).toBeDefined();
    expect(Array.isArray(resultCall![1].results)).toBe(true);
    expect(resultCall![1].results).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://batch-export — concurrent multi-document export
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://batch-export event", () => {
  it("registers listener for mcp://batch-export on mount", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://batch-export")).toBe(true);
  });

  it("calls mcp_batch_export_result with ok=true when all exports succeed", async () => {
    resetDocumentStore({ path: "/vault/a.md", fileName: "a.md" });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await fireEvent("mcp://batch-export", {
      batchId: "be-001",
      exports: [
        { path: "/vault/a.md", format: "pdf" },
        { path: "/vault/b.md", format: "html" },
      ],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_batch_export_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ batchId: "be-001", ok: true });
    expect(resultCall![1].results).toHaveLength(2);
  });

  it("runs all exports concurrently (both export functions invoked)", async () => {
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await fireEvent("mcp://batch-export", {
      batchId: "be-002",
      exports: [
        { path: "/vault/a.md", format: "pdf" },
        { path: "/vault/b.md", format: "docx" },
        { path: "/vault/c.md", format: "html" },
      ],
    });
    expect(exportPdfMock).toHaveBeenCalledTimes(1);
    expect(exportDocxMock).toHaveBeenCalledTimes(1);
    expect(exportHtmlMock).toHaveBeenCalledTimes(1);
  });

  it("returns per-file ok=true results including derived outputPath", async () => {
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await fireEvent("mcp://batch-export", {
      batchId: "be-003",
      exports: [{ path: "/vault/notes.md", format: "pdf", outputDir: "/out" }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_batch_export_result");
    expect(resultCall).toBeDefined();
    const file = resultCall![1].results[0];
    expect(file.ok).toBe(true);
    expect(file.outputPath).toContain("notes");
    expect(file.outputPath).toContain(".pdf");
  });

  it("reports per-file ok=false when one export throws, overall ok=false", async () => {
    exportPdfMock.mockRejectedValue(new Error("pdf crashed"));
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await fireEvent("mcp://batch-export", {
      batchId: "be-004",
      exports: [
        { path: "/vault/fail.md", format: "pdf" },
        { path: "/vault/ok.md", format: "html" },
      ],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_batch_export_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
    const failedFile = resultCall![1].results.find(
      (r: { path: string }) => r.path === "/vault/fail.md"
    );
    expect(failedFile.ok).toBe(false);
    expect(typeof failedFile.error).toBe("string");
    const okFile = resultCall![1].results.find(
      (r: { path: string }) => r.path === "/vault/ok.md"
    );
    expect(okFile.ok).toBe(true);
  });

  it("always calls mcp_batch_export_result even on total failure (prevents Rust timeout)", async () => {
    exportPdfMock.mockRejectedValue(new Error("crash"));
    exportDocxMock.mockRejectedValue(new Error("crash"));
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await fireEvent("mcp://batch-export", {
      batchId: "be-005",
      exports: [
        { path: "/vault/a.md", format: "pdf" },
        { path: "/vault/b.md", format: "docx" },
      ],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_batch_export_result");
    expect(resultCall).toBeDefined();
  });

  it("returns ok=false with error when exports array is empty", async () => {
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await fireEvent("mcp://batch-export", {
      batchId: "be-006",
      exports: [],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_batch_export_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ batchId: "be-006", ok: false });
    expect(typeof resultCall![1].error).toBe("string");
    expect(resultCall![1].results).toHaveLength(0);
  });

  it("strips markdown extension from filename when deriving export title", async () => {
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await fireEvent("mcp://batch-export", {
      batchId: "be-007",
      exports: [{ path: "/vault/my-plan.md", format: "pdf" }],
    });
    expect(exportPdfMock).toHaveBeenCalledWith("my-plan");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://diff-docs — unified diff between two documents
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://diff-docs event", () => {
  it("registers listener for mcp://diff-docs on mount", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://diff-docs")).toBe(true);
  });

  it("invokes mcp_diff_docs with pathA, pathB, and contextLines", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_diff_docs") {
        return Promise.resolve({
          diff: "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-old\n+new",
          hunks: 1,
          added: 1,
          removed: 1,
          path_a: "/vault/a.md",
          path_b: "/vault/b.md",
        });
      }
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_diff_docs") {
        return Promise.resolve({
          diff: "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-old\n+new",
          hunks: 1,
          added: 1,
          removed: 1,
          path_a: "/vault/a.md",
          path_b: "/vault/b.md",
        });
      }
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://diff-docs", {
      diffId: "dd-001",
      pathA: "/vault/a.md",
      pathB: "/vault/b.md",
      contextLines: 3,
    });
    const diffCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_diff_docs");
    expect(diffCall).toBeDefined();
    expect(diffCall![1]).toMatchObject({
      pathA: "/vault/a.md",
      pathB: "/vault/b.md",
      contextLines: 3,
    });
  });

  it("calls mcp_diff_docs_result with ok=true and diff data on success", async () => {
    const fakeDiff = "--- a\n+++ b\n@@ -1,2 +1,2 @@\n-hello\n+world";
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_diff_docs") {
        return Promise.resolve({
          diff: fakeDiff,
          hunks: 1,
          added: 1,
          removed: 1,
          path_a: "/vault/a.md",
          path_b: "/vault/b.md",
        });
      }
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_diff_docs") {
        return Promise.resolve({
          diff: fakeDiff,
          hunks: 1,
          added: 1,
          removed: 1,
          path_a: "/vault/a.md",
          path_b: "/vault/b.md",
        });
      }
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://diff-docs", {
      diffId: "dd-002",
      pathA: "/vault/a.md",
      pathB: "/vault/b.md",
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_diff_docs_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({
      diffId: "dd-002",
      ok: true,
      diff: fakeDiff,
      hunks: 1,
      added: 1,
      removed: 1,
    });
  });

  it("defaults contextLines to 3 when omitted from payload", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_diff_docs") {
        return Promise.resolve({ diff: "", hunks: 0, added: 0, removed: 0, path_a: "/a.md", path_b: "/b.md" });
      }
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_diff_docs") {
        return Promise.resolve({ diff: "", hunks: 0, added: 0, removed: 0, path_a: "/a.md", path_b: "/b.md" });
      }
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://diff-docs", {
      diffId: "dd-003",
      pathA: "/vault/a.md",
      pathB: "/vault/b.md",
    });
    const diffCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_diff_docs");
    expect(diffCall).toBeDefined();
    expect(diffCall![1].contextLines).toBe(3);
  });

  it("calls mcp_diff_docs_result with ok=false when mcp_diff_docs throws", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_diff_docs") {
        return Promise.reject(new Error("file not found"));
      }
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_diff_docs") {
        return Promise.reject(new Error("file not found"));
      }
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://diff-docs", {
      diffId: "dd-004",
      pathA: "/vault/missing.md",
      pathB: "/vault/b.md",
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_diff_docs_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ diffId: "dd-004", ok: false });
    expect(typeof resultCall![1].error).toBe("string");
    expect(resultCall![1].error).toContain("file not found");
  });

  it("always calls mcp_diff_docs_result even on error (prevents Rust timeout)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_diff_docs") return Promise.reject("IPC crashed");
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_diff_docs") return Promise.reject("IPC crashed");
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://diff-docs", {
      diffId: "dd-005",
      pathA: "/vault/a.md",
      pathB: "/vault/b.md",
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_diff_docs_result");
    expect(resultCall).toBeDefined();
  });

  it("returns empty diff string (not undefined) when documents are identical", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_diff_docs") {
        return Promise.resolve({ diff: "", hunks: 0, added: 0, removed: 0, path_a: "/a.md", path_b: "/b.md" });
      }
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_diff_docs") {
        return Promise.resolve({ diff: "", hunks: 0, added: 0, removed: 0, path_a: "/a.md", path_b: "/b.md" });
      }
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://diff-docs", {
      diffId: "dd-006",
      pathA: "/vault/a.md",
      pathB: "/vault/a.md",
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_diff_docs_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(true);
    expect(resultCall![1].diff).toBe("");
    expect(resultCall![1].hunks).toBe(0);
    expect(resultCall![1].added).toBe(0);
    expect(resultCall![1].removed).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://apply-diff-hunk — programmatic diff hunk application
// ════════════════════════════════════════════════════════════════════════════

const SIMPLE_DIFF = `--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 ctx
-old line
+new line
 ctx
`;

describe("mcp://apply-diff-hunk event", () => {
  beforeEach(() => {
    buildHunkOpMock.mockReset();
  });

  it("registers listener for mcp://apply-diff-hunk on mount", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://apply-diff-hunk")).toBe(true);
  });

  it("calls mcp_apply_diff_hunk_result with ok=true when op is applied", async () => {
    // Spy on applyOp to avoid needing a perfectly-covering OT op fixture.
    const applyOpSpy = vi.spyOn(useDocumentStore.getState(), "applyOp").mockReturnValue(true);
    const fakeOp = {
      id: "mcp-agent:1",
      agentId: "mcp-agent",
      seq: 1,
      clock: {},
      components: [{ type: "retain", count: 4 }, { type: "delete", count: 8 }, { type: "insert", text: "new line" }, { type: "retain", count: 4 }],
    };
    buildHunkOpMock.mockReturnValue(fakeOp);
    resetDocumentStore({ content: "ctx\nold line\nctx", path: "/doc.md" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://apply-diff-hunk", {
      diffId: "dh-001",
      diffText: SIMPLE_DIFF,
      hunkIndex: 0,
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_apply_diff_hunk_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ diffId: "dh-001", ok: true, hunkIndex: 0, error: null });
    applyOpSpy.mockRestore();
  });

  it("calls mcp_apply_diff_hunk_result with ok=false for out-of-bounds hunkIndex", async () => {
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://apply-diff-hunk", {
      diffId: "dh-002",
      diffText: SIMPLE_DIFF,
      hunkIndex: 99,
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_apply_diff_hunk_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ diffId: "dh-002", ok: false, hunkIndex: 99 });
    expect(typeof resultCall![1].error).toBe("string");
    expect((resultCall![1].error as string)).toMatch(/out of bounds/i);
  });

  it("calls mcp_apply_diff_hunk_result with ok=false when buildHunkOp returns null (anchor not found)", async () => {
    buildHunkOpMock.mockReturnValue(null);
    resetDocumentStore({ content: "completely different content", path: "/doc.md" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://apply-diff-hunk", {
      diffId: "dh-003",
      diffText: SIMPLE_DIFF,
      hunkIndex: 0,
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_apply_diff_hunk_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ diffId: "dh-003", ok: false });
    expect(typeof resultCall![1].error).toBe("string");
  });

  it("always calls mcp_apply_diff_hunk_result even when diff text has no hunks", async () => {
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://apply-diff-hunk", {
      diffId: "dh-004",
      diffText: "not a diff at all",
      hunkIndex: 0,
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_apply_diff_hunk_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
  });

  it("calls syncNow (mcp_sync_state) after a successful apply", async () => {
    // Spy on the real store's applyOp so we can force it to return true without
    // needing a perfectly-covering OT op in the test fixture.
    const applyOpSpy = vi.spyOn(useDocumentStore.getState(), "applyOp").mockReturnValue(true);
    const content = "ctx\nold line\nctx";
    // Build a fake op whose retain + delete covers content.length exactly.
    const fakeOp = {
      id: "mcp-agent:1",
      agentId: "mcp-agent",
      seq: 1,
      clock: {},
      components: [
        { type: "retain", count: 4 },
        { type: "delete", count: 8 },
        { type: "insert", text: "new line" },
        { type: "retain", count: content.length - 12 },
      ],
    };
    buildHunkOpMock.mockReturnValue(fakeOp);
    resetDocumentStore({ content, path: "/doc.md" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://apply-diff-hunk", {
      diffId: "dh-005",
      diffText: SIMPLE_DIFF,
      hunkIndex: 0,
    });
    const syncCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_sync_state");
    expect(syncCall).toBeDefined();
    applyOpSpy.mockRestore();
  });

  it("negative hunkIndex returns out-of-bounds error", async () => {
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://apply-diff-hunk", {
      diffId: "dh-006",
      diffText: SIMPLE_DIFF,
      hunkIndex: -1,
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_apply_diff_hunk_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
    expect((resultCall![1].error as string)).toMatch(/out of bounds/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://atomic-edits — coordinated multi-file edits in a single transaction
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://atomic-edits event", () => {
  // ── Helper to set up invoke mock with read_batch_files + apply_atomic_batch ──
  function setupAtomicInvoke(
    diskContents: Record<string, string> = {},
    writeFailPath?: string,
  ) {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "read_batch_files") {
        const paths = (args?.paths as string[]) ?? [];
        return Promise.resolve(
          paths.map((p) => ({
            path: p,
            ok: p in diskContents,
            content: diskContents[p] ?? undefined,
            error: p in diskContents ? undefined : `File not found: ${p}`,
          })),
        );
      }
      if (cmd === "apply_atomic_batch") {
        const entries = (args?.entries as Array<{ path: string; content: string }>) ?? [];
        return Promise.resolve(
          entries.map((e) => ({
            path: e.path,
            ok: e.path !== writeFailPath,
            error: e.path === writeFailPath ? "Disk write failed" : null,
          })),
        );
      }
      if (cmd === "read_markdown_file") {
        return Promise.resolve({ path: "/opened.md", file_name: "opened.md", content: "# Opened", size: 8 });
      }
      return Promise.resolve(undefined);
    });
  }

  beforeEach(() => {
    invokeMock.mockClear();
  });

  // ── Registration ──────────────────────────────────────────────────────────

  it("registers listener for mcp://atomic-edits on mount", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://atomic-edits")).toBe(true);
  });

  // ── Happy path: disk-only files ───────────────────────────────────────────

  it("applies edits to two disk files and invokes apply_atomic_batch", async () => {
    setupAtomicInvoke({
      "/vault/a.md": "Hello world",
      "/vault/b.md": "Goodbye world",
    });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({
      "/vault/a.md": "Hello world",
      "/vault/b.md": "Goodbye world",
    });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-001",
      entries: [
        { path: "/vault/a.md", find: "Hello world", replace: "Hello there" },
        { path: "/vault/b.md", find: "Goodbye world", replace: "Goodbye there" },
      ],
    });
    const batchCall = invokeMock.mock.calls.find((c) => c[0] === "apply_atomic_batch");
    expect(batchCall).toBeDefined();
    expect(batchCall![1].entries).toHaveLength(2);
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1]).toMatchObject({ atomicId: "ae-001", ok: true });
  });

  it("returns per-file results with ok=true for each entry on success", async () => {
    setupAtomicInvoke({ "/vault/a.md": "unique text here" });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/a.md": "unique text here" });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-002",
      entries: [{ path: "/vault/a.md", find: "unique text here", replace: "replaced" }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].results[0]).toMatchObject({ path: "/vault/a.md", ok: true, replaced: 1 });
  });

  it("passes the correct new content to apply_atomic_batch", async () => {
    setupAtomicInvoke({ "/vault/a.md": "original content" });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/a.md": "original content" });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-003",
      entries: [{ path: "/vault/a.md", find: "original content", replace: "updated content" }],
    });
    const batchCall = invokeMock.mock.calls.find((c) => c[0] === "apply_atomic_batch");
    expect(batchCall).toBeDefined();
    const entry = batchCall![1].entries.find((e: { path: string }) => e.path === "/vault/a.md");
    expect(entry?.content).toBe("updated content");
  });

  // ── Happy path: live document ─────────────────────────────────────────────

  it("applies edit to the live (open) document without invoking apply_atomic_batch for it", async () => {
    resetDocumentStore({ path: "/vault/open.md", content: "live content here" });
    setupAtomicInvoke({});
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({});
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-004",
      entries: [{ path: "/vault/open.md", find: "live content here", replace: "updated live" }],
    });
    expect(useDocumentStore.getState().content).toBe("updated live");
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(true);
    // apply_atomic_batch should NOT be called for the live doc (no disk entries).
    const batchCall = invokeMock.mock.calls.find((c) => c[0] === "apply_atomic_batch");
    expect(batchCall).toBeUndefined();
  });

  it("updates live document content after successful edit", async () => {
    resetDocumentStore({ path: "/vault/open.md", content: "# Title\n\nOld paragraph." });
    setupAtomicInvoke({});
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({});
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-005",
      entries: [{ path: "/vault/open.md", find: "Old paragraph.", replace: "New paragraph." }],
    });
    expect(useDocumentStore.getState().content).toBe("# Title\n\nNew paragraph.");
  });

  it("mixes live doc and disk edits in one transaction", async () => {
    resetDocumentStore({ path: "/vault/open.md", content: "live doc" });
    setupAtomicInvoke({ "/vault/disk.md": "disk doc" });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/disk.md": "disk doc" });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-006",
      entries: [
        { path: "/vault/open.md", find: "live doc", replace: "live updated" },
        { path: "/vault/disk.md", find: "disk doc", replace: "disk updated" },
      ],
    });
    expect(useDocumentStore.getState().content).toBe("live updated");
    const batchCall = invokeMock.mock.calls.find((c) => c[0] === "apply_atomic_batch");
    expect(batchCall).toBeDefined();
    expect(batchCall![1].entries[0]).toMatchObject({ path: "/vault/disk.md", content: "disk updated" });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall![1].ok).toBe(true);
  });

  it("triggers mcp_sync_state after updating the live document", async () => {
    resetDocumentStore({ path: "/vault/open.md", content: "sync test" });
    setupAtomicInvoke({});
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({});
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-007",
      entries: [{ path: "/vault/open.md", find: "sync test", replace: "synced" }],
    });
    const syncCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_sync_state");
    expect(syncCall).toBeDefined();
  });

  // ── Conflict detection: duplicate paths ──────────────────────────────────

  it("returns ok=false when the same path appears twice in entries", async () => {
    setupAtomicInvoke({ "/vault/a.md": "some content" });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/a.md": "some content" });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-dup-001",
      entries: [
        { path: "/vault/a.md", find: "some", replace: "any" },
        { path: "/vault/a.md", find: "content", replace: "text" },
      ],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
    expect(typeof resultCall![1].error).toBe("string");
    expect((resultCall![1].error as string).toLowerCase()).toMatch(/conflict|duplicate/);
  });

  it("does not invoke apply_atomic_batch when duplicate paths are detected", async () => {
    setupAtomicInvoke({ "/vault/a.md": "text" });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/a.md": "text" });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-dup-002",
      entries: [
        { path: "/vault/a.md", find: "text", replace: "x" },
        { path: "/vault/a.md", find: "text", replace: "y" },
      ],
    });
    const batchCall = invokeMock.mock.calls.find((c) => c[0] === "apply_atomic_batch");
    expect(batchCall).toBeUndefined();
  });

  it("marks only the duplicated paths as errored in per-file results", async () => {
    setupAtomicInvoke({ "/vault/a.md": "aaa", "/vault/b.md": "bbb" });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/a.md": "aaa", "/vault/b.md": "bbb" });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-dup-003",
      entries: [
        { path: "/vault/a.md", find: "aaa", replace: "x" },
        { path: "/vault/a.md", find: "aaa", replace: "y" },
        { path: "/vault/b.md", find: "bbb", replace: "z" },
      ],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    const results = resultCall![1].results as Array<{ path: string; ok: boolean; error?: string }>;
    const dupResults = results.filter((r) => r.path === "/vault/a.md");
    expect(dupResults.every((r) => !r.ok)).toBe(true);
  });

  // ── Rollback on edit failure ──────────────────────────────────────────────

  it("returns ok=false and does not write any files when a find string is not found", async () => {
    setupAtomicInvoke({ "/vault/a.md": "content a", "/vault/b.md": "content b" });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/a.md": "content a", "/vault/b.md": "content b" });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-roll-001",
      entries: [
        { path: "/vault/a.md", find: "content a", replace: "updated a" },
        { path: "/vault/b.md", find: "does not exist", replace: "updated b" },
      ],
    });
    const batchCall = invokeMock.mock.calls.find((c) => c[0] === "apply_atomic_batch");
    expect(batchCall).toBeUndefined();
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
  });

  it("does not mutate live document content when a sibling file edit fails", async () => {
    resetDocumentStore({ path: "/vault/open.md", content: "live content" });
    setupAtomicInvoke({ "/vault/disk.md": "disk content" });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/disk.md": "disk content" });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-roll-002",
      entries: [
        { path: "/vault/open.md", find: "live content", replace: "updated" },
        { path: "/vault/disk.md", find: "not present", replace: "y" },
      ],
    });
    // Live document must NOT be updated since the transaction failed.
    expect(useDocumentStore.getState().content).toBe("live content");
  });

  it("per-file results include error for the failed entry and aborted for others", async () => {
    setupAtomicInvoke({ "/vault/a.md": "aaa", "/vault/b.md": "bbb" });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/a.md": "aaa", "/vault/b.md": "bbb" });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-roll-003",
      entries: [
        { path: "/vault/a.md", find: "missing text", replace: "x" },
        { path: "/vault/b.md", find: "bbb", replace: "y" },
      ],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
    const results = resultCall![1].results as Array<{ path: string; ok: boolean; error?: string }>;
    const failedA = results.find((r) => r.path === "/vault/a.md");
    expect(failedA?.ok).toBe(false);
    expect(typeof failedA?.error).toBe("string");
  });

  it("marks ambiguous find (>1 occurrences) as failure and aborts transaction", async () => {
    setupAtomicInvoke({ "/vault/a.md": "the cat and the dog" });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/a.md": "the cat and the dog" });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-roll-004",
      entries: [{ path: "/vault/a.md", find: "the", replace: "a" }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
    const batchCall = invokeMock.mock.calls.find((c) => c[0] === "apply_atomic_batch");
    expect(batchCall).toBeUndefined();
  });

  // ── Rollback on Rust write failure ────────────────────────────────────────

  it("returns ok=false when apply_atomic_batch reports a write failure", async () => {
    setupAtomicInvoke({ "/vault/a.md": "content a" }, "/vault/a.md");
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/a.md": "content a" }, "/vault/a.md");
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-write-001",
      entries: [{ path: "/vault/a.md", find: "content a", replace: "updated a" }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
    expect(typeof resultCall![1].error).toBe("string");
  });

  it("does not update live document when Rust batch write fails", async () => {
    resetDocumentStore({ path: "/vault/open.md", content: "live text" });
    // Disk file write fails
    setupAtomicInvoke({ "/vault/disk.md": "disk text" }, "/vault/disk.md");
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/disk.md": "disk text" }, "/vault/disk.md");
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-write-002",
      entries: [
        { path: "/vault/open.md", find: "live text", replace: "live updated" },
        { path: "/vault/disk.md", find: "disk text", replace: "disk updated" },
      ],
    });
    // Live doc should NOT be updated because disk write failed.
    expect(useDocumentStore.getState().content).toBe("live text");
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall![1].ok).toBe(false);
  });

  it("returns ok=false when apply_atomic_batch invocation throws", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.resolve([{ path: "/vault/a.md", ok: true, content: "aaa" }]);
      if (cmd === "apply_atomic_batch") return Promise.reject(new Error("IPC crashed"));
      if (cmd === "read_markdown_file") return Promise.resolve({ path: "/opened.md", file_name: "opened.md", content: "#", size: 1 });
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.resolve([{ path: "/vault/a.md", ok: true, content: "aaa" }]);
      if (cmd === "apply_atomic_batch") return Promise.reject(new Error("IPC crashed"));
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-write-003",
      entries: [{ path: "/vault/a.md", find: "aaa", replace: "bbb" }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
    expect(resultCall![1].error).toContain("IPC crashed");
  });

  // ── DAG dependency ordering ───────────────────────────────────────────────

  it("applies entries in dependency order (b depends on a)", async () => {
    // File content after first edit becomes input for second (chained).
    // a.md: "foo bar" → "foo BAR" (first)
    // a.md is separate file from b.md; dependency means b must be processed after a.
    setupAtomicInvoke({
      "/vault/a.md": "step one content",
      "/vault/b.md": "step two content",
    });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({
      "/vault/a.md": "step one content",
      "/vault/b.md": "step two content",
    });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-dag-001",
      entries: [
        {
          path: "/vault/b.md",
          find: "step two content",
          replace: "step two done",
          metadata: { dependsOn: ["/vault/a.md"] },
        },
        {
          path: "/vault/a.md",
          find: "step one content",
          replace: "step one done",
        },
      ],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(true);
    // Both edits should have succeeded.
    const results = resultCall![1].results as Array<{ path: string; ok: boolean }>;
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("detects dependency cycles and returns ok=false with a descriptive error", async () => {
    setupAtomicInvoke({ "/vault/a.md": "aaa", "/vault/b.md": "bbb" });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/a.md": "aaa", "/vault/b.md": "bbb" });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-dag-cycle",
      entries: [
        {
          path: "/vault/a.md",
          find: "aaa",
          replace: "x",
          metadata: { dependsOn: ["/vault/b.md"] },
        },
        {
          path: "/vault/b.md",
          find: "bbb",
          replace: "y",
          metadata: { dependsOn: ["/vault/a.md"] },
        },
      ],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
    expect((resultCall![1].error as string).toLowerCase()).toMatch(/cycle/);
    const batchCall = invokeMock.mock.calls.find((c) => c[0] === "apply_atomic_batch");
    expect(batchCall).toBeUndefined();
  });

  it("respects dependsOn for three-file chain a→b→c", async () => {
    setupAtomicInvoke({
      "/vault/a.md": "aaaa",
      "/vault/b.md": "bbbb",
      "/vault/c.md": "cccc",
    });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({
      "/vault/a.md": "aaaa",
      "/vault/b.md": "bbbb",
      "/vault/c.md": "cccc",
    });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-dag-chain",
      entries: [
        { path: "/vault/c.md", find: "cccc", replace: "C", metadata: { dependsOn: ["/vault/b.md"] } },
        { path: "/vault/b.md", find: "bbbb", replace: "B", metadata: { dependsOn: ["/vault/a.md"] } },
        { path: "/vault/a.md", find: "aaaa", replace: "A" },
      ],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(true);
    expect(resultCall![1].results).toHaveLength(3);
    expect(resultCall![1].results.every((r: { ok: boolean }) => r.ok)).toBe(true);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("returns ok=false with error when entries array is empty", async () => {
    setupAtomicInvoke({});
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({});
    await fireEvent("mcp://atomic-edits", { atomicId: "ae-empty", entries: [] });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
    expect(typeof resultCall![1].error).toBe("string");
    expect(resultCall![1].error.length).toBeGreaterThan(0);
  });

  it("returns ok=false when disk file read fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") {
        return Promise.resolve([{ path: "/vault/missing.md", ok: false, error: "File not found" }]);
      }
      if (cmd === "read_markdown_file") return Promise.resolve({ path: "/opened.md", file_name: "opened.md", content: "#", size: 1 });
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") {
        return Promise.resolve([{ path: "/vault/missing.md", ok: false, error: "File not found" }]);
      }
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-nofile",
      entries: [{ path: "/vault/missing.md", find: "anything", replace: "x" }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
    const batchCall = invokeMock.mock.calls.find((c) => c[0] === "apply_atomic_batch");
    expect(batchCall).toBeUndefined();
  });

  it("returns ok=false when read_batch_files invocation throws", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.reject(new Error("IPC error"));
      if (cmd === "read_markdown_file") return Promise.resolve({ path: "/opened.md", file_name: "opened.md", content: "#", size: 1 });
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.reject(new Error("IPC error"));
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-readfail",
      entries: [{ path: "/vault/a.md", find: "x", replace: "y" }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
  });

  it("always calls mcp_atomic_edits_result (prevents Rust timeout)", async () => {
    // Even on a catastrophic error (read rejects), the result must fire.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.reject("boom");
      if (cmd === "read_markdown_file") return Promise.resolve({ path: "/opened.md", file_name: "opened.md", content: "#", size: 1 });
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_batch_files") return Promise.reject("boom");
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-timeout",
      entries: [{ path: "/vault/a.md", find: "x", replace: "y" }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
  });

  it("single-file edit succeeds and writes the file", async () => {
    setupAtomicInvoke({ "/vault/solo.md": "solo content" });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/solo.md": "solo content" });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-single",
      entries: [{ path: "/vault/solo.md", find: "solo content", replace: "new solo" }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(true);
    const batchCall = invokeMock.mock.calls.find((c) => c[0] === "apply_atomic_batch");
    expect(batchCall).toBeDefined();
    expect(batchCall![1].entries[0]).toMatchObject({ path: "/vault/solo.md", content: "new solo" });
  });

  it("empty find string returns ok=false (propagates applyUniqueEdit error)", async () => {
    setupAtomicInvoke({ "/vault/a.md": "some content" });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/a.md": "some content" });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-emptyfind",
      entries: [{ path: "/vault/a.md", find: "", replace: "x" }],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(false);
  });

  it("three disk files all succeed and are all passed to apply_atomic_batch", async () => {
    setupAtomicInvoke({
      "/vault/a.md": "alpha",
      "/vault/b.md": "beta",
      "/vault/c.md": "gamma",
    });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({
      "/vault/a.md": "alpha",
      "/vault/b.md": "beta",
      "/vault/c.md": "gamma",
    });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-three",
      entries: [
        { path: "/vault/a.md", find: "alpha", replace: "ALPHA" },
        { path: "/vault/b.md", find: "beta", replace: "BETA" },
        { path: "/vault/c.md", find: "gamma", replace: "GAMMA" },
      ],
    });
    const batchCall = invokeMock.mock.calls.find((c) => c[0] === "apply_atomic_batch");
    expect(batchCall).toBeDefined();
    expect(batchCall![1].entries).toHaveLength(3);
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall![1].ok).toBe(true);
    expect(resultCall![1].results).toHaveLength(3);
  });

  it("metadata.dependsOn referencing unknown path is ignored (no error)", async () => {
    setupAtomicInvoke({ "/vault/a.md": "aaa" });
    mountBridge();
    invokeMock.mockClear();
    setupAtomicInvoke({ "/vault/a.md": "aaa" });
    await fireEvent("mcp://atomic-edits", {
      atomicId: "ae-dep-unknown",
      entries: [
        {
          path: "/vault/a.md",
          find: "aaa",
          replace: "bbb",
          metadata: { dependsOn: ["/vault/not-in-batch.md"] },
        },
      ],
    });
    const resultCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_atomic_edits_result");
    expect(resultCall).toBeDefined();
    expect(resultCall![1].ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://edit-canvas — canvas mutation with transaction semantics
// ════════════════════════════════════════════════════════════════════════════

// Helper: build a minimal valid .canvas JSON string
function makeCanvasJson(overrides: {
  nodes?: unknown[];
  edges?: unknown[];
} = {}): string {
  return JSON.stringify({
    nodes: overrides.nodes ?? [
      { id: "n1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "Hello" },
      { id: "n2", type: "text", x: 200, y: 0, width: 100, height: 50, text: "World" },
    ],
    edges: overrides.edges ?? [{ id: "e1", fromNode: "n1", toNode: "n2" }],
  });
}

// Helper: configure invokeMock for a canvas read/write cycle
function setupCanvasInvoke(canvasContent: string, writeOk = true): void {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "read_canvas_file") return Promise.resolve(canvasContent);
    if (cmd === "write_canvas_file") {
      if (writeOk) return Promise.resolve(undefined);
      return Promise.reject(new Error("disk write failed"));
    }
    if (cmd === "read_markdown_file") {
      return Promise.resolve({ path: "/opened.md", file_name: "opened.md", content: "#", size: 1 });
    }
    return Promise.resolve(undefined);
  });
}

describe("mcp://edit-canvas event", () => {
  // ── Registration ────────────────────────────────────────────────────────────

  it("registers listener for mcp://edit-canvas on mount", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://edit-canvas")).toBe(true);
  });

  // ── Happy path: move_node ───────────────────────────────────────────────────

  it("applies move_node and returns ok=true with serialised canvas", async () => {
    setupCanvasInvoke(makeCanvasJson());
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(makeCanvasJson());
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-001",
      path: "/vault/board.canvas",
      ops: [{ type: "move_node", id: "n1", x: 500, y: 300 }],
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result).toBeDefined();
    expect(result![1]).toMatchObject({ editId: "ec-001", ok: true });
    // Serialised content should reflect the new position
    const content = JSON.parse(result![1].content);
    expect(content.nodes[0].x).toBe(500);
    expect(content.nodes[0].y).toBe(300);
  });

  it("calls write_canvas_file with the mutated content after successful ops", async () => {
    setupCanvasInvoke(makeCanvasJson());
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(makeCanvasJson());
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-002",
      path: "/vault/board.canvas",
      ops: [{ type: "edit_text", id: "n1", text: "Updated" }],
    });
    const writeCall = invokeMock.mock.calls.find((c) => c[0] === "write_canvas_file");
    expect(writeCall).toBeDefined();
    expect(writeCall![1].path).toBe("/vault/board.canvas");
    const written = JSON.parse(writeCall![1].content);
    const node = written.nodes.find((n: { id: string }) => n.id === "n1");
    expect(node.text).toBe("Updated");
  });

  // ── Add node ────────────────────────────────────────────────────────────────

  it("adds a node and reports nodesAffected=1", async () => {
    setupCanvasInvoke(makeCanvasJson());
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(makeCanvasJson());
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-003",
      path: "/vault/board.canvas",
      ops: [
        {
          type: "add_node",
          node: { id: "n3", type: "text", x: 400, y: 0, width: 100, height: 50, text: "New" },
        },
      ],
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result).toBeDefined();
    expect(result![1].ok).toBe(true);
    expect(result![1].nodesAffected).toBe(1);
    const content = JSON.parse(result![1].content);
    expect(content.nodes).toHaveLength(3);
  });

  // ── Add edge ────────────────────────────────────────────────────────────────

  it("adds an edge to the canvas", async () => {
    const canvas = makeCanvasJson({
      nodes: [
        { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "A" },
        { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "B" },
      ],
      edges: [],
    });
    setupCanvasInvoke(canvas);
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(canvas);
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-004",
      path: "/vault/graph.canvas",
      ops: [{ type: "add_edge", edge: { id: "e1", fromNode: "a", toNode: "b", toEnd: "arrow" } }],
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result![1].ok).toBe(true);
    const content = JSON.parse(result![1].content);
    expect(content.edges).toHaveLength(1);
    expect(content.edges[0].toEnd).toBe("arrow");
  });

  // ── All-or-nothing: one failing op aborts entire batch ──────────────────────

  it("aborts entire batch when one op fails — no write occurs", async () => {
    setupCanvasInvoke(makeCanvasJson());
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(makeCanvasJson());
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-005",
      path: "/vault/board.canvas",
      ops: [
        { type: "move_node", id: "n1", x: 100, y: 100 },    // valid
        { type: "move_node", id: "no-such-node", x: 0, y: 0 }, // invalid → abort
        { type: "edit_text", id: "n2", text: "should not run" },
      ],
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result).toBeDefined();
    expect(result![1].ok).toBe(false);
    expect(result![1].error).toMatch(/no-such-node/i);
    // No write should have been attempted
    const writeCall = invokeMock.mock.calls.find((c) => c[0] === "write_canvas_file");
    expect(writeCall).toBeUndefined();
  });

  it("error message names the failing op type and index", async () => {
    setupCanvasInvoke(makeCanvasJson());
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(makeCanvasJson());
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-006",
      path: "/vault/board.canvas",
      ops: [
        { type: "edit_text", id: "n1", text: "ok" },     // [0] succeeds
        { type: "edit_text", id: "e1", text: "bad" },    // [1] fails: e1 is an edge not a node
      ],
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result![1].ok).toBe(false);
    expect(result![1].error).toMatch(/Op \[1\]/);
    expect(result![1].error).toMatch(/edit_text/);
  });

  // ── Guard: empty ops array ──────────────────────────────────────────────────

  it("returns ok=false with error when ops array is empty", async () => {
    setupCanvasInvoke(makeCanvasJson());
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(makeCanvasJson());
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-007",
      path: "/vault/board.canvas",
      ops: [],
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result).toBeDefined();
    expect(result![1].ok).toBe(false);
    expect(result![1].error).toMatch(/non-empty/i);
  });

  // ── Guard: missing path ─────────────────────────────────────────────────────

  it("returns ok=false with error when path is missing", async () => {
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-008",
      path: "",
      ops: [{ type: "move_node", id: "n1", x: 0, y: 0 }],
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result).toBeDefined();
    expect(result![1].ok).toBe(false);
    expect(result![1].error).toMatch(/path/i);
  });

  // ── Guard: canvas parse error ───────────────────────────────────────────────

  it("returns ok=false when the canvas file contains invalid JSON", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_canvas_file") return Promise.resolve("{ not valid json {{");
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_canvas_file") return Promise.resolve("{ not valid json {{");
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-009",
      path: "/vault/broken.canvas",
      ops: [{ type: "move_node", id: "n1", x: 0, y: 0 }],
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result).toBeDefined();
    expect(result![1].ok).toBe(false);
    expect(result![1].error).toMatch(/parse/i);
  });

  // ── Guard: read error ───────────────────────────────────────────────────────

  it("returns ok=false when read_canvas_file throws", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_canvas_file") return Promise.reject(new Error("file not found"));
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_canvas_file") return Promise.reject(new Error("file not found"));
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-010",
      path: "/vault/missing.canvas",
      ops: [{ type: "move_node", id: "n1", x: 0, y: 0 }],
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result).toBeDefined();
    expect(result![1].ok).toBe(false);
    expect(result![1].error).toContain("file not found");
  });

  // ── Guard: write error ──────────────────────────────────────────────────────

  it("returns ok=false when write_canvas_file throws", async () => {
    setupCanvasInvoke(makeCanvasJson(), false /* writeOk=false */);
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(makeCanvasJson(), false);
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-011",
      path: "/vault/board.canvas",
      ops: [{ type: "move_node", id: "n1", x: 50, y: 50 }],
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result).toBeDefined();
    expect(result![1].ok).toBe(false);
    expect(result![1].error).toMatch(/write/i);
  });

  // ── save=false skips disk write ─────────────────────────────────────────────

  it("skips write_canvas_file when save=false", async () => {
    setupCanvasInvoke(makeCanvasJson());
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(makeCanvasJson());
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-012",
      path: "/vault/board.canvas",
      ops: [{ type: "move_node", id: "n1", x: 99, y: 99 }],
      save: false,
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result![1].ok).toBe(true);
    const writeCall = invokeMock.mock.calls.find((c) => c[0] === "write_canvas_file");
    expect(writeCall).toBeUndefined();
    // Content is still returned even when not saved
    expect(result![1].content).toBeTruthy();
  });

  // ── Undo/redo steps ──────────────────────────────────────────────────────────

  it("applies undo steps after ops when undo>0", async () => {
    setupCanvasInvoke(makeCanvasJson());
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(makeCanvasJson());
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-013",
      path: "/vault/board.canvas",
      ops: [{ type: "move_node", id: "n1", x: 500, y: 500 }],
      undo: 1,    // undo the move_node → canvas back to original
      save: false,
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result![1].ok).toBe(true);
    const content = JSON.parse(result![1].content);
    // After undo, node should be back at original x=0, y=0
    expect(content.nodes[0].x).toBe(0);
    expect(content.nodes[0].y).toBe(0);
  });

  it("always calls mcp_edit_canvas_result (prevents Rust timeout)", async () => {
    // Even with a completely unexpected crash scenario
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_canvas_file") return Promise.reject("IPC teardown");
      return Promise.resolve(undefined);
    });
    mountBridge();
    invokeMock.mockClear();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_canvas_file") return Promise.reject("IPC teardown");
      return Promise.resolve(undefined);
    });
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-014",
      path: "/vault/board.canvas",
      ops: [{ type: "move_node", id: "n1", x: 0, y: 0 }],
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result).toBeDefined();
  });

  // ── Multi-op batch ───────────────────────────────────────────────────────────

  it("applies multiple ops in sequence — all succeed", async () => {
    const canvas = makeCanvasJson({
      nodes: [
        { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "A" },
        { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "B" },
      ],
      edges: [],
    });
    setupCanvasInvoke(canvas);
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(canvas);
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-015",
      path: "/vault/board.canvas",
      ops: [
        { type: "move_node", id: "a", x: 10, y: 10 },
        { type: "edit_text", id: "a", text: "A updated" },
        { type: "set_node_color", id: "b", color: "3" },
        { type: "add_edge", edge: { id: "e1", fromNode: "a", toNode: "b", toEnd: "arrow" } },
      ],
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result![1].ok).toBe(true);
    const content = JSON.parse(result![1].content);
    expect(content.nodes[0].x).toBe(10);
    const nodeA = content.nodes.find((n: { id: string }) => n.id === "a");
    expect(nodeA.text).toBe("A updated");
    const nodeB = content.nodes.find((n: { id: string }) => n.id === "b");
    expect(nodeB.color).toBe("3");
    expect(content.edges).toHaveLength(1);
  });

  it("delete_node op removes node and its edges", async () => {
    setupCanvasInvoke(makeCanvasJson());
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(makeCanvasJson());
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-016",
      path: "/vault/board.canvas",
      ops: [{ type: "delete_node", id: "n1" }],
      save: false,
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result![1].ok).toBe(true);
    const content = JSON.parse(result![1].content);
    expect(content.nodes).toHaveLength(1);
    expect(content.nodes[0].id).toBe("n2");
    // Edge e1 connects n1 → n2, so it should be removed too
    expect(content.edges).toHaveLength(0);
  });

  it("resize_node op updates dimensions in serialised output", async () => {
    setupCanvasInvoke(makeCanvasJson());
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(makeCanvasJson());
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-017",
      path: "/vault/board.canvas",
      ops: [{ type: "resize_node", id: "n1", width: 300, height: 200 }],
      save: false,
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result![1].ok).toBe(true);
    const node = JSON.parse(result![1].content).nodes.find((n: { id: string }) => n.id === "n1");
    expect(node.width).toBe(300);
    expect(node.height).toBe(200);
  });

  it("edit_group_label op updates label in serialised output", async () => {
    const canvas = makeCanvasJson({
      nodes: [
        { id: "g1", type: "group", x: 0, y: 0, width: 400, height: 300, label: "Old Label" },
      ],
      edges: [],
    });
    setupCanvasInvoke(canvas);
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(canvas);
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-018",
      path: "/vault/groups.canvas",
      ops: [{ type: "edit_group_label", id: "g1", label: "New Label" }],
      save: false,
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result![1].ok).toBe(true);
    const node = JSON.parse(result![1].content).nodes[0];
    expect(node.label).toBe("New Label");
  });

  it("reorder_edges op reorders edges in serialised output", async () => {
    const canvas = makeCanvasJson({
      nodes: [
        { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
        { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "" },
      ],
      edges: [
        { id: "e1", fromNode: "a", toNode: "b" },
        { id: "e2", fromNode: "b", toNode: "a" },
      ],
    });
    setupCanvasInvoke(canvas);
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(canvas);
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-019",
      path: "/vault/flow.canvas",
      ops: [{ type: "reorder_edges", ids: ["e2", "e1"] }],
      save: false,
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result![1].ok).toBe(true);
    const edges = JSON.parse(result![1].content).edges;
    expect(edges[0].id).toBe("e2");
    expect(edges[1].id).toBe("e1");
  });

  it("returns editId in result payload for correlation", async () => {
    setupCanvasInvoke(makeCanvasJson());
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(makeCanvasJson());
    await fireEvent("mcp://edit-canvas", {
      editId: "my-unique-correlation-id",
      path: "/vault/board.canvas",
      ops: [{ type: "move_node", id: "n1", x: 10, y: 10 }],
      save: false,
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result![1].editId).toBe("my-unique-correlation-id");
  });

  it("content field in result is valid JSON canvas string", async () => {
    setupCanvasInvoke(makeCanvasJson());
    mountBridge();
    invokeMock.mockClear();
    setupCanvasInvoke(makeCanvasJson());
    await fireEvent("mcp://edit-canvas", {
      editId: "ec-021",
      path: "/vault/board.canvas",
      ops: [{ type: "move_node", id: "n1", x: 1, y: 1 }],
      save: false,
    });
    const result = invokeMock.mock.calls.find((c) => c[0] === "mcp_edit_canvas_result");
    expect(result![1].ok).toBe(true);
    expect(() => JSON.parse(result![1].content)).not.toThrow();
    const parsed = JSON.parse(result![1].content);
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(Array.isArray(parsed.edges)).toBe(true);
  });
});
