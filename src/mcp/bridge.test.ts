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
  it("registers listeners for all eleven mcp:// events", () => {
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
