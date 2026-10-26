import { beforeEach, describe, expect, it, vi } from "vitest";

// A document store with just what the binding uses: the open document's
// path and text, and setContent.
const doc = vi.hoisted(() => {
  const state = {
    path: null as string | null,
    content: "",
    setContent: (content: string) => {
      state.content = content;
      state.writes.push(content);
    },
    writes: [] as string[],
  };
  return state;
});
vi.mock("../store/documentStore", () => ({
  useDocumentStore: { getState: () => doc },
}));

import { registerPendingEdits } from "../lib/pendingEdits";
import { createAgentEditStore } from "./agentEditMode";
import {
  commitOpenProposal,
  liveDocument,
  NO_OPEN_DOCUMENT,
  redoAgentEdit,
  submitAgentChange,
  undoAgentEdit,
} from "./documentAgentEdit";

const PATH = "/notes/plan.md";
const meta = { agentId: "claude-code", label: "Rename the section" };
const BASE = "# Plan\n\n## Draft\n\nSome text.\n";

let store: ReturnType<typeof createAgentEditStore>;

beforeEach(() => {
  store = createAgentEditStore();
  doc.path = PATH;
  doc.content = BASE;
  doc.writes = [];
});

describe("liveDocument", () => {
  it("has the editors report what was just typed before reading", () => {
    const unregister = registerPendingEdits(() => {
      doc.content = `${BASE}typed just now\n`;
    });
    try {
      expect(liveDocument()).toEqual({ key: PATH, content: `${BASE}typed just now\n` });
    } finally {
      unregister();
    }
  });

  it("is null with no document open", () => {
    doc.path = null;
    expect(liveDocument()).toBeNull();
  });
});

describe("review mode", () => {
  it("holds the change as a proposal, writing nothing until it is committed", () => {
    const result = submitAgentChange(
      { ...meta, edits: [{ find: "## Draft", replace: "## Final" }] },
      store,
    );
    expect(result).toMatchObject({ ok: true, status: "proposed" });
    expect(doc.writes).toEqual([]);
    expect(store.getState().proposals[PATH].diff.stats.hunks).toBe(1);

    store.getState().decideAll(PATH, "accepted");
    const committed = commitOpenProposal(store);
    expect(committed).toMatchObject({ ok: true, applied: 1 });
    expect(doc.content).toBe(BASE.replace("## Draft", "## Final"));
    expect(doc.writes).toHaveLength(1);
  });

  it("commits against what the user typed while the proposal waited", () => {
    submitAgentChange(
      { ...meta, proposed: BASE.replace("Some text.", "Better text.") },
      store,
    );
    store.getState().decideAll(PATH, "accepted");
    doc.content = `Typed at the top.\n${BASE}`;
    expect(commitOpenProposal(store)).toMatchObject({ ok: true, rebased: true });
    expect(doc.content).toBe(
      `Typed at the top.\n${BASE.replace("Some text.", "Better text.")}`,
    );
  });

  it("writes nothing when the user accepted nothing", () => {
    submitAgentChange({ ...meta, proposed: `${BASE}More.\n` }, store);
    expect(commitOpenProposal(store)).toMatchObject({ ok: true, applied: 0 });
    expect(doc.writes).toEqual([]);
  });

  it("passes on the reason a change cannot be proposed", () => {
    expect(
      submitAgentChange({ ...meta, edits: [{ find: "missing", replace: "x" }] }, store),
    ).toMatchObject({ ok: false, editIndex: 0 });
  });
});

describe("auto mode", () => {
  it("writes the change at once and records it for undo", () => {
    store.getState().setMode("auto");
    const result = submitAgentChange(
      { ...meta, proposed: BASE.replace("Some text.", "Other text.") },
      store,
    );
    expect(result).toMatchObject({ ok: true, status: "applied" });
    expect(doc.content).toBe(BASE.replace("Some text.", "Other text."));
    expect(store.getState().proposals[PATH]).toBeUndefined();
    expect(store.getState().depth[PATH]).toEqual({ undo: 1, redo: 0 });

    expect(undoAgentEdit(store)).toMatchObject({ ok: true });
    expect(doc.content).toBe(BASE);
    expect(redoAgentEdit(store)).toMatchObject({ ok: true });
    expect(doc.content).toBe(BASE.replace("Some text.", "Other text."));
  });
});

describe("undo and redo", () => {
  it("undoes an agent edit while keeping the user's typing", () => {
    store.getState().setMode("auto");
    submitAgentChange(
      { ...meta, edits: [{ find: "## Draft", replace: "## Final" }] },
      store,
    );
    doc.content = `${doc.content}A line the user typed.\n`;
    expect(undoAgentEdit(store)).toMatchObject({ ok: true, rebased: true });
    expect(doc.content).toBe(`${BASE}A line the user typed.\n`);
  });

  it("writes nothing on a conflict", () => {
    store.getState().setMode("auto");
    submitAgentChange(
      { ...meta, edits: [{ find: "## Draft", replace: "## Final" }] },
      store,
    );
    doc.content = doc.content.replace("## Final", "## Mine");
    const writes = doc.writes.length;
    expect(undoAgentEdit(store)).toMatchObject({ ok: false, reason: "conflict" });
    expect(doc.writes).toHaveLength(writes);
  });

  it("is empty when there is nothing to undo", () => {
    expect(undoAgentEdit(store)).toEqual({ ok: false, reason: "empty" });
    expect(redoAgentEdit(store)).toEqual({ ok: false, reason: "empty" });
  });
});

describe("no document open", () => {
  beforeEach(() => {
    doc.path = null;
  });

  it("refuses every step", () => {
    expect(submitAgentChange({ ...meta, proposed: "x" }, store)).toEqual({
      ok: false,
      error: NO_OPEN_DOCUMENT,
    });
    expect(commitOpenProposal(store)).toEqual({
      ok: false,
      reason: "no-document",
      error: NO_OPEN_DOCUMENT,
    });
    expect(undoAgentEdit(store)).toEqual({ ok: false, reason: "empty" });
    expect(doc.writes).toEqual([]);
  });
});
