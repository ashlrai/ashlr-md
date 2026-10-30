/**
 * revealLine shows a search hit's line: in Source view it moves the
 * cursor there, in Read view it scrolls to the block that holds the line.
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { Renderer } from "../components/viewer/Renderer";
import { blockForLine, revealLine } from "./revealLine";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DOC =
  "# Title\n\nPara one.\n\n## Goals\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nEnd.\n";

describe("revealLine", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("main");
    host.className = "app-content";
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
  });

  describe("in the read view", () => {
    let root: Root;
    beforeEach(async () => {
      const article = document.createElement("article");
      article.className = "reading-surface";
      host.appendChild(article);
      root = createRoot(article);
      await act(async () => root.render(createElement(Renderer, { content: DOC })));
    });
    afterEach(() => act(() => root.unmount()));

    const body = () => host.querySelector(".markdown-body") as Element;

    it("finds a heading by its line", () => {
      expect(blockForLine(5, body())?.textContent).toContain("Goals");
      expect(blockForLine(1, body())?.textContent).toContain("Title");
    });

    it("finds the block a line inside a paragraph belongs to", () => {
      expect(blockForLine(3, body())?.textContent).toBe("Para one.");
      expect(blockForLine(4, body())?.textContent).toBe("Para one.");
      expect(blockForLine(12, body())?.textContent).toBe("End.");
    });

    it("scrolls to the block once it is rendered", async () => {
      vi.useFakeTimers();
      const seen: Element[] = [];
      Element.prototype.scrollIntoView = function (this: Element) {
        seen.push(this);
      };
      revealLine(12);
      await act(async () => {
        vi.advanceTimersByTime(10);
      });
      vi.useRealTimers();
      expect(seen.map((el) => el.textContent)).toEqual(["End."]);
    });

    it("scrolls to the last block when the line is beyond the document", async () => {
      vi.useFakeTimers();
      try {
        const lastBlock = blockForLine(12, body());
        expect(lastBlock?.textContent).toBe("End.");
        const scroll = vi.fn();
        if (!lastBlock) throw new Error("Expected the last block to exist");
        lastBlock.scrollIntoView = scroll;
        revealLine(100);
        await act(async () => {
          vi.advanceTimersByTime(10);
        });
        expect(scroll).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("moves the source editor's cursor to the line", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: DOC }),
      parent: host,
    });
    revealLine(8);
    await vi.waitFor(() => {
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(8);
    });
    expect(view.state.selection.main.head).toBe(view.state.doc.line(8).from);
    view.destroy();
  });

  it("moves the source editor's cursor to the first line", async () => {
    const state = EditorState.create({ doc: DOC });
    const view = new EditorView({
      state,
      parent: host,
    });
    try {
      view.dispatch({ selection: { anchor: state.doc.line(8).from } });
      revealLine(1);
      await vi.waitFor(() => {
        expect(view.state.selection.main.anchor).toBe(0);
        expect(view.state.selection.main.head).toBe(0);
      });
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1);
    } finally {
      view.destroy();
    }
  });

  it("clamps a line beyond the document to the last source line", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: DOC }),
      parent: host,
    });
    try {
      const lastLine = view.state.doc.line(view.state.doc.lines);
      revealLine(view.state.doc.lines + 100);
      await vi.waitFor(() => {
        expect(view.state.selection.main.head).toBe(lastLine.from);
      });
    } finally {
      view.destroy();
    }
  });
});
