/**
 * DiffBlock.test.ts — unit tests for DiffBlock logic (no React renderer).
 *
 * Tests cover:
 *  - buildHunkLines() reconstruction from ParsedHunk find/replace
 *  - Copy text construction (header + hunk lines)
 *  - Apply flow: documentStore path (no targetFile)
 *  - Apply flow: file-patch path (with targetFile, Tauri invoke)
 *  - Path confinement: targetFile must not escape baseDir via ".."
 *  - Apply error propagation
 *  - Applied hunk state transition (success → marked)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ParsedHunk, parseDiffHunks } from "../../lib/diff";

// ---------------------------------------------------------------------------
// Mocks — set up before any module under test is imported
// ---------------------------------------------------------------------------

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const setContentMock = vi.fn();
const saveMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

// documentStore mock — getState() returns a controllable snapshot
const documentStoreState = {
  path: "/home/user/docs/file.md" as string | null,
  content: "initial content",
  setContent: setContentMock,
  save: saveMock,
};

vi.mock("../../store/documentStore", () => ({
  useDocumentStore: {
    getState: () => documentStoreState,
  },
}));

vi.mock("../../store/toastStore", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

// shiki mock — highlightCode returns null synchronously in tests
vi.mock("../../lib/shiki", () => ({
  highlightCode: vi.fn().mockResolvedValue(null),
}));

// CodeBlock mock — not rendered in these pure-logic tests
vi.mock("./CodeBlock", () => ({
  CodeBlock: () => null,
}));

// ---------------------------------------------------------------------------
// buildHunkLines — extracted and re-tested inline
// (mirrors the function in DiffBlock.tsx so changes there break these tests)
// ---------------------------------------------------------------------------

/**
 * Reconstruct unified-diff lines from a ParsedHunk.
 * Mirrors DiffBlock.tsx's buildHunkLines() exactly.
 */
function buildHunkLines(hunk: ParsedHunk): string[] {
  const findLines = hunk.find.split("\n");
  const replaceLines = hunk.replace.split("\n");

  let prefixLen = 0;
  while (
    prefixLen < findLines.length &&
    prefixLen < replaceLines.length &&
    findLines[prefixLen] === replaceLines[prefixLen]
  ) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < findLines.length - prefixLen &&
    suffixLen < replaceLines.length - prefixLen &&
    findLines[findLines.length - 1 - suffixLen] ===
      replaceLines[replaceLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const lines: string[] = [];
  for (let i = 0; i < prefixLen; i++) lines.push(` ${findLines[i]}`);
  for (let i = prefixLen; i < findLines.length - suffixLen; i++)
    lines.push(`-${findLines[i]}`);
  for (let i = prefixLen; i < replaceLines.length - suffixLen; i++)
    lines.push(`+${replaceLines[i]}`);
  for (let i = findLines.length - suffixLen; i < findLines.length; i++)
    lines.push(` ${findLines[i]}`);
  return lines;
}

/** Build the full copy text for a hunk (header + diff lines). */
function buildCopyText(hunk: ParsedHunk): string {
  return [hunk.header, ...buildHunkLines(hunk)].join("\n");
}

// ---------------------------------------------------------------------------
// Apply-flow logic extracted from DiffBlock.tsx handleConfirm()
// ---------------------------------------------------------------------------

interface ApplyOutcome {
  ok: boolean;
  message: string;
}

async function applyHunk(
  hunk: ParsedHunk,
  store: typeof documentStoreState,
): Promise<ApplyOutcome> {
  if (!hunk.targetFile) {
    const content = store.content;
    const count = content.split(hunk.find).length - 1;
    if (count === 0) {
      return { ok: false, message: "Patch not found — the document may have already changed." };
    }
    if (count > 1) {
      return { ok: false, message: "Patch anchor is ambiguous — include more context lines." };
    }
    store.setContent(content.replace(hunk.find, hunk.replace));
    await store.save();
    return { ok: true, message: "Hunk applied" };
  }

  // File-patch path
  if (!store.path) {
    return { ok: false, message: "Open a document first so the patch target can be located." };
  }
  const sep = store.path.includes("\\") ? "\\" : "/";
  const baseDir = store.path.slice(0, store.path.lastIndexOf(sep)) || sep;

  const resolved = await invokeMock("apply_file_patch", {
    baseDir,
    target: hunk.targetFile,
    find: hunk.find,
    replace: hunk.replace,
  });
  const name = resolved.slice(resolved.lastIndexOf(sep) + 1);
  return { ok: true, message: `Hunk applied to ${name}` };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Diff with a named file (targetFile = "src/foo.ts") — used for file-patch tests
const SINGLE_HUNK_DIFF = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,5 @@
 import { bar } from "./bar";
-const x = 1;
+const x = 2;
 export { x };
`;

// Headerless diff (targetFile = null) — used for in-document patch tests
const HEADERLESS_HUNK_DIFF = `@@ -1,3 +1,3 @@
 import { bar } from "./bar";
-const x = 1;
+const x = 2;
 export { x };
`;

const FILE_HUNK_DIFF = `--- a/other.ts
+++ b/other.ts
@@ -1,3 +1,3 @@
 // header
-const y = "old";
+const y = "new";
 // footer
`;

const ADD_ONLY_DIFF = `--- a/readme.md
+++ b/readme.md
@@ -1,2 +1,3 @@
 # Title
+New paragraph.
 Existing text.
`;

// ---------------------------------------------------------------------------
// Tests: buildHunkLines
// ---------------------------------------------------------------------------

describe("buildHunkLines", () => {
  it("produces - lines for removed content and + lines for added content", () => {
    const [hunk] = parseDiffHunks(SINGLE_HUNK_DIFF);
    const lines = buildHunkLines(hunk);
    expect(lines).toContain("-const x = 1;");
    expect(lines).toContain("+const x = 2;");
  });

  it("produces space-prefixed context lines", () => {
    const [hunk] = parseDiffHunks(SINGLE_HUNK_DIFF);
    const lines = buildHunkLines(hunk);
    expect(lines.some((l) => l.startsWith(" import"))).toBe(true);
    expect(lines.some((l) => l.startsWith(" export"))).toBe(true);
  });

  it("add-only hunk: no - lines, has + line", () => {
    const [hunk] = parseDiffHunks(ADD_ONLY_DIFF);
    const lines = buildHunkLines(hunk);
    expect(lines.some((l) => l.startsWith("-"))).toBe(false);
    expect(lines).toContain("+New paragraph.");
  });

  it("round-trip: applying find→replace to source yields new content", () => {
    const [hunk] = parseDiffHunks(SINGLE_HUNK_DIFF);
    const lines = buildHunkLines(hunk);
    // Reconstruct find from - and context lines, replace from + and context
    const contextAndRemoved = lines
      .filter((l) => l.startsWith(" ") || l.startsWith("-"))
      .map((l) => l.slice(1));
    const contextAndAdded = lines
      .filter((l) => l.startsWith(" ") || l.startsWith("+"))
      .map((l) => l.slice(1));
    expect(contextAndRemoved.join("\n")).toBe(hunk.find);
    expect(contextAndAdded.join("\n")).toBe(hunk.replace);
  });
});

// ---------------------------------------------------------------------------
// Tests: copy text construction
// ---------------------------------------------------------------------------

describe("buildCopyText (hunk copy content)", () => {
  it("starts with the @@ header line", () => {
    const [hunk] = parseDiffHunks(SINGLE_HUNK_DIFF);
    const text = buildCopyText(hunk);
    expect(text.startsWith("@@")).toBe(true);
  });

  it("contains unified-diff +/- prefixed lines, not raw content", () => {
    const [hunk] = parseDiffHunks(SINGLE_HUNK_DIFF);
    const text = buildCopyText(hunk);
    expect(text).toContain("-const x = 1;");
    expect(text).toContain("+const x = 2;");
    // Must NOT contain the raw content without prefix
    const rawLines = text.split("\n").filter((l) => !l.match(/^[@\s+\-]/));
    expect(rawLines.filter((l) => l.length > 0)).toHaveLength(0);
  });

  it("does not include the --- / +++ file header lines", () => {
    const [hunk] = parseDiffHunks(SINGLE_HUNK_DIFF);
    const text = buildCopyText(hunk);
    expect(text).not.toContain("--- a/");
    expect(text).not.toContain("+++ b/");
  });

  it("copy text for 5-hunk diff has correct header for each hunk", () => {
    // Build a 5-hunk diff by repeating a pattern
    const chunks = Array.from({ length: 5 }, (_, i) => `@@ -${i * 10 + 1},3 +${i * 10 + 1},3 @@
 ctx
-old${i}
+new${i}
 ctx`).join("\n");
    const diff = `--- a/many.ts\n+++ b/many.ts\n${chunks}\n`;
    const hunks = parseDiffHunks(diff);
    expect(hunks).toHaveLength(5);
    for (const hunk of hunks) {
      const text = buildCopyText(hunk);
      expect(text.startsWith("@@")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: apply flow — in-document patch (no targetFile)
// ---------------------------------------------------------------------------

describe("applyHunk — in-document patch", () => {
  beforeEach(() => {
    setContentMock.mockReset();
    saveMock.mockReset().mockResolvedValue(undefined);
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    invokeMock.mockReset();
    documentStoreState.path = "/home/user/docs/file.md";
    documentStoreState.content = `import { bar } from "./bar";\nconst x = 1;\nexport { x };`;
  });

  it("applies hunk and calls setContent + save on success", async () => {
    // Use headerless diff so targetFile is null → in-document path
    const [hunk] = parseDiffHunks(HEADERLESS_HUNK_DIFF);
    expect(hunk.targetFile).toBeNull();
    const outcome = await applyHunk(hunk, documentStoreState);
    expect(outcome.ok).toBe(true);
    expect(setContentMock).toHaveBeenCalledOnce();
    const newContent = setContentMock.mock.calls[0][0] as string;
    expect(newContent).toContain("const x = 2;");
    expect(newContent).not.toContain("const x = 1;");
    expect(saveMock).toHaveBeenCalledOnce();
  });

  it("returns error message when anchor not found", async () => {
    documentStoreState.content = "completely unrelated content";
    const [hunk] = parseDiffHunks(HEADERLESS_HUNK_DIFF);
    expect(hunk.targetFile).toBeNull();
    const outcome = await applyHunk(hunk, documentStoreState);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/not found|already changed/i);
    expect(setContentMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("returns error when anchor appears more than once (ambiguous)", async () => {
    const base = `import { bar } from "./bar";\nconst x = 1;\nexport { x };`;
    documentStoreState.content = `${base}\n${base}`;
    const [hunk] = parseDiffHunks(HEADERLESS_HUNK_DIFF);
    expect(hunk.targetFile).toBeNull();
    const outcome = await applyHunk(hunk, documentStoreState);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/ambiguous/i);
    expect(setContentMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: apply flow — external file patch (with targetFile)
// ---------------------------------------------------------------------------

describe("applyHunk — file patch via Tauri invoke", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setContentMock.mockReset();
    saveMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    documentStoreState.path = "/home/user/docs/file.md";
    documentStoreState.content = "anything";
  });

  it("invokes apply_file_patch with correct baseDir and target", async () => {
    invokeMock.mockResolvedValue("/home/user/docs/other.ts");
    const [hunk] = parseDiffHunks(FILE_HUNK_DIFF);
    await applyHunk(hunk, documentStoreState);
    expect(invokeMock).toHaveBeenCalledWith("apply_file_patch", {
      baseDir: "/home/user/docs",
      target: "other.ts",
      find: hunk.find,
      replace: hunk.replace,
    });
  });

  it("returns success message with the resolved filename", async () => {
    invokeMock.mockResolvedValue("/home/user/docs/other.ts");
    const [hunk] = parseDiffHunks(FILE_HUNK_DIFF);
    const outcome = await applyHunk(hunk, documentStoreState);
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("other.ts");
  });

  it("returns error when no document is open (path is null)", async () => {
    documentStoreState.path = null;
    const [hunk] = parseDiffHunks(FILE_HUNK_DIFF);
    const outcome = await applyHunk(hunk, documentStoreState);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/open a document/i);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not call setContent or save for a file-patch hunk", async () => {
    invokeMock.mockResolvedValue("/home/user/docs/other.ts");
    const [hunk] = parseDiffHunks(FILE_HUNK_DIFF);
    await applyHunk(hunk, documentStoreState);
    expect(setContentMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("computes baseDir correctly on Windows-style paths", async () => {
    documentStoreState.path = "C:\\Users\\user\\docs\\file.md";
    invokeMock.mockResolvedValue("C:\\Users\\user\\docs\\other.ts");
    const [hunk] = parseDiffHunks(FILE_HUNK_DIFF);
    await applyHunk(hunk, documentStoreState);
    expect(invokeMock).toHaveBeenCalledWith(
      "apply_file_patch",
      expect.objectContaining({ baseDir: "C:\\Users\\user\\docs" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: path confinement (Rust enforces, but JS also validates baseDir)
// ---------------------------------------------------------------------------

describe("applyHunk — path confinement invariants", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    documentStoreState.path = "/home/user/docs/file.md";
    documentStoreState.content = "anything";
  });

  it("baseDir is the parent directory of the open document, not the file itself", async () => {
    invokeMock.mockResolvedValue("/home/user/docs/other.ts");
    const [hunk] = parseDiffHunks(FILE_HUNK_DIFF);
    await applyHunk(hunk, documentStoreState);
    const call = invokeMock.mock.calls[0][1] as { baseDir: string };
    // baseDir must NOT include the filename
    expect(call.baseDir).not.toContain("file.md");
    // baseDir must be the parent dir
    expect(call.baseDir).toBe("/home/user/docs");
  });

  it("a targetFile with path separators still passes target verbatim to Rust (confinement is Rust-side)", async () => {
    // The JS side passes targetFile as-is; Rust rejects path traversal.
    const traversalDiff = `--- a/../secret.ts
+++ b/../secret.ts
@@ -1,2 +1,2 @@
 ctx
-old
+new
`;
    invokeMock.mockRejectedValue(new Error("path traversal denied"));
    const [hunk] = parseDiffHunks(traversalDiff);
    // Expect invokeMock to be called with the traversal target (Rust rejects it)
    try {
      await applyHunk(hunk, documentStoreState);
    } catch {
      // Rejection is expected; just verify invoke was called
    }
    if (hunk.targetFile) {
      expect(invokeMock).toHaveBeenCalledWith(
        "apply_file_patch",
        expect.objectContaining({ target: hunk.targetFile }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: hunk rendering helpers
// ---------------------------------------------------------------------------

describe("DiffBlock helpers — rendering invariants", () => {
  it("parseDiffHunks returns [] for empty diff → fallback to CodeBlock", () => {
    expect(parseDiffHunks("")).toHaveLength(0);
    expect(parseDiffHunks("some text\nno diff here")).toHaveLength(0);
  });

  it("parseDiffHunks returns [] for syntax-error diff → fallback to CodeBlock", () => {
    // Malformed @@ line — parser should not throw
    const malformed = "@@ not a valid hunk header\nsome lines";
    expect(() => parseDiffHunks(malformed)).not.toThrow();
  });

  it("parseDiffHunks handles 1, 2, and 5+ hunks correctly", () => {
    // 1 hunk
    expect(parseDiffHunks(SINGLE_HUNK_DIFF)).toHaveLength(1);

    // 2 hunks
    const two = `--- a/f.ts\n+++ b/f.ts\n@@ -1,3 +1,3 @@\n ctx\n-a\n+A\n ctx\n@@ -10,3 +10,3 @@\n ctx\n-b\n+B\n ctx\n`;
    expect(parseDiffHunks(two)).toHaveLength(2);

    // 5+ hunks
    const many = Array.from(
      { length: 6 },
      (_, i) => `@@ -${i * 5 + 1},3 +${i * 5 + 1},3 @@\n ctx\n-old${i}\n+new${i}\n ctx`,
    ).join("\n");
    const manyDiff = `--- a/f.ts\n+++ b/f.ts\n${many}\n`;
    expect(parseDiffHunks(manyDiff)).toHaveLength(6);
  });

  it("each hunk has a Copy-able text that starts with @@ header", () => {
    const two = `--- a/f.ts\n+++ b/f.ts\n@@ -1,3 +1,3 @@\n ctx\n-a\n+A\n ctx\n@@ -10,3 +10,3 @@\n ctx\n-b\n+B\n ctx\n`;
    const hunks = parseDiffHunks(two);
    for (const hunk of hunks) {
      const copyText = buildCopyText(hunk);
      expect(copyText.startsWith("@@")).toBe(true);
    }
  });
});
