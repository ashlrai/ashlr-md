import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type Handler = (e: { payload: number }) => void;
let handler: Handler | null = null;
const listenMock = vi.fn(async (_event: string, h: Handler) => {
  handler = h;
  return () => {
    handler = null;
  };
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, h: Handler) => listenMock(event, h),
}));

const messageMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: (...args: unknown[]) => messageMock(...args),
  ask: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../store/recentStore", () => ({
  isMissingFileError: () => false,
  useRecentStore: { getState: () => ({ add: vi.fn(), remove: vi.fn() }) },
}));

import { type Tab, useDocumentStore } from "../store/documentStore";
import {
  CLOSE_DISCARD,
  CLOSE_REQUEST_EVENT,
  CLOSE_SAVE_ALL,
  choiceFromAnswer,
  closePromptText,
  decideClose,
  installCloseGuard,
  unsavedTabs,
} from "./closeGuard";

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    key: `/d/${id}.md`,
    path: `/d/${id}.md`,
    fileName: `${id}.md`,
    content: "x",
    diskContent: "x",
    size: 1,
    viewMode: "read",
    isDirty: false,
    externalChange: false,
    pendingDisk: null,
    diskVersion: null,
    pendingVersion: null,
    missing: false,
    reloadNonce: 0,
    splitView: false,
    ...over,
  };
}

function load(tabs: Tab[], activeId: string) {
  const a = tabs.find((t) => t.id === activeId) as Tab;
  useDocumentStore.setState({
    tabs,
    activeId,
    path: a.path,
    fileName: a.fileName,
    content: a.content,
    diskContent: a.diskContent,
    isDirty: a.isDirty,
    missing: a.missing,
    diskVersion: null,
  });
}

const calls = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  messageMock.mockReset();
  listenMock.mockClear();
  handler = null;
  load([tab("a")], "a");
});

describe("unsavedTabs", () => {
  it("reads the active tab from the live mirror and the others from the tab", () => {
    load([tab("a"), tab("b", { isDirty: true }), tab("c", { missing: true })], "a");
    useDocumentStore.setState({ isDirty: true, content: "edited" });
    expect(unsavedTabs(useDocumentStore.getState()).map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    useDocumentStore.setState({ isDirty: false });
    expect(unsavedTabs(useDocumentStore.getState()).map((t) => t.id)).toEqual([
      "b",
      "c",
    ]);
  });
});

describe("closePromptText / choiceFromAnswer", () => {
  it("names one file, or counts many and lists the first five", () => {
    expect(closePromptText(["a.md"])).toBe(
      '"a.md" has unsaved changes. Save them before closing?',
    );
    const many = closePromptText(["1", "2", "3", "4", "5", "6", "7"]);
    expect(many).toContain("7 documents");
    expect(many).toContain('"5" and 2 more');
    expect(many).not.toContain('"6"');
  });

  it("maps button labels and the plain Yes/No answers", () => {
    expect(choiceFromAnswer(CLOSE_SAVE_ALL)).toBe("save");
    expect(choiceFromAnswer("Yes")).toBe("save");
    expect(choiceFromAnswer(CLOSE_DISCARD)).toBe("discard");
    expect(choiceFromAnswer("No")).toBe("discard");
    expect(choiceFromAnswer("Cancel")).toBe("cancel");
    expect(choiceFromAnswer("anything else")).toBe("cancel");
  });
});

describe("decideClose", () => {
  const base = (unsaved: { id: string; fileName: string }[][]) => {
    let n = 0;
    return {
      unsaved: () => unsaved[Math.min(n++, unsaved.length - 1)],
      ask: vi.fn(),
      save: vi.fn(async () => null as string | null),
      discard: vi.fn(),
    };
  };
  const one = [{ id: "a", fileName: "a.md" }];

  it("closes without asking when nothing is unsaved", async () => {
    const d = base([[]]);
    expect(await decideClose(d)).toBe("close");
    expect(d.ask).not.toHaveBeenCalled();
  });

  it("cancel keeps the window and saves nothing", async () => {
    const d = base([one]);
    d.ask.mockResolvedValue("cancel");
    expect(await decideClose(d)).toBe("cancel");
    expect(d.save).not.toHaveBeenCalled();
    expect(d.discard).not.toHaveBeenCalled();
  });

  it("discard closes and forgets the kept copy", async () => {
    const d = base([one]);
    d.ask.mockResolvedValue("discard");
    expect(await decideClose(d)).toBe("close");
    expect(d.discard).toHaveBeenCalledOnce();
    expect(d.save).not.toHaveBeenCalled();
  });

  it("save all saves each tab, then closes", async () => {
    const two = [...one, { id: "b", fileName: "b.md" }];
    const d = base([two, []]);
    d.ask.mockResolvedValue("save");
    expect(await decideClose(d)).toBe("close");
    expect(d.save.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("a save that fails keeps the window open and stops", async () => {
    const two = [...one, { id: "b", fileName: "b.md" }];
    const d = base([two]);
    d.ask.mockResolvedValue("save");
    d.save.mockResolvedValueOnce("disk full");
    expect(await decideClose(d)).toBe("cancel");
    expect(d.save).toHaveBeenCalledOnce();
  });

  it("an edit made during the saves keeps the window open", async () => {
    const d = base([one, one]);
    d.ask.mockResolvedValue("save");
    expect(await decideClose(d)).toBe("cancel");
  });

  it("a dialog that throws rejects (the caller then closes)", async () => {
    const d = base([one]);
    d.ask.mockRejectedValue(new Error("no dialog"));
    await expect(decideClose(d)).rejects.toThrow("no dialog");
  });
});

describe("installCloseGuard", () => {
  it("reports unsaved state to Rust only once it listens, and on change", async () => {
    const stop = await installCloseGuard();
    expect(listenMock).toHaveBeenCalledWith(CLOSE_REQUEST_EVENT, expect.any(Function));
    expect(calls("close_guard_set_unsaved")).toEqual([
      ["close_guard_set_unsaved", { unsaved: false }],
    ]);
    useDocumentStore.getState().setContent("edited");
    useDocumentStore.getState().setContent("edited more");
    expect(calls("close_guard_set_unsaved").map((c) => c[1])).toEqual([
      { unsaved: false },
      { unsaved: true },
    ]);
    stop();
    expect(calls("close_guard_set_unsaved").at(-1)?.[1]).toEqual({ unsaved: false });
  });

  it("acknowledges a request at once, then answers with the user's choice", async () => {
    let answer: (v: string) => void = () => {};
    messageMock.mockReturnValue(new Promise<string>((r) => (answer = r)));
    const discard = vi.fn();
    const stop = await installCloseGuard({ discard });
    useDocumentStore.getState().setContent("edited");
    handler?.({ payload: 4 });
    expect(calls("close_guard_ack")).toEqual([["close_guard_ack", { id: 4 }]]);
    // Asked again while the prompt is up: acknowledged, no second prompt.
    handler?.({ payload: 5 });
    await flush();
    expect(calls("close_guard_ack").length).toBe(2);
    expect(messageMock).toHaveBeenCalledOnce();
    answer(CLOSE_DISCARD);
    await flush();
    await flush();
    expect(discard).toHaveBeenCalledOnce();
    expect(calls("close_guard_resolve")).toEqual([
      ["close_guard_resolve", { id: 5, close: true }],
    ]);
    stop();
  });

  it("cancel answers close: false", async () => {
    messageMock.mockResolvedValue("Cancel");
    const stop = await installCloseGuard();
    useDocumentStore.getState().setContent("edited");
    handler?.({ payload: 1 });
    await flush();
    await flush();
    expect(calls("close_guard_resolve")).toEqual([
      ["close_guard_resolve", { id: 1, close: false }],
    ]);
    stop();
  });

  it("a guard that throws answers close, as the window closed before", async () => {
    messageMock.mockRejectedValue(new Error("dialog plugin missing"));
    const stop = await installCloseGuard();
    useDocumentStore.getState().setContent("edited");
    handler?.({ payload: 9 });
    await flush();
    await flush();
    expect(calls("close_guard_resolve")).toEqual([
      ["close_guard_resolve", { id: 9, close: true }],
    ]);
    stop();
  });

  it("save all writes every unsaved tab, then answers close", async () => {
    load([tab("a"), tab("b", { isDirty: true, content: "b2" })], "a");
    messageMock.mockResolvedValue(CLOSE_SAVE_ALL);
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "write_markdown_file" ? "v2" : undefined,
    );
    const stop = await installCloseGuard();
    useDocumentStore.getState().setContent("a2");
    handler?.({ payload: 2 });
    for (let i = 0; i < 6; i++) await flush();
    expect(
      calls("write_markdown_file").map((c) => (c[1] as { path: string }).path),
    ).toEqual(["/d/a.md", "/d/b.md"]);
    expect(calls("close_guard_resolve")).toEqual([
      ["close_guard_resolve", { id: 2, close: true }],
    ]);
    stop();
  });

  it("does not report unsaved state when it cannot listen", async () => {
    listenMock.mockRejectedValueOnce(new Error("no event bridge"));
    await installCloseGuard();
    useDocumentStore.getState().setContent("edited");
    expect(calls("close_guard_set_unsaved")).toEqual([]);
  });
});
