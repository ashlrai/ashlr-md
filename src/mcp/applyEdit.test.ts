import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri bridge so documentStore runs in plain happy-dom.
const invokeMock = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("../store/recentStore", () => ({
  useRecentStore: { getState: () => ({ add: vi.fn() }) },
}));

import { useDocumentStore } from "../store/documentStore";
import {
  applyEditAtOccurrence,
  applyUniqueEdit,
  computeStreamEditDiff,
  FIND_NOT_FOUND,
  offsetToLine,
} from "./applyEdit";

describe("applyUniqueEdit — exact, unique find/replace contract", () => {
  // These mirror the Rust `apply_unique_edit` unit tests one-for-one so the two
  // implementations stay in lockstep.
  it("replaces a unique match", () => {
    const r = applyUniqueEdit(
      "# Title\n\nHello world.\n",
      "Hello world.",
      "Hello there.",
    );
    expect(r.ok).toBe(true);
    expect(r.replaced).toBe(1);
    expect(r.content).toBe("# Title\n\nHello there.\n");
  });

  it("errors when find is missing", () => {
    const r = applyUniqueEdit("abc", "xyz", "q");
    expect(r.ok).toBe(false);
    expect(r.replaced).toBe(0);
    expect(r.error).toMatch(/not found/);
  });

  // "not found" used to be the whole answer, so an agent retried the same
  // text. Every edit that can miss now says to copy `find` from the live
  // document, and an out-of-range matchIndex names the range to use.
  it("a missed find says how to get it right, in every edit", () => {
    expect(FIND_NOT_FOUND).toContain("get_current_content");
    expect(applyUniqueEdit("abc", "xyz", "q").error).toBe(FIND_NOT_FOUND);
    expect(computeStreamEditDiff("abc", "xyz", "q").error).toBe(FIND_NOT_FOUND);
    expect(applyEditAtOccurrence("abc", "xyz", "q", 0).error).toBe(FIND_NOT_FOUND);
    expect(applyEditAtOccurrence("a b a", "a", "q", 3).error).toBe(
      "matchIndex 3 out of bounds: document has 2 occurrence(s). Use a match_index " +
        "from 0 to 1, or call stream_edit again to see the candidates.",
    );
  });

  it("matches an LF find in a CRLF document and writes CRLF", () => {
    // An agent's find text has LF breaks; in a CRLF file it was "not
    // found", and an LF replacement added LF lines to it.
    const doc = "\uFEFF# T\r\n\r\nOne\r\nTwo\r\n";
    const r = applyUniqueEdit(doc, "One\nTwo", "Uno\nDos\nTres");
    expect(r).toEqual({
      ok: true,
      replaced: 1,
      content: "\uFEFF# T\r\n\r\nUno\r\nDos\r\nTres\r\n",
    });
    // A CRLF find matches LF text too, and the replacement takes LF there.
    expect(applyUniqueEdit("a\nb\n", "a\r\nb", "x\r\ny").content).toBe("x\ny\n");
    // Matches are counted with either break, and the rest is exact.
    expect(applyUniqueEdit("a\r\nb a\nb", "a\nb", "q").error).toMatch(
      /not unique \(2 matches\)/,
    );
    expect(applyUniqueEdit("One\r\nTwo", "one\ntwo", "q").error).toBe(FIND_NOT_FOUND);
    // A match does not start inside a CRLF break.
    expect(applyUniqueEdit("a\r\nb\r\n", "\nb", "\nc").content).toBe("a\r\nc\r\n");
  });

  it("keeps a mixed document's line breaks where it edits", () => {
    const doc = "lf one\nlf two\ncr one\r\ncr two\r\n";
    expect(applyUniqueEdit(doc, "cr one\ncr", "x\ny").content).toBe(
      "lf one\nlf two\nx\r\ny two\r\n",
    );
    expect(applyUniqueEdit(doc, "lf one\n", "a\nb\n").content).toBe(
      "a\nb\nlf two\ncr one\r\ncr two\r\n",
    );
    expect(applyEditAtOccurrence(doc, "one\n", "1\n", 1).content).toBe(
      "lf one\nlf two\ncr 1\r\ncr two\r\n",
    );
  });

  it("previews an LF find in a CRLF document", () => {
    const r = computeStreamEditDiff("a\r\nb\r\nc\r\n", "b\nc", "B\nC", 0);
    expect(r.ok).toBe(true);
    expect(r.matchCount).toBe(1);
    expect(r.diff).toBe(
      "--- a/document\n+++ b/document\n@@ -2,2 +2,2 @@\n-b\r\n-c\r\n+B\r\n+C\r\n",
    );
  });

  it("errors when find is not unique and reports the count", () => {
    const r = applyUniqueEdit("the cat sat on the mat", "the", "a");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not unique/);
    expect(r.error).toMatch(/2/);
  });

  it("rejects an empty find", () => {
    const r = applyUniqueEdit("anything", "", "x");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must not be empty/);
  });

  it("replaces only the single unique multi-line anchor", () => {
    const r = applyUniqueEdit(
      "line one\nUNIQUE ANCHOR\nline three",
      "UNIQUE ANCHOR",
      "replaced",
    );
    expect(r.ok).toBe(true);
    expect(r.content).toBe("line one\nreplaced\nline three");
  });

  it("counts non-overlapping matches like Rust str::matches", () => {
    // "aa" in "aaaa" is 2 non-overlapping matches → not unique.
    const r = applyUniqueEdit("aaaa", "aa", "b");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not unique/);
    expect(r.error).toMatch(/2/);
  });
});

/**
 * Reproduce the bug's core: the server-side mirror is 200 ms-debounced, so right
 * after the user types it is STALE. The fix applies the edit against the LIVE
 * documentStore content. These tests simulate the bridge's `mcp://edit` handler
 * logic (read live content → applyUniqueEdit → setContent) and assert the edit
 * lands on the live text and does NOT clobber the user's just-typed edits.
 */
describe("mcp://edit applies against the LIVE document, not a stale mirror", () => {
  beforeEach(() => {
    useDocumentStore.setState({
      path: "/a.md",
      fileName: "a.md",
      content: "",
      diskContent: "",
      isDirty: false,
      tabs: [],
      activeId: null,
    });
    invokeMock.mockClear();
  });

  /** The exact logic the bridge runs for an mcp://edit event. */
  function handleEdit(find: string, replace: string) {
    const live = useDocumentStore.getState().content;
    const outcome = applyUniqueEdit(live, find, replace);
    if (outcome.ok && outcome.content !== undefined) {
      useDocumentStore.getState().setContent(outcome.content);
    }
    return outcome;
  }

  it("edits text the user typed AFTER the last debounced sync (stale-window closed)", () => {
    // Imagine the server mirror was last synced when the doc was "draft".
    const staleMirror = "draft";
    // The user then types more; the LIVE store now holds the newer text, but the
    // 200 ms debounce hasn't fired so `staleMirror` is what the OLD code saw.
    useDocumentStore.getState().setContent("draft — just typed this sentence.");

    // Old behavior: applying against the stale mirror can't find the new text.
    expect(applyUniqueEdit(staleMirror, "just typed this sentence.", "edited").ok).toBe(
      false,
    );

    // New behavior: the bridge applies against LIVE content and succeeds.
    const outcome = handleEdit("just typed this sentence.", "edited by agent");
    expect(outcome.ok).toBe(true);
    expect(useDocumentStore.getState().content).toBe("draft — edited by agent");
  });

  it("does not clobber the user's just-typed edits (no full stale-content overwrite)", () => {
    // User's live doc carries fresh content the stale mirror never saw.
    useDocumentStore
      .getState()
      .setContent("Intro paragraph.\n\nTYPO heer.\n\nMore fresh text.");

    handleEdit("TYPO heer.", "Fixed here.");

    const result = useDocumentStore.getState().content;
    // The targeted fix applied…
    expect(result).toBe("Intro paragraph.\n\nFixed here.\n\nMore fresh text.");
    // …and the user's surrounding fresh text survived (would be lost if a stale
    // full-document snapshot had been pushed back).
    expect(result).toContain("Intro paragraph.");
    expect(result).toContain("More fresh text.");
  });
});

describe("line numbers follow CommonMark line breaks", () => {
  it("counts a lone CR, LF and CRLF as one break each", () => {
    const doc = "a\rb\r\nc\nd";
    expect(offsetToLine(doc, doc.indexOf("a"))).toBe(1);
    expect(offsetToLine(doc, doc.indexOf("b"))).toBe(2);
    expect(offsetToLine(doc, doc.indexOf("c"))).toBe(3);
    expect(offsetToLine(doc, doc.indexOf("d"))).toBe(4);
  });

  it("numbers a stream_edit candidate in an old Mac file by its line", () => {
    const r = computeStreamEditDiff("one\rtwo x\rthree x\r", "x", "y", 0);
    expect(r.candidates?.map((c) => c.startLine)).toEqual([2, 3]);
    expect(r.diff).toBe(
      "--- a/document\n+++ b/document\n@@ -2,1 +2,1 @@\n-two x\n+two y\n",
    );
  });
});
