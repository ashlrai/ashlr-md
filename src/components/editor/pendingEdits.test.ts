/**
 * The WYSIWYG editor reports a change 200 ms after the last keystroke, and
 * drops the report when it is destroyed. A change on disk in that time
 * found the tab clean, took the disk's text and remounted the editor, so
 * what was just typed was lost; a save in that time left it out.
 */

import { EditorView as ProseView } from "@milkdown/kit/prose/view";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { createAgentEditStore } from "../../editor/agentEditMode";
import {
  commitOpenProposal,
  redoAgentEdit,
  submitAgentChange,
  undoAgentEdit,
} from "../../editor/documentAgentEdit";
import { useDocumentStore } from "../../store/documentStore";
import { MarkdownEditor } from "./MarkdownEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

// The same content/key subscription as Shell: external replacements remount
// the mount-once Milkdown editor, ordinary typing does not.
function MountedEditor() {
  const { path, content, reloadNonce } = useDocumentStore();
  return createElement(MarkdownEditor, {
    key: `${path}-${reloadNonce}`,
    initialContent: content,
  });
}

describe("WYSIWYG editor: edits not reported yet", () => {
  let host: HTMLDivElement;
  let root: Root;
  let view: ProseView | null;

  beforeEach(() => {
    view = null;
    invoke.mockReset();
    invoke.mockResolvedValue("v:saved");
    vi.spyOn(ProseView.prototype, "hasFocus").mockImplementation(function (
      this: ProseView,
    ) {
      view = this;
      return true;
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    act(() => root.unmount());
    host.remove();
  });

  /** Mount on `raw` as the open, clean document /d/a.md; type `typed` at the start. */
  async function typeJustNow(raw: string, typed: string): Promise<ProseView> {
    const tab = {
      id: "t1",
      key: "/d/a.md",
      path: "/d/a.md",
      fileName: "a.md",
      content: raw,
      diskContent: raw,
      size: raw.length,
      viewMode: "edit" as const,
      isDirty: false,
      externalChange: false,
      pendingDisk: null,
      diskVersion: "v:raw",
      pendingVersion: null,
      missing: false,
      reloadNonce: 0,
      splitView: false,
    };
    useDocumentStore.setState({
      ...tab,
      tabs: [tab],
      activeId: "t1",
      error: null,
    });
    await act(async () => root.render(createElement(MountedEditor)));
    for (let i = 0; i < 40 && !view; i++) {
      await wait(25);
      document.dispatchEvent(new Event("selectionchange"));
    }
    const v = view as ProseView;
    expect(v).not.toBeNull();
    await wait(300);
    await act(async () => {
      v.dispatch(v.state.tr.insertText(typed, 1, 1));
    });
    return v;
  }

  it("a change on disk right after typing keeps the typing and offers the change", async () => {
    await typeJustNow("Hello.\n", "Mine ");
    // Within 200 ms of the keystroke: the editor has not reported it.
    await act(async () => {
      useDocumentStore.getState().handleDiskUpdate("Theirs.\n", "v:theirs");
    });
    const s = useDocumentStore.getState();
    // It used to take the disk's text: the typing was gone, with no banner.
    expect(s.content).toBe("Mine Hello.\n");
    expect(s.isDirty).toBe(true);
    expect(s.externalChange).toBe(true);
    expect(s.pendingDisk).toBe("Theirs.\n");
  });

  it("a save right after typing writes the typing", async () => {
    await typeJustNow("Hello.\n", "Mine ");
    await act(async () => {
      await useDocumentStore.getState().save();
    });
    const write = invoke.mock.calls.find((c) => c[0] === "write_markdown_file");
    expect(write?.[1]).toMatchObject({ content: "Mine Hello.\n" });
    expect(useDocumentStore.getState().isDirty).toBe(false);
  });
  async function replacedView(previous: ProseView): Promise<ProseView> {
    for (let i = 0; i < 40 && view === previous; i++) {
      await wait(25);
      document.dispatchEvent(new Event("selectionchange"));
    }
    expect(view).not.toBe(previous);
    expect(view).not.toBeNull();
    await wait(250);
    return view as ProseView;
  }

  it("auto agent writes keep pending typing and survive the next editor edit", async () => {
    const previous = await typeJustNow("Hello.\n", "Mine ");
    const store = createAgentEditStore();
    store.getState().setMode("auto");
    const nonce = useDocumentStore.getState().reloadNonce;
    await act(async () => {
      expect(
        submitAgentChange(
          {
            agentId: "probe",
            label: "replace",
            edits: [{ find: "Hello", replace: "Agent" }],
          },
          store,
        ),
      ).toMatchObject({ ok: true, status: "applied" });
    });
    expect(useDocumentStore.getState().content).toBe("Mine Agent.\n");
    expect(useDocumentStore.getState().reloadNonce).toBe(nonce + 1);
    const current = await replacedView(previous);
    await act(async () => {
      current.dispatch(current.state.tr.insertText("Next ", 1, 1));
    });
    await wait(300);
    expect(useDocumentStore.getState().content).toBe("Next Mine Agent.\n");
  });

  it("review commit, undo and redo each replace the mounted editor", async () => {
    let current = await typeJustNow("Hello.\n", "");
    const store = createAgentEditStore();
    await act(async () => {
      expect(
        submitAgentChange(
          { agentId: "probe", label: "replace", proposed: "Agent.\n" },
          store,
        ),
      ).toMatchObject({ status: "proposed" });
    });
    expect(useDocumentStore.getState().content).toBe("Hello.\n");
    expect(useDocumentStore.getState().reloadNonce).toBe(0);
    store.getState().decideAll("/d/a.md", "accepted");
    await act(async () => {
      expect(commitOpenProposal(store)).toMatchObject({ ok: true });
    });
    current = await replacedView(current);
    expect(current.state.doc.textContent).toBe("Agent.");
    await act(async () => {
      expect(undoAgentEdit(store)).toMatchObject({ ok: true });
    });
    current = await replacedView(current);
    expect(current.state.doc.textContent).toBe("Hello.");
    await act(async () => {
      expect(redoAgentEdit(store)).toMatchObject({ ok: true });
    });
    current = await replacedView(current);
    expect(current.state.doc.textContent).toBe("Agent.");
    await act(async () => {
      current.dispatch(current.state.tr.insertText("Next ", 1, 1));
    });
    await wait(300);
    expect(useDocumentStore.getState().content).toBe("Next Agent.\n");
    expect(useDocumentStore.getState().tabs[0].reloadNonce).toBe(3);
  });

  it("refuses a stale accepted proposal after flushing conflicting typing", async () => {
    const current = await typeJustNow("Hello.\n", "");
    const store = createAgentEditStore();
    submitAgentChange(
      { agentId: "probe", label: "replace", proposed: "Agent.\n" },
      store,
    );
    store.getState().decideAll("/d/a.md", "accepted");
    await act(async () => {
      current.dispatch(current.state.tr.insertText("Mine ", 1, 1));
    });
    await act(async () => {
      expect(commitOpenProposal(store)).toMatchObject({
        ok: false,
        reason: "conflict",
      });
    });
    expect(useDocumentStore.getState().content).toBe("Mine Hello.\n");
    expect(useDocumentStore.getState().reloadNonce).toBe(0);
    expect(view).toBe(current);
  });
});
