/**
 * Dragging an image onto another in the WYSIWYG editor reorders the images
 * in the Markdown (lib/milkdownImageDragDrop.ts). The new order went to the
 * document store only, so the editor kept the old one, and the next typed
 * edit wrote it back.
 */

import { EditorView as ProseView } from "@milkdown/kit/prose/view";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue("not found (os error 2)"),
}));

import { useDocumentStore } from "../../store/documentStore";
import { MarkdownEditor } from "./MarkdownEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

/** A drag event carrying a data transfer (happy-dom's has none). */
function drag(type: string): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const data = new Map<string, string>();
  Object.defineProperty(e, "dataTransfer", {
    value: {
      files: [],
      effectAllowed: "all",
      clearData: () => data.clear(),
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
    },
  });
  return e;
}

describe("WYSIWYG editor: reordering images by dragging", () => {
  let host: HTMLDivElement;
  let root: Root;
  let view: ProseView | null;

  beforeEach(() => {
    view = null;
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

  it("keeps the new order when the user types afterwards", async () => {
    const raw =
      "![first](https://e.com/1.png) ![second](https://e.com/2.png)\n\nOutro text.\n";
    useDocumentStore.setState({ path: "/v/doc.md", content: raw, diskContent: raw });
    await act(async () =>
      root.render(createElement(MarkdownEditor, { initialContent: raw })),
    );
    for (let i = 0; i < 40 && !view; i++) {
      await wait(25);
      document.dispatchEvent(new Event("selectionchange"));
    }
    expect(view).not.toBeNull();
    const v = view as ProseView;
    await wait(50);
    const imgs = [...host.querySelectorAll<HTMLImageElement>(".ProseMirror img")];
    expect(imgs.map((i) => i.getAttribute("data-image-index"))).toEqual(["0", "1"]);
    await act(async () => {
      imgs[1].dispatchEvent(drag("dragstart"));
      imgs[0].dispatchEvent(drag("drop"));
    });
    const reordered = useDocumentStore.getState().content;
    expect(reordered.indexOf("second")).toBeLessThan(reordered.indexOf("first"));

    let outro = -1;
    v.state.doc.descendants((n, p) => {
      if (outro === -1 && n.isText && n.text?.startsWith("Outro")) outro = p;
    });
    await act(async () => {
      v.dispatch(v.state.tr.insertText("New ", outro, outro));
    });
    await wait(400);
    expect(useDocumentStore.getState().content).toBe(
      reordered.replace("Outro text.", "New Outro text."),
    );
  });
});
