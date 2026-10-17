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
  // Always return a promise: debounced timers from earlier tests can fire after a mock reset and call .catch on the result.
  invoke: (...args: unknown[]) => Promise.resolve(invokeMock(...args)),
}));

// ─── Export function mocks ────────────────────────────────────────────────────
//
// We mock the three export functions from src/lib/export so bridge tests are
// fully isolated from DOM/Tauri-dialog dependencies.  Individual tests can
// override these with mockResolvedValue / mockRejectedValue as needed.

const exportPdfMock = vi.fn().mockResolvedValue(undefined);
const exportDocxMock = vi.fn().mockResolvedValue(undefined);
const exportHtmlMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/export", () => ({
  exportPdf: (...args: unknown[]) => exportPdfMock(...args),
  exportDocx: (...args: unknown[]) => exportDocxMock(...args),
  exportHtml: (...args: unknown[]) => exportHtmlMock(...args),
  // Re-export anything else export.ts might expose so other imports don't break.
  buildStandaloneHtml: vi.fn(),
  buildStandaloneHtmlWithActiveTemplate: vi.fn(),
  cloneWithoutInjectedChrome: vi.fn((el: Element) => el),
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
    getState: () => ({ recents: ["/a.md", "/b.md"], add: vi.fn() }),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock("../store/activityStore", () => ({
  // Not the real 200: the bridge must send the store's cap, not a copy of it.
  MAX_FILES: 150,
  useActivityStore: {
    getState: () => ({
      watchedDir: "/vault",
      files: [
        { path: "/vault/a.md", name: "a.md", dir: "/vault", mtimeMs: 1000, size: 100 },
        { path: "/vault/b.md", name: "b.md", dir: "/vault", mtimeMs: 2000, size: 200 },
      ],
      truncated: true,
      scanCut: true,
    }),
    subscribe: vi.fn(() => vi.fn()),
  },
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
import { useReviewStore } from "../store/reviewStore";
import { useUiStore } from "../store/uiStore";
import { useMcpBridge } from "./bridge";

// ─── Fire a fake Tauri event ──────────────────────────────────────────────────

async function fireEvent(eventName: string, payload: Payload): Promise<void> {
  const handler = listenHandlers.get(eventName);
  if (!handler)
    throw new Error(
      `No listener registered for "${eventName}". Registered: [${[...listenHandlers.keys()].join(", ")}]`,
    );
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
  // biome-ignore lint/correctness/useHookAtTopLevel: test harness mounts the hook against a mocked React whose useEffect runs synchronously.
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
  // Default: all export functions succeed.
  exportPdfMock.mockResolvedValue(undefined);
  exportDocxMock.mockResolvedValue(undefined);
  exportHtmlMock.mockResolvedValue(undefined);

  resetDocumentStore();
  useUiStore.setState({ exportOpen: false, exportFormat: null, zenMode: false });
  useReviewStore.setState({ pending: null, draftComment: "" } as unknown as Parameters<
    typeof useReviewStore.setState
  >[0]);

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
  it("registers listeners for the core mcp:// events", () => {
    mountBridge();
    const expected = [
      "mcp://open",
      "mcp://set-content",
      "mcp://edit",
      "mcp://export",
      "mcp://review",
      "mcp://present",
      "mcp://stream-edit",
      "mcp://stream-edit-apply",
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
    expect(vaultCall![1]).toMatchObject({
      watchedDir: "/vault",
      truncated: true,
      limit: 150,
      scanCut: true,
    });
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

  // ── DOCX ─────────────────────────────────────────────────────────────────

  it("calls exportDocx with the document title when format=docx and outputPath is set", async () => {
    resetDocumentStore({ path: "/notes/spec.md", fileName: "spec.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "docx", outputPath: "/tmp/spec.docx" });
    expect(exportDocxMock).toHaveBeenCalledWith("spec", "/tmp/spec.docx");
    expect(exportPdfMock).not.toHaveBeenCalled();
    expect(exportHtmlMock).not.toHaveBeenCalled();
  });

  // ── HTML ─────────────────────────────────────────────────────────────────

  it("calls exportHtml with the document title when format=html and outputPath is set", async () => {
    resetDocumentStore({ path: "/notes/index.md", fileName: "index.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "html", outputPath: "/tmp/index.html" });
    expect(exportHtmlMock).toHaveBeenCalledWith("index", "/tmp/index.html");
    expect(exportPdfMock).not.toHaveBeenCalled();
    expect(exportDocxMock).not.toHaveBeenCalled();
  });

  // ── Title derivation ──────────────────────────────────────────────────────

  it("strips the .md extension when deriving the title for the export call", async () => {
    resetDocumentStore({ path: "/docs/readme.md", fileName: "readme.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "html", outputPath: "/tmp/readme.html" });
    expect(exportHtmlMock).toHaveBeenCalledWith("readme", "/tmp/readme.html");
  });

  it("strips .markdown extension when deriving the title", async () => {
    resetDocumentStore({ path: "/docs/notes.markdown", fileName: "notes.markdown" });
    mountBridge();
    await fireEvent("mcp://export", { format: "html", outputPath: "/tmp/notes.html" });
    expect(exportHtmlMock).toHaveBeenCalledWith("notes", "/tmp/notes.html");
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

  it("shows an error toast when export fails", async () => {
    exportPdfMock.mockRejectedValue(new Error("print failed"));
    resetDocumentStore({ path: "/doc.md", fileName: "doc.md" });
    mountBridge();
    await fireEvent("mcp://export", { format: "pdf", outputPath: "/tmp/out.pdf" });
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/print failed/i));
  });

  // ── No-document guard with outputPath ────────────────────────────────────

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
// Removed events with no emitter
// ════════════════════════════════════════════════════════════════════════════

describe("removed export events", () => {
  it("does not listen for mcp://export-markdown-archive or mcp://export-canvas-graph", () => {
    // Nothing emits these: the Tauri commands behind them were never
    // implemented and the MCP tools were withdrawn.
    mountBridge();
    expect(listenHandlers.has("mcp://export-markdown-archive")).toBe(false);
    expect(listenHandlers.has("mcp://export-canvas-graph")).toBe(false);
  });

  it("does not listen for events neither the IPC server nor the app emits", () => {
    // These listeners answered on *_result commands the app never
    // registered, for MCP tools that do not exist.
    mountBridge();
    for (const ev of [
      "mcp://batch-read",
      "mcp://semantic-search",
      "mcp://diff-docs",
      "mcp://batch-edit",
      "mcp://atomic-edits",
      "mcp://export-outline",
      "mcp://batch-export",
      "mcp://batch-export-profiles",
      "mcp://edit-canvas",
      "mcp://ot-op",
      "mcp://copy-rich-text",
      "mcp://lint-document",
      "mcp://apply-diff-hunk",
    ]) {
      expect(listenHandlers.has(ev), ev).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://stream-edit — diff preview before apply
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://stream-edit event — preview phase", () => {
  it("registers listener for mcp://stream-edit on mount", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://stream-edit")).toBe(true);
  });

  it("calls mcp_stream_edit_preview with ok=true for a unique match", async () => {
    resetDocumentStore({ content: "# Hello\n\nUnique phrase here.\n" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-001",
      find: "Unique phrase here.",
      replace: "Replaced phrase.",
      preview: true,
      previewLines: 3,
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ editId: "se-001", ok: true });
  });

  it("returned diff contains removed (-) and added (+) lines", async () => {
    resetDocumentStore({ content: "line1\nfind me\nline3\n" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-002",
      find: "find me",
      replace: "replaced",
      preview: true,
      previewLines: 1,
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    const diff: string = call![1].diff;
    expect(diff).toContain("-find me");
    expect(diff).toContain("+replaced");
  });

  it("diff contains unified diff header lines (--- and +++)", async () => {
    resetDocumentStore({ content: "alpha\nbeta\ngamma\n" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-003",
      find: "beta",
      replace: "BETA",
      preview: true,
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    const diff: string = call![1].diff;
    expect(diff).toContain("---");
    expect(diff).toContain("+++");
    expect(diff).toContain("@@");
  });

  it("matchCount is 1 for a unique match", async () => {
    resetDocumentStore({ content: "only once here" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-004",
      find: "only once here",
      replace: "replaced",
      preview: true,
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    expect(call![1].matchCount).toBe(1);
  });

  it("returns ok=false and matchCount=0 when find is not in document", async () => {
    resetDocumentStore({ content: "something else" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-005",
      find: "not present at all",
      replace: "x",
      preview: true,
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    expect(call![1].ok).toBe(false);
    expect(call![1].matchCount).toBe(0);
    expect(typeof call![1].error).toBe("string");
  });

  it("returns ok=false with error when find is empty string", async () => {
    resetDocumentStore({ content: "some content" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-006",
      find: "",
      replace: "x",
      preview: true,
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    expect(call![1].ok).toBe(false);
    expect(call![1].error).toBeTruthy();
  });

  it("returns candidates array when find matches multiple occurrences", async () => {
    resetDocumentStore({ content: "foo bar\nfoo baz\nfoo qux\n" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-007",
      find: "foo",
      replace: "FOO",
      preview: true,
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    expect(call![1].ok).toBe(true);
    expect(call![1].matchCount).toBe(3);
    expect(Array.isArray(call![1].candidates)).toBe(true);
    expect(call![1].candidates).toHaveLength(3);
  });

  it("candidates are ranked (rank 1 = first occurrence)", async () => {
    resetDocumentStore({ content: "apple\napple\n" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-008",
      find: "apple",
      replace: "APPLE",
      preview: true,
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    const candidates = call![1].candidates as Array<{
      rank: number;
      matchIndex: number;
    }>;
    expect(candidates[0].rank).toBe(1);
    expect(candidates[0].matchIndex).toBe(0);
    expect(candidates[1].rank).toBe(2);
    expect(candidates[1].matchIndex).toBe(1);
  });

  it("each candidate has its own diff string", async () => {
    resetDocumentStore({ content: "x = 1\nx = 2\n" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-009",
      find: "x",
      replace: "y",
      preview: true,
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    const candidates = call![1].candidates as Array<{ diff: string }>;
    expect(
      candidates.every((c) => typeof c.diff === "string" && c.diff.length > 0),
    ).toBe(true);
  });

  it("previewLines controls context in the diff (larger value = more context lines)", async () => {
    const doc = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    resetDocumentStore({ content: doc + "\ntarget line\n" + doc });
    mountBridge();
    invokeMock.mockClear();

    // Preview with 2 context lines
    await fireEvent("mcp://stream-edit", {
      editId: "se-010a",
      find: "target line",
      replace: "replaced",
      preview: true,
      previewLines: 2,
    });
    const call2 = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    const diff2Lines = (call2![1].diff as string)
      .split("\n")
      .filter((l: string) => l.startsWith(" ")).length;

    invokeMock.mockClear();

    // Preview with 5 context lines
    await fireEvent("mcp://stream-edit", {
      editId: "se-010b",
      find: "target line",
      replace: "replaced",
      preview: true,
      previewLines: 5,
    });
    const call5 = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    const diff5Lines = (call5![1].diff as string)
      .split("\n")
      .filter((l: string) => l.startsWith(" ")).length;

    expect(diff5Lines).toBeGreaterThanOrEqual(diff2Lines);
  });

  it("when preview=false, applies immediately and does NOT generate a diff", async () => {
    resetDocumentStore({ content: "hello world" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-011",
      find: "hello world",
      replace: "goodbye world",
      preview: false,
    });
    expect(useDocumentStore.getState().content).toBe("goodbye world");
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    expect(call).toBeDefined();
    expect(call![1].ok).toBe(true);
    // diff is empty string when preview=false
    expect(call![1].diff).toBe("");
  });

  it("always calls mcp_stream_edit_preview even on error (prevents Rust timeout)", async () => {
    resetDocumentStore({ content: "abc" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-012",
      find: "not here at all",
      replace: "x",
      preview: true,
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    expect(call).toBeDefined();
  });

  it("does NOT mutate document content during preview phase", async () => {
    const original = "original content";
    resetDocumentStore({ content: original });
    mountBridge();
    await fireEvent("mcp://stream-edit", {
      editId: "se-013",
      find: "original content",
      replace: "changed",
      preview: true,
    });
    expect(useDocumentStore.getState().content).toBe(original);
  });

  it("path assertion: returns error when asserted path differs from open doc", async () => {
    resetDocumentStore({ path: "/doc/real.md", content: "content here" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-014",
      find: "content here",
      replace: "x",
      preview: true,
      path: "/doc/other.md",
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    expect(call![1].ok).toBe(false);
    expect(call![1].error).toMatch(/mismatch/i);
  });

  it("path assertion passes when path matches the open document", async () => {
    resetDocumentStore({ path: "/doc/real.md", content: "unique text xyz" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-015",
      find: "unique text xyz",
      replace: "replaced",
      preview: true,
      path: "/doc/real.md",
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    expect(call![1].ok).toBe(true);
  });

  it("diff includes the hunk @@ header with line numbers", async () => {
    resetDocumentStore({ content: "a\nb\nc\ntarget\nd\ne\n" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-016",
      find: "target",
      replace: "REPLACED",
      preview: true,
      previewLines: 1,
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    expect(call![1].diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  it("candidates array is null (not present) for a unique match", async () => {
    resetDocumentStore({ content: "only this once" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-017",
      find: "only this once",
      replace: "x",
      preview: true,
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    expect(call![1].candidates).toBeNull();
  });

  it("each candidate has a startLine property (1-based line number)", async () => {
    resetDocumentStore({ content: "line1\nfoo\nline3\nfoo\nline5\n" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit", {
      editId: "se-018",
      find: "foo",
      replace: "bar",
      preview: true,
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "mcp_stream_edit_preview");
    const candidates = call![1].candidates as Array<{ startLine: number }>;
    for (const c of candidates) {
      expect(typeof c.startLine).toBe("number");
      expect(c.startLine).toBeGreaterThanOrEqual(1);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mcp://stream-edit-apply — atomic apply after preview confirmation
// ════════════════════════════════════════════════════════════════════════════

describe("mcp://stream-edit-apply event — apply phase", () => {
  it("registers listener for mcp://stream-edit-apply on mount", () => {
    mountBridge();
    expect(listenHandlers.has("mcp://stream-edit-apply")).toBe(true);
  });

  it("applies edit at matchIndex=0 (default) and updates document content", async () => {
    resetDocumentStore({ content: "# Doc\n\nChange me.\n" });
    mountBridge();
    await fireEvent("mcp://stream-edit-apply", {
      editId: "sa-001",
      find: "Change me.",
      replace: "Changed!",
    });
    expect(useDocumentStore.getState().content).toBe("# Doc\n\nChanged!\n");
  });

  it("calls mcp_stream_edit_apply_result with ok=true on success", async () => {
    resetDocumentStore({ content: "hello world" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit-apply", {
      editId: "sa-002",
      find: "hello world",
      replace: "hi there",
    });
    const call = invokeMock.mock.calls.find(
      (c) => c[0] === "mcp_stream_edit_apply_result",
    );
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ editId: "sa-002", ok: true, replaced: 1 });
  });

  it("applies at a specific matchIndex (second occurrence)", async () => {
    resetDocumentStore({ content: "foo 1\nfoo 2\nfoo 3\n" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit-apply", {
      editId: "sa-003",
      find: "foo",
      replace: "bar",
      matchIndex: 1,
    });
    const content = useDocumentStore.getState().content;
    // Only the second occurrence should be replaced
    expect(content).toBe("foo 1\nbar 2\nfoo 3\n");
    const call = invokeMock.mock.calls.find(
      (c) => c[0] === "mcp_stream_edit_apply_result",
    );
    expect(call![1].matchIndex).toBe(1);
  });

  it("returns ok=false when find is not found in document", async () => {
    resetDocumentStore({ content: "something else" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit-apply", {
      editId: "sa-004",
      find: "not here",
      replace: "x",
    });
    const call = invokeMock.mock.calls.find(
      (c) => c[0] === "mcp_stream_edit_apply_result",
    );
    expect(call![1].ok).toBe(false);
    expect(typeof call![1].error).toBe("string");
  });

  it("returns ok=false when matchIndex is out of bounds", async () => {
    resetDocumentStore({ content: "foo bar" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit-apply", {
      editId: "sa-005",
      find: "foo",
      replace: "baz",
      matchIndex: 99,
    });
    const call = invokeMock.mock.calls.find(
      (c) => c[0] === "mcp_stream_edit_apply_result",
    );
    expect(call![1].ok).toBe(false);
    expect(call![1].error).toMatch(/out of bounds/i);
  });

  it("returns ok=false and error when find is missing from payload", async () => {
    resetDocumentStore({ content: "some content" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit-apply", {
      editId: "sa-006",
      find: "",
      replace: "x",
    });
    const call = invokeMock.mock.calls.find(
      (c) => c[0] === "mcp_stream_edit_apply_result",
    );
    expect(call![1].ok).toBe(false);
    expect(call![1].error).toBeTruthy();
  });

  it("does not mutate document content when apply fails", async () => {
    const original = "original unchanged";
    resetDocumentStore({ content: original });
    mountBridge();
    await fireEvent("mcp://stream-edit-apply", {
      editId: "sa-007",
      find: "not present",
      replace: "x",
    });
    expect(useDocumentStore.getState().content).toBe(original);
  });

  it("triggers mcp_sync_state after successful apply", async () => {
    resetDocumentStore({ path: "/doc.md", content: "sync test content" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit-apply", {
      editId: "sa-008",
      find: "sync test content",
      replace: "synced",
    });
    const syncCall = invokeMock.mock.calls.find((c) => c[0] === "mcp_sync_state");
    expect(syncCall).toBeDefined();
  });

  it("always calls mcp_stream_edit_apply_result (prevents Rust timeout)", async () => {
    resetDocumentStore({ content: "abc" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit-apply", {
      editId: "sa-009",
      find: "xyz not present",
      replace: "x",
    });
    const call = invokeMock.mock.calls.find(
      (c) => c[0] === "mcp_stream_edit_apply_result",
    );
    expect(call).toBeDefined();
  });

  it("path assertion: returns error when path does not match open doc", async () => {
    resetDocumentStore({ path: "/real.md", content: "content" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit-apply", {
      editId: "sa-010",
      find: "content",
      replace: "x",
      path: "/other.md",
    });
    const call = invokeMock.mock.calls.find(
      (c) => c[0] === "mcp_stream_edit_apply_result",
    );
    expect(call![1].ok).toBe(false);
    expect(call![1].error).toMatch(/mismatch/i);
  });

  it("replaced field is 1 on a successful single-occurrence apply", async () => {
    resetDocumentStore({ content: "find this exactly once" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit-apply", {
      editId: "sa-011",
      find: "find this exactly once",
      replace: "done",
    });
    const call = invokeMock.mock.calls.find(
      (c) => c[0] === "mcp_stream_edit_apply_result",
    );
    expect(call![1].replaced).toBe(1);
  });

  it("applies at last occurrence when matchIndex = N-1", async () => {
    resetDocumentStore({ content: "A B A C A" });
    mountBridge();
    invokeMock.mockClear();
    await fireEvent("mcp://stream-edit-apply", {
      editId: "sa-012",
      find: "A",
      replace: "Z",
      matchIndex: 2,
    });
    expect(useDocumentStore.getState().content).toBe("A B A C Z");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// stream-edit pure utility tests (computeStreamEditDiff, applyEditAtOccurrence)
// ════════════════════════════════════════════════════════════════════════════

describe("computeStreamEditDiff — pure utility", () => {
  let computeStreamEditDiff: typeof import("./applyEdit").computeStreamEditDiff;
  let applyEditAtOccurrence: typeof import("./applyEdit").applyEditAtOccurrence;
  let findAllOccurrences: typeof import("./applyEdit").findAllOccurrences;
  let offsetToLine: typeof import("./applyEdit").offsetToLine;
  let buildUnifiedDiff: typeof import("./applyEdit").buildUnifiedDiff;

  beforeEach(async () => {
    const mod = await import("./applyEdit");
    computeStreamEditDiff = mod.computeStreamEditDiff;
    applyEditAtOccurrence = mod.applyEditAtOccurrence;
    findAllOccurrences = mod.findAllOccurrences;
    offsetToLine = mod.offsetToLine;
    buildUnifiedDiff = mod.buildUnifiedDiff;
  });

  it("returns ok=false for empty find string", () => {
    const r = computeStreamEditDiff("content", "", "x");
    expect(r.ok).toBe(false);
    expect(r.matchCount).toBe(0);
    expect(r.error).toBeTruthy();
  });

  it("returns ok=false when find is not present in content", () => {
    const r = computeStreamEditDiff("hello world", "missing", "x");
    expect(r.ok).toBe(false);
    expect(r.matchCount).toBe(0);
  });

  it("returns ok=true with matchCount=1 for a unique match", () => {
    const r = computeStreamEditDiff("unique text here", "unique text here", "replaced");
    expect(r.ok).toBe(true);
    expect(r.matchCount).toBe(1);
    expect(r.candidates).toBeUndefined();
  });

  it("diff for unique match contains removed and added markers", () => {
    const r = computeStreamEditDiff("line1\nfind\nline3", "find", "replaced");
    expect(r.diff).toContain("-find");
    expect(r.diff).toContain("+replaced");
  });

  it("returns candidates when find matches multiple times", () => {
    const r = computeStreamEditDiff("foo\nfoo\nfoo", "foo", "bar");
    expect(r.ok).toBe(true);
    expect(r.matchCount).toBe(3);
    expect(r.candidates).toHaveLength(3);
  });

  it("candidate ranks are 1, 2, 3 in order", () => {
    const r = computeStreamEditDiff("x\nx\nx", "x", "y");
    expect(r.candidates!.map((c) => c.rank)).toEqual([1, 2, 3]);
  });

  it("primary diff equals first candidate diff for multi-match", () => {
    const r = computeStreamEditDiff("a\na", "a", "b");
    expect(r.diff).toBe(r.candidates![0].diff);
  });

  it("context lines default is 3", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
    const r = computeStreamEditDiff(content, "line5", "REPLACED");
    // With 3 context lines, the diff should include line4 and line6 as context
    expect(r.diff).toContain(" line4");
    expect(r.diff).toContain(" line6");
  });

  // findAllOccurrences
  it("findAllOccurrences returns empty array for empty needle", () => {
    expect(findAllOccurrences("hello", "")).toEqual([]);
  });

  it("findAllOccurrences returns all non-overlapping positions", () => {
    expect(findAllOccurrences("abcabc", "abc")).toEqual([0, 3]);
  });

  it("findAllOccurrences returns [] when needle not in haystack", () => {
    expect(findAllOccurrences("hello", "xyz")).toEqual([]);
  });

  // offsetToLine
  it("offsetToLine returns 1 for offset 0", () => {
    expect(offsetToLine("abc\ndef", 0)).toBe(1);
  });

  it("offsetToLine returns 2 for offset past first newline", () => {
    expect(offsetToLine("abc\ndef", 4)).toBe(2);
  });

  // applyEditAtOccurrence
  it("applyEditAtOccurrence applies at matchIndex=0", () => {
    const r = applyEditAtOccurrence("foo bar foo", "foo", "baz", 0);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("baz bar foo");
  });

  it("applyEditAtOccurrence applies at matchIndex=1", () => {
    const r = applyEditAtOccurrence("foo bar foo", "foo", "baz", 1);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("foo bar baz");
  });

  it("applyEditAtOccurrence returns error for out-of-bounds matchIndex", () => {
    const r = applyEditAtOccurrence("foo", "foo", "bar", 5);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/out of bounds/i);
  });

  it("applyEditAtOccurrence returns error for empty find", () => {
    const r = applyEditAtOccurrence("foo", "", "bar", 0);
    expect(r.ok).toBe(false);
  });

  it("buildUnifiedDiff includes file label in header", () => {
    const d = buildUnifiedDiff("hello\nworld\n", "world", "earth", 6, 3, "myfile.md");
    expect(d).toContain("--- a/myfile.md");
    expect(d).toContain("+++ b/myfile.md");
  });
});
