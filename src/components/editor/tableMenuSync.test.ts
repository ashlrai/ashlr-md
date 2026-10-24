/**
 * The WYSIWYG editor's table menu (lib/tableEditor.ts edits the Markdown).
 * It gave the result to the document store only, so the editor kept the
 * old table, and the next typed edit wrote it back over the menu's change.
 */

import { TextSelection } from "@milkdown/kit/prose/state";
import { EditorView as ProseView } from "@milkdown/kit/prose/view";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { useDocumentStore } from "../../store/documentStore";
import { MarkdownEditor } from "./MarkdownEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

describe("WYSIWYG editor: the table menu", () => {
  let host: HTMLDivElement;
  let root: Root;
  // The editor's ProseMirror view, caught when the editor asks for focus.
  let view: ProseView | null;

  beforeEach(() => {
    view = null;
    vi.spyOn(ProseView.prototype, "hasFocus").mockImplementation(function (
      this: ProseView,
    ) {
      view = this;
      return true;
    });
    vi.spyOn(ProseView.prototype, "coordsAtPos").mockReturnValue({
      top: 100,
      bottom: 120,
      left: 10,
      right: 20,
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

  /** Mount the editor on `raw` and return its view. */
  async function mount(raw: string): Promise<ProseView> {
    useDocumentStore.setState({ content: raw, diskContent: raw, isDirty: false });
    await act(async () =>
      root.render(createElement(MarkdownEditor, { initialContent: raw })),
    );
    for (let i = 0; i < 40 && !view; i++) {
      await wait(25);
      document.dispatchEvent(new Event("selectionchange"));
    }
    expect(view).not.toBeNull();
    return view as ProseView;
  }

  /** Put the cursor in the text `cellText` and press ⌘⇧T (Ctrl outside macOS). */
  async function openMenuAt(v: ProseView, cellText: string) {
    let cell = -1;
    v.state.doc.descendants((n, p) => {
      if (cell === -1 && n.isText && n.text === cellText) cell = p;
    });
    await act(async () => {
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, cell)));
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "T",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  const menuButton = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>(".table-context-menu button")].find(
      (b) => b.textContent === label,
    );

  const TABLE_DOC = "Intro text.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nOutro text.\n";

  it("opens from the keyboard in a table cell", async () => {
    // Its effect ran before the view was captured, found none and never
    // listened (a build has no StrictMode second run to hide that).
    const v = await mount(TABLE_DOC);
    await openMenuAt(v, "a");
    expect(menuButton("Insert row below")).toBeDefined();
  });

  it("keeps the menu's change when the user types afterwards", async () => {
    // The menu gave its result to the document store only: the editor kept
    // the old table, and the next typed edit wrote it back over the change.
    const v = await mount(TABLE_DOC);
    await openMenuAt(v, "a");
    await act(async () => menuButton("Insert row below")?.click());
    const afterMenu = useDocumentStore.getState().content;
    expect(afterMenu.match(/^\|/gm)?.length).toBe(4);
    // The editor shows the new row too.
    expect(v.state.doc.child(1).childCount).toBe(3);
    await wait(400);
    // Showing it reports no change of its own.
    expect(useDocumentStore.getState().content).toBe(afterMenu);

    let outro = -1;
    v.state.doc.descendants((n, p) => {
      if (outro === -1 && n.isText && n.text?.startsWith("Outro")) outro = p;
    });
    await act(async () => {
      v.dispatch(v.state.tr.insertText("New ", outro, outro));
    });
    await wait(400);
    // The row the menu added is still there, as the menu wrote it, with the
    // typed text; the rest is as it was.
    expect(useDocumentStore.getState().content).toBe(
      afterMenu.replace("Outro text.", "New Outro text."),
    );
  });
});
