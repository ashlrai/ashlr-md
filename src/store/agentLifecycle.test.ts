import { beforeEach, expect, it, vi } from "vitest";

const { invoke, ask, pick, message } = vi.hoisted(() => ({
  invoke: vi.fn(),
  ask: vi.fn(),
  pick: vi.fn(),
  message: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask, save: pick, message }));

import { useAgentEditStore as agents } from "../editor/agentEditMode";
import { useDocumentStore as docs } from "./documentStore";

const A = "/agent/a.md",
  B = "/agent/b.md",
  C = "/agent/c.md";
const base = "a\nb\nc\n";
const meta = { agentId: "test", label: "reviewed edit" };
function seed(path: string) {
  agents.getState().record(path, "before\n", base, meta);
  agents.getState().propose({ ...meta, docKey: path, base, proposed: "a\nB\nc\n" });
  agents.getState().decideAll(path, "accepted");
}
function retained(path: string) {
  expect(agents.getState().proposals[path]).toBeDefined();
  expect(agents.getState().historyOf(path)).toHaveLength(1);
}
function forgotten(path: string) {
  expect(agents.getState().proposals[path]).toBeUndefined();
  expect(agents.getState().historyOf(path)).toEqual([]);
}
beforeEach(() => {
  docs.setState(docs.getInitialState(), true);
  for (const path of [A, B, C]) agents.getState().forgetDoc(path);
  ask.mockReset();
  pick.mockReset();
  message.mockReset();
  invoke.mockReset();
  invoke.mockImplementation(async (cmd, args) =>
    cmd === "read_markdown_file"
      ? { path: args.path, file_name: "note.md", content: base, size: base.length }
      : undefined,
  );
});
it("closing an active tab forgets its accepted proposal and history, not another tab", async () => {
  await docs.getState().openPath(B);
  seed(B);
  await docs.getState().openPath(A);
  seed(A);
  docs.getState().close();
  forgotten(A);
  retained(B);
  await docs.getState().openPath(A);
  expect(agents.getState().commit(A, base)).toMatchObject({ ok: false });
});
it("closing an inactive tab forgets only that document", async () => {
  await docs.getState().openPath(A);
  seed(A);
  const id = docs.getState().activeId!;
  await docs.getState().openPath(B);
  seed(B);
  docs.getState().closeTab(id);
  forgotten(A);
  retained(B);
});
it("canceling dirty close preserves accepted decisions and history", async () => {
  await docs.getState().openPath(A);
  seed(A);
  docs.getState().setContent("user text\n");
  ask.mockResolvedValue(false);
  docs.getState().close();
  await vi.waitFor(() => expect(ask).toHaveBeenCalled());
  expect(docs.getState().path).toBe(A);
  retained(A);
});
it("confirmed dirty close invalidates state only when it completes", async () => {
  await docs.getState().openPath(A);
  seed(A);
  docs.getState().setContent("user text\n");
  let answer!: (value: boolean) => void;
  ask.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  docs.getState().close();
  await vi.waitFor(() => expect(ask).toHaveBeenCalled());
  retained(A);
  answer(true);
  await vi.waitFor(() => expect(docs.getState().path).toBeNull());
  forgotten(A);
});
it("accepting an external reload forgets proposal/history", async () => {
  await docs.getState().openPath(A);
  seed(A);
  docs.getState().setContent("user text\n");
  docs.getState().handleDiskUpdate("disk replacement\n");
  retained(A);
  docs.getState().acceptExternalChange();
  forgotten(A);
});
it("declining a reload preserves proposal/history", async () => {
  await docs.getState().openPath(A);
  seed(A);
  docs.getState().setContent("user text\n");
  docs.getState().handleDiskUpdate("disk replacement\n");
  docs.getState().dismissExternalChange();
  retained(A);
});
it("clean automatic reload forgets state, but unchanged disk notifications do not", async () => {
  await docs.getState().openPath(A);
  seed(A);
  docs.getState().handleDiskUpdate(base);
  retained(A);
  docs.getState().handleDiskUpdate("different disk\n");
  forgotten(A);
});
it("same-document rename rebinds proposal/history and its accepted decisions", async () => {
  await docs.getState().openPath(A);
  seed(A);
  const decisions = agents.getState().proposals[A].decisions;
  await docs.getState().followRename(A, B);
  expect(docs.getState().path).toBe(B);
  forgotten(A);
  retained(B);
  expect(agents.getState().proposals[B].decisions).toEqual(decisions);
  expect(agents.getState().proposals[B].docKey).toBe(B);
});
it("refused rename to an already open document preserves both identities", async () => {
  await docs.getState().openPath(B);
  seed(B);
  await docs.getState().openPath(A);
  seed(A);
  await docs.getState().followRename(A, B);
  expect(docs.getState().path).toBe(A);
  retained(A);
  retained(B);
});
it("rename cannot inherit stale state belonging to another document at the destination", async () => {
  await docs.getState().openPath(A);
  seed(B);
  await docs.getState().followRename(A, B);
  forgotten(A);
  forgotten(B);
});
it("a pending close invalidates the renamed live identity, not only the old path", async () => {
  await docs.getState().openPath(A);
  seed(A);
  docs.getState().setContent("user text\n");
  let answer!: (value: boolean) => void;
  ask.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  docs.getState().close();
  await vi.waitFor(() => expect(ask).toHaveBeenCalled());
  await docs.getState().followRename(A, B);
  retained(B);
  forgotten(A);
  answer(true);
  await vi.waitFor(() => expect(docs.getState().path).toBeNull());
  forgotten(B);
});
it("rename refuses a destination already held under a known canonical alias", async () => {
  invoke.mockImplementation(async (cmd, args) =>
    cmd === "read_markdown_file"
      ? {
          path: args.path,
          canonical_path: args.path === B ? C : args.path,
          file_name: "note.md",
          content: base,
          size: base.length,
        }
      : undefined,
  );
  await docs.getState().openPath(B);
  seed(B);
  await docs.getState().openPath(A);
  seed(A);
  await docs.getState().followRename(A, C);
  expect(docs.getState().path).toBe(A);
  retained(A);
  retained(B);
});

it("successful Save As invalidates the old and destination identity", async () => {
  await docs.getState().openPath(A);
  seed(A);
  seed(B);
  pick.mockResolvedValue(B);
  expect(await docs.getState().saveAs()).toBeNull();
  expect(docs.getState().path).toBe(B);
  forgotten(A);
  forgotten(B);
});
it("canceling Save As preserves original proposal/history", async () => {
  await docs.getState().openPath(A);
  seed(A);
  pick.mockResolvedValue(null);
  expect(await docs.getState().saveAs()).toBe("cancelled");
  retained(A);
});
it("missing-file Close via Save As leaves no agent state under either path", async () => {
  await docs.getState().openPath(A);
  seed(A);
  docs.setState({ missing: true });
  message.mockResolvedValue("Save As…");
  pick.mockResolvedValue(B);
  docs.getState().close();
  await vi.waitFor(() => expect(docs.getState().path).toBeNull());
  forgotten(A);
  forgotten(B);
});
it("Save As invalidates an overwritten destination tab reached through an alias", async () => {
  invoke.mockImplementation(async (cmd, args) =>
    cmd === "read_markdown_file"
      ? {
          path: args.path,
          canonical_path: args.path === C ? B : args.path,
          file_name: "note.md",
          content: base,
          size: base.length,
        }
      : undefined,
  );
  await docs.getState().openPath(B);
  seed(B);
  await docs.getState().openPath(A);
  seed(A);
  pick.mockResolvedValue(C);
  expect(await docs.getState().saveAs()).toBeNull();
  expect(docs.getState().tabs).toHaveLength(1);
  expect(docs.getState().path).toBe(C);
  forgotten(A);
  forgotten(B);
  forgotten(C);
});
it("completed Save As invalidates overwritten destination even if source closed during write", async () => {
  await docs.getState().openPath(B);
  seed(B);
  await docs.getState().openPath(A);
  seed(A);
  pick.mockResolvedValue(B);
  let complete!: () => void;
  invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "read_markdown_file")
      return {
        path: args.path,
        file_name: "note.md",
        content: base,
        size: base.length,
      };
    if (cmd === "write_markdown_file")
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
  });
  const saved = docs.getState().saveAs();
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  docs.getState().close();
  expect(docs.getState().path).toBe(B);
  retained(B);
  complete();
  expect(await saved).toBeNull();
  forgotten(A);
  forgotten(B);
});
