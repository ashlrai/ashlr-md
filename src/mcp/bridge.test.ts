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
    getState: () => ({ recents: ["/a.md", "/b.md"] }),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock("../store/activityStore", () => ({
  useActivityStore: {
    getState: () => ({ watchedDir: "/vault", files: [] }),
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
  // Default: all export functions succeed.
  exportPdfMock.mockResolvedValue(undefined);
  exportDocxMock.mockResolvedValue(undefined);
  exportHtmlMock.mockResolvedValue(undefined);

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
  it("registers listeners for all six mcp:// events", () => {
    mountBridge();
    const expected = [
      "mcp://open",
      "mcp://set-content",
      "mcp://edit",
      "mcp://export",
      "mcp://review",
      "mcp://present",
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
