import { beforeEach, describe, expect, it } from "vitest";
import { createAgentEditStore } from "./agentEditMode";

const DOC = "/notes/plan.md";
const meta = { agentId: "claude-code", label: "Polish the plan" };

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");

const base = lines(30);
const proposed = base
  .replace("line 3\n", "THREE\n")
  .replace("line 15\n", "FIFTEEN\n")
  .replace("line 27\n", "TWENTY-SEVEN\n");

let store: ReturnType<typeof createAgentEditStore>;

beforeEach(() => {
  store = createAgentEditStore({ now: () => 42 });
});

function propose() {
  const result = store.getState().propose({ docKey: DOC, base, proposed, ...meta });
  if (!result.ok) throw new Error(result.error);
  return result.proposal;
}

describe("propose", () => {
  it("makes a proposal with every hunk pending", () => {
    const p = propose();
    expect(p).toMatchObject({ docKey: DOC, ...meta, createdAt: 42 });
    expect(p.diff.stats).toEqual({ hunks: 3, added: 3, removed: 3 });
    expect(p.decisions).toEqual({
      "hunk-1": "pending",
      "hunk-2": "pending",
      "hunk-3": "pending",
    });
    expect(store.getState().proposals[DOC]).toBe(p);
  });

  it("makes a proposal from find/replace edits", () => {
    const result = store.getState().propose({
      docKey: DOC,
      base,
      edits: [{ find: "line 3\n", replace: "THREE\n" }],
      ...meta,
    });
    expect(result.ok && result.proposal.diff.proposed).toBe(
      base.replace("line 3\n", "THREE\n"),
    );
  });

  it("refuses edits that do not apply, naming the edit", () => {
    const result = store.getState().propose({
      docKey: DOC,
      base,
      edits: [{ find: "not in the document", replace: "x" }],
      ...meta,
    });
    expect(result).toMatchObject({ ok: false, editIndex: 0 });
    expect(store.getState().proposals[DOC]).toBeUndefined();
  });

  it("refuses a proposal that changes nothing", () => {
    expect(
      store.getState().propose({ docKey: DOC, base, proposed: base, ...meta }),
    ).toMatchObject({ ok: false, error: "The proposal does not change the document." });
  });

  it("writes an LF proposal in a CRLF document's breaks", () => {
    const crlf = "a\r\nb\r\nc\r\n";
    const result = store
      .getState()
      .propose({ docKey: DOC, base: crlf, proposed: "a\nB\nc\n", ...meta });
    expect(result.ok && result.proposal.diff.proposed).toBe("a\r\nB\r\nc\r\n");
    expect(result.ok && result.proposal.diff.stats.hunks).toBe(1);
  });

  it("replaces a document's pending proposal", () => {
    const first = propose();
    const second = propose();
    expect(second.id).not.toBe(first.id);
    expect(store.getState().proposals[DOC].id).toBe(second.id);
  });
});

describe("decide and preview", () => {
  it("previews the base with the accepted hunks", () => {
    propose();
    const s = store.getState();
    expect(s.preview(DOC)).toBe(base);
    expect(s.decide(DOC, "hunk-2", "accepted")).toBe(true);
    expect(store.getState().preview(DOC)).toBe(base.replace("line 15\n", "FIFTEEN\n"));
    store.getState().decideAll(DOC, "accepted");
    expect(store.getState().preview(DOC)).toBe(proposed);
  });

  it("refuses an unknown document or hunk", () => {
    const s = store.getState();
    expect(s.decide(DOC, "hunk-1", "accepted")).toBe(false);
    expect(s.decideAll(DOC, "accepted")).toBe(false);
    expect(s.preview(DOC)).toBeNull();
    propose();
    expect(store.getState().decide(DOC, "hunk-99", "accepted")).toBe(false);
  });
});

describe("commit", () => {
  it("writes only the accepted hunks, as one undoable edit", () => {
    propose();
    const s = store.getState();
    s.decide(DOC, "hunk-1", "accepted");
    s.decide(DOC, "hunk-2", "rejected");
    s.decide(DOC, "hunk-3", "accepted");
    const result = store.getState().commit(DOC, base);
    const expected = base
      .replace("line 3\n", "THREE\n")
      .replace("line 27\n", "TWENTY-SEVEN\n");
    expect(result).toMatchObject({
      ok: true,
      text: expected,
      applied: 2,
      rebased: false,
    });
    expect(result.ok && result.entry).toMatchObject({ before: base, after: expected });
    expect(store.getState().proposals[DOC]).toBeUndefined();
    expect(store.getState().depth[DOC]).toEqual({ undo: 1, redo: 0 });

    const undone = store.getState().undo(DOC, expected);
    expect(undone).toMatchObject({ ok: true, text: base });
    expect(store.getState().depth[DOC]).toEqual({ undo: 0, redo: 1 });
    expect(store.getState().redo(DOC, base)).toMatchObject({
      ok: true,
      text: expected,
    });
  });

  it("places the accepted hunks in a document the user changed since", () => {
    propose();
    store.getState().decideAll(DOC, "accepted");
    const current = `# Added by the user\n${base.replace("line 20\n", "user twenty\n")}`;
    const result = store.getState().commit(DOC, current);
    const expected = `# Added by the user\n${proposed.replace("line 20\n", "user twenty\n")}`;
    expect(result).toMatchObject({
      ok: true,
      text: expected,
      rebased: true,
      applied: 3,
    });
    // The undo restores the user's version, not the proposal's base.
    expect(store.getState().undo(DOC, expected)).toMatchObject({
      ok: true,
      text: current,
    });
  });

  it("keeps the proposal on a conflict, and commits once the hunk is rejected", () => {
    propose();
    store.getState().decideAll(DOC, "accepted");
    const current = base.replace("line 15\n", "the user rewrote fifteen\n");
    const conflict = store.getState().commit(DOC, current);
    expect(conflict).toMatchObject({
      ok: false,
      reason: "conflict",
      conflicts: ["hunk-2"],
    });
    expect(!conflict.ok && conflict.error).toMatch(
      /^One accepted change no longer matches/,
    );
    expect(store.getState().proposals[DOC]).toBeDefined();
    expect(store.getState().depth[DOC]).toBeUndefined();

    store.getState().decide(DOC, "hunk-2", "rejected");
    const result = store.getState().commit(DOC, current);
    expect(result).toMatchObject({
      ok: true,
      text: current
        .replace("line 3\n", "THREE\n")
        .replace("line 27\n", "TWENTY-SEVEN\n"),
    });
  });

  it("says how many accepted changes conflict", () => {
    propose();
    store.getState().decideAll(DOC, "accepted");
    const current = base.replace("line 3\n", "x\n").replace("line 15\n", "y\n");
    const result = store.getState().commit(DOC, current);
    expect(!result.ok && result.error).toMatch(/^2 accepted changes no longer match/);
  });

  it("drops the proposal, writing nothing, when nothing was accepted", () => {
    propose();
    store.getState().decide(DOC, "hunk-1", "rejected");
    expect(store.getState().commit(DOC, base)).toEqual({
      ok: true,
      text: base,
      entry: null,
      applied: 0,
      rebased: false,
    });
    expect(store.getState().proposals[DOC]).toBeUndefined();
    expect(store.getState().depth[DOC]).toBeUndefined();
  });

  it("refuses a document with no proposal", () => {
    expect(store.getState().commit(DOC, base)).toMatchObject({
      ok: false,
      reason: "no-proposal",
    });
  });

  it("coalesces committed proposals of one group", () => {
    const g = { ...meta, group: "task-7" };
    const s = store.getState();
    const r1 = s.propose({
      docKey: DOC,
      base,
      proposed: base.replace("line 1\n", "ONE\n"),
      ...g,
    });
    expect(r1.ok).toBe(true);
    store.getState().decideAll(DOC, "accepted");
    const c1 = store.getState().commit(DOC, base);
    if (!c1.ok) throw new Error("commit failed");
    store.getState().propose({
      docKey: DOC,
      base: c1.text,
      proposed: c1.text.replace("line 2\n", "TWO\n"),
      ...g,
    });
    store.getState().decideAll(DOC, "accepted");
    const c2 = store.getState().commit(DOC, c1.text);
    if (!c2.ok) throw new Error("commit failed");
    expect(store.getState().depth[DOC]).toEqual({ undo: 1, redo: 0 });
    expect(store.getState().undo(DOC, c2.text)).toMatchObject({ ok: true, text: base });
  });
});

describe("record, undo and redo", () => {
  it("records an edit written without review", () => {
    const after = base.replace("line 9\n", "nine\n");
    const entry = store.getState().record(DOC, base, after, meta);
    expect(entry).toMatchObject({ before: base, after });
    expect(store.getState().depth[DOC]).toEqual({ undo: 1, redo: 0 });
    expect(store.getState().historyOf(DOC)).toHaveLength(1);
    expect(store.getState().record(DOC, after, after, meta)).toBeNull();
  });

  it("answers empty for a document with no history", () => {
    expect(store.getState().undo(DOC, base)).toEqual({ ok: false, reason: "empty" });
    expect(store.getState().redo(DOC, base)).toEqual({ ok: false, reason: "empty" });
    expect(store.getState().historyOf(DOC)).toEqual([]);
  });

  it("leaves the depth alone on a conflict", () => {
    const after = base.replace("line 9\n", "nine\n");
    store.getState().record(DOC, base, after, meta);
    const outcome = store.getState().undo(DOC, after.replace("nine\n", "NINE!\n"));
    expect(outcome).toMatchObject({ ok: false, reason: "conflict" });
    expect(store.getState().depth[DOC]).toEqual({ undo: 1, redo: 0 });
  });
});

describe("documents", () => {
  it("moves a proposal and its history with a rename", () => {
    store.getState().record(DOC, "a", "b", meta);
    propose();
    store.getState().renameDoc(DOC, "/notes/renamed.md");
    const s = store.getState();
    expect(s.proposals[DOC]).toBeUndefined();
    expect(s.proposals["/notes/renamed.md"].docKey).toBe("/notes/renamed.md");
    expect(s.depth[DOC]).toBeUndefined();
    expect(s.depth["/notes/renamed.md"]).toEqual({ undo: 1, redo: 0 });
    expect(s.undo("/notes/renamed.md", "b")).toMatchObject({ ok: true, text: "a" });
  });

  it("forgets a document's proposal and history", () => {
    store.getState().record(DOC, "a", "b", meta);
    propose();
    store.getState().forgetDoc(DOC);
    expect(store.getState().proposals[DOC]).toBeUndefined();
    expect(store.getState().depth[DOC]).toBeUndefined();
    expect(store.getState().undo(DOC, "b")).toEqual({ ok: false, reason: "empty" });
  });

  it("keeps each document's proposal and history apart", () => {
    propose();
    store.getState().record("/other.md", "x", "y", meta);
    expect(Object.keys(store.getState().proposals)).toEqual([DOC]);
    expect(Object.keys(store.getState().depth)).toEqual(["/other.md"]);
    store.getState().discard(DOC);
    expect(store.getState().proposals).toEqual({});
  });

  it("switches between review and auto mode", () => {
    expect(store.getState().mode).toBe("review");
    store.getState().setMode("auto");
    expect(store.getState().mode).toBe("auto");
  });
});
