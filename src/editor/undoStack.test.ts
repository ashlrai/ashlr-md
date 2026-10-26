import { describe, expect, it } from "vitest";
import { splitLines } from "./lineDiff";
import { AgentEditHistory, AgentUndoStack } from "./undoStack";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lines = (n: number, tag = "line") =>
  Array.from({ length: n }, (_, i) => `${tag} ${i + 1}\n`).join("");

const meta = { agentId: "claude-code", label: "Tighten the intro" };

/** A clock the test moves by hand. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

describe("AgentUndoStack", () => {
  it("undoes and redoes an edit when the document is untouched", () => {
    const stack = new AgentUndoStack();
    const entry = stack.record("a\nb\n", "a\nB\n", meta);
    expect(entry).toMatchObject({ ...meta, before: "a\nb\n", after: "a\nB\n" });
    expect(entry?.diff.stats).toEqual({ hunks: 1, added: 1, removed: 1 });
    expect(stack.canUndo).toBe(true);
    expect(stack.canRedo).toBe(false);

    const undone = stack.undo("a\nB\n");
    expect(undone).toMatchObject({ ok: true, text: "a\nb\n", rebased: false });
    expect(stack.canUndo).toBe(false);
    expect(stack.peekRedo()?.id).toBe(entry?.id);

    const redone = stack.redo("a\nb\n");
    expect(redone).toMatchObject({ ok: true, text: "a\nB\n", rebased: false });
    expect(stack.undoDepth).toBe(1);
    expect(stack.redoDepth).toBe(0);
  });

  it("records nothing for an edit that changes nothing", () => {
    const stack = new AgentUndoStack();
    expect(stack.record("same", "same", meta)).toBeNull();
    expect(stack.canUndo).toBe(false);
  });

  it("says the stack is empty rather than changing anything", () => {
    const stack = new AgentUndoStack();
    expect(stack.undo("x")).toEqual({ ok: false, reason: "empty" });
    expect(stack.redo("x")).toEqual({ ok: false, reason: "empty" });
  });

  it("undoes several edits in reverse order", () => {
    const stack = new AgentUndoStack();
    const v0 = lines(10);
    const v1 = v0.replace("line 2\n", "two\n");
    const v2 = v1.replace("line 8\n", "eight\n");
    stack.record(v0, v1, { ...meta, label: "first" });
    stack.record(v1, v2, { ...meta, label: "second" });
    expect(stack.history().map((e) => e.label)).toEqual(["first", "second"]);

    const u1 = stack.undo(v2);
    expect(u1).toMatchObject({ ok: true, text: v1 });
    const u2 = stack.undo(v1);
    expect(u2).toMatchObject({ ok: true, text: v0 });
    expect(stack.redo(v0)).toMatchObject({ ok: true, text: v1 });
    expect(stack.redo(v1)).toMatchObject({ ok: true, text: v2 });
  });

  it("keeps what the user typed after the agent edit when undoing it", () => {
    const stack = new AgentUndoStack();
    const before = lines(30);
    const after = before.replace("line 15\n", "agent rewrote fifteen\n");
    stack.record(before, after, meta);

    // The user adds a heading at the top and edits line 28.
    const current = `# My notes\n${after.replace("line 28\n", "user's line\n")}`;
    const undone = stack.undo(current);
    expect(undone).toMatchObject({
      ok: true,
      rebased: true,
      text: `# My notes\n${before.replace("line 28\n", "user's line\n")}`,
    });

    // And redo puts the agent edit back, still around the user's typing.
    if (!undone.ok) throw new Error("undo failed");
    const redone = stack.redo(undone.text);
    expect(redone).toMatchObject({ ok: true, rebased: true, text: current });
  });

  it("reports a conflict, and leaves both stacks, when the user rewrote the agent's lines", () => {
    const stack = new AgentUndoStack();
    const before = lines(10);
    const after = before.replace("line 5\n", "agent five\n");
    const entry = stack.record(before, after, meta);
    const current = after.replace("agent five\n", "user five\n");
    expect(stack.undo(current)).toEqual({
      ok: false,
      reason: "conflict",
      entry,
      conflicts: ["hunk-1"],
    });
    expect(stack.undoDepth).toBe(1);
    expect(stack.redoDepth).toBe(0);
  });

  it("clears the redo stack when a new edit is recorded", () => {
    const stack = new AgentUndoStack();
    stack.record("a\n", "b\n", meta);
    stack.undo("b\n");
    expect(stack.canRedo).toBe(true);
    stack.record("a\n", "c\n", meta);
    expect(stack.canRedo).toBe(false);
    expect(stack.undoDepth).toBe(1);
  });

  it("coalesces a group's consecutive edits into one entry", () => {
    const c = clock();
    const stack = new AgentUndoStack({ now: c.now, coalesceMs: 1000 });
    const g = { ...meta, group: "session-1" };
    stack.record("a\nb\nc\n", "A\nb\nc\n", { ...g, label: "step 1" });
    c.tick(500);
    const merged = stack.record("A\nb\nc\n", "A\nb\nC\n", { ...g, label: "step 2" });
    expect(stack.undoDepth).toBe(1);
    expect(merged).toMatchObject({
      before: "a\nb\nc\n",
      after: "A\nb\nC\n",
      label: "step 2",
    });
    expect(merged?.diff.stats.hunks).toBe(2);
    expect(stack.undo("A\nb\nC\n")).toMatchObject({ ok: true, text: "a\nb\nc\n" });
  });

  it("does not coalesce across agents, groups, gaps in time or text", () => {
    const c = clock();
    const stack = new AgentUndoStack({ now: c.now, coalesceMs: 1000 });
    const g = { ...meta, group: "g" };
    stack.record("1", "2", g);
    stack.record("2", "3", { ...g, agentId: "codex" });
    stack.record("3", "4", { ...g, group: "other" });
    c.tick(5000);
    stack.record("4", "5", { ...g, group: "other" });
    stack.record("user typed", "6", { ...g, group: "other" });
    stack.record("6", "7", meta);
    stack.record("7", "8", meta);
    expect(stack.undoDepth).toBe(7);
  });

  it("drops a group's entry when its edits cancel out", () => {
    const stack = new AgentUndoStack();
    const g = { ...meta, group: "g" };
    stack.record("a", "b", g);
    expect(stack.record("b", "a", g)).toBeNull();
    expect(stack.canUndo).toBe(false);
  });

  it("keeps at most `limit` entries, dropping the oldest", () => {
    const stack = new AgentUndoStack({ limit: 3 });
    for (let i = 0; i < 5; i++)
      stack.record(`v${i}`, `v${i + 1}`, { ...meta, label: `e${i}` });
    expect(stack.history().map((e) => e.label)).toEqual(["e2", "e3", "e4"]);
  });

  it("keeps the text it holds under maxChars, but always the newest entry", () => {
    const stack = new AgentUndoStack({ maxChars: 100 });
    const big = "x".repeat(60);
    stack.record("a", "b", { ...meta, label: "small" });
    stack.record(big, `${big}y`, { ...meta, label: "big" });
    expect(stack.history().map((e) => e.label)).toEqual(["big"]);
  });

  it("keeps the bound across an undo and a redo", () => {
    const stack = new AgentUndoStack({ limit: 2 });
    stack.record("1", "2", { ...meta, label: "one" });
    stack.record("2", "3", { ...meta, label: "two" });
    stack.undo("3");
    stack.redo("2");
    expect(stack.history().map((e) => e.label)).toEqual(["one", "two"]);
    stack.record("3", "4", { ...meta, label: "three" });
    expect(stack.history().map((e) => e.label)).toEqual(["two", "three"]);
  });

  it("undoes random agent edits around random user typing", () => {
    const next = rng(31337);
    for (let round = 0; round < 100; round++) {
      const stack = new AgentUndoStack();
      const before = lines(60, `r${round}`);
      // The agent rewrites a block in lines 20..39.
      const agent = splitLines(before);
      const at = 20 + Math.floor(next() * 15);
      const removed = Math.floor(next() * 4);
      const added = Array.from(
        { length: Math.floor(next() * 4) + (removed === 0 ? 1 : 0) },
        (_, i) => `agent ${round}.${i}\n`,
      );
      agent.splice(at, removed, ...added);
      const after = agent.join("");
      stack.record(before, after, meta);

      // The user types in lines 0..9 and at the end, away from the block.
      const user = splitLines(after);
      const typedTop = Math.floor(next() * 10);
      user.splice(typedTop, 0, `typed ${round}\n`);
      user.push("typed at the end\n");
      const undone = stack.undo(user.join(""));

      const expected = splitLines(before);
      expected.splice(typedTop, 0, `typed ${round}\n`);
      expected.push("typed at the end\n");
      expect(undone).toMatchObject({ ok: true, text: expected.join("") });
    }
  });
});

describe("AgentEditHistory", () => {
  it("keeps one stack per document", () => {
    const history = new AgentEditHistory();
    history.stack("/a.md").record("1", "2", meta);
    expect(history.peek("/a.md")?.undoDepth).toBe(1);
    expect(history.peek("/b.md")).toBeUndefined();
    expect(history.stack("/b.md").undoDepth).toBe(0);
  });

  it("moves a stack with a rename and forgets a document", () => {
    const history = new AgentEditHistory();
    history.stack("/a.md").record("1", "2", meta);
    history.rename("/a.md", "/c.md");
    expect(history.peek("/a.md")).toBeUndefined();
    expect(history.peek("/c.md")?.undoDepth).toBe(1);
    history.rename("/a.md", "/d.md");
    expect(history.peek("/d.md")).toBeUndefined();
    history.forget("/c.md");
    expect(history.peek("/c.md")).toBeUndefined();
  });

  it("passes its options to every stack", () => {
    const history = new AgentEditHistory({ limit: 1 });
    const s = history.stack("/a.md");
    s.record("1", "2", meta);
    s.record("2", "3", meta);
    expect(s.undoDepth).toBe(1);
    history.clear();
    expect(history.peek("/a.md")).toBeUndefined();
  });
});
