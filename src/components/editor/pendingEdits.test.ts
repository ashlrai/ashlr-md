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

import { useDocumentStore } from "../../store/documentStore";
import { MarkdownEditor } from "./MarkdownEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

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
    await act(async () =>
      root.render(createElement(MarkdownEditor, { initialContent: raw })),
    );
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
});
