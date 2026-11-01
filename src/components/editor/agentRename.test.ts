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

function MountedEditor() {
  const { path, content, reloadNonce } = useDocumentStore();
  return createElement(MarkdownEditor, {
    key: `${path}-${reloadNonce}`,
    initialContent: content,
  });
}

describe("WYSIWYG agent document identity", () => {
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

  it("rename flushes actual pending Milkdown typing before remounting", async () => {
    await typeJustNow("Hello.\n", "Mine ");
    invoke.mockImplementation(async (cmd, args) =>
      cmd === "read_markdown_file"
        ? { path: args.path, file_name: "b.md", content: "Hello.\n", size: 7 }
        : undefined,
    );
    await act(async () => {
      await useDocumentStore.getState().followRename("/d/a.md", "/d/b.md");
    });
    expect(useDocumentStore.getState().path).toBe("/d/b.md");
    expect(useDocumentStore.getState().content).toBe("Mine Hello.\n");
    expect(useDocumentStore.getState().isDirty).toBe(true);
    await wait(300);
    expect(useDocumentStore.getState().content).toBe("Mine Hello.\n");
  });
});
