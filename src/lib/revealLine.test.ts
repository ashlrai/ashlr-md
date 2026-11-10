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

    it("finds the fenced code block for lines inside it", () => {
      const codeBlock = body().querySelector(".code-block")?.parentElement;
      expect(codeBlock).not.toBeNull();
      expect(codeBlock?.querySelector("pre")?.textContent).toContain("const a = 1;");
      expect(blockForLine(8, body())).toBe(codeBlock);
      expect(blockForLine(9, body())).toBe(codeBlock);
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

    it("resolves the first and final line of the document to the first and last block", () => {
      const lines = DOC.split("\n").length;
      expect(lines).toBe(13);
      expect(blockForLine(1, body())?.textContent).toContain("Title");
      expect(blockForLine(lines, body())?.textContent).toBe("End.");
      expect(blockForLine(lines + 1, body())?.textContent).toBe("End.");
    });

    it("finds no block above the first line", () => {
      expect(blockForLine(0, body())).toBeNull();
    });

    it("handles an empty rendered document without scrolling", async () => {
      await act(async () => root.render(createElement(Renderer, { content: "" })));
      expect(body()).not.toBeNull();
      expect(body().querySelector("[data-source-line]")).toBeNull();
      expect(blockForLine(1, body())).toBeNull();

      vi.useFakeTimers();
      const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
      try {
        revealLine(1);
        await act(async () => {
          await vi.runAllTimersAsync();
        });
        expect(scroll).not.toHaveBeenCalled();
      } finally {
        scroll.mockRestore();
        vi.useRealTimers();
      }
    });

    it("does not scroll for a negative line after all retries", async () => {
      vi.useFakeTimers();
      const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
      try {
        expect(blockForLine(-5, body())).toBeNull();
        revealLine(-5);
        await act(async () => {
          await vi.runAllTimersAsync();
        });
        expect(scroll).not.toHaveBeenCalled();
      } finally {
        scroll.mockRestore();
        vi.useRealTimers();
      }
    });

    it("scrolls to the first block for line 1", async () => {
      vi.useFakeTimers();
      try {
        const seen: Element[] = [];
        Element.prototype.scrollIntoView = function (this: Element) {
          seen.push(this);
        };
        revealLine(1);
        await act(async () => {
          vi.advanceTimersByTime(10);
        });
        expect(seen).toHaveLength(1);
        expect(seen[0].textContent).toContain("Title");
      } finally {
        vi.useRealTimers();
      }
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

  it("reveals the first line of a single-line source document", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "Only line" }),
      parent: host,
    });
    try {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      revealLine(1);
      await vi.waitFor(() => {
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
      const dispatch = vi.spyOn(view, "dispatch");
      const lastLine = view.state.doc.line(view.state.doc.lines);
      expect(() => revealLine(view.state.doc.lines + 100)).not.toThrow();
      await vi.waitFor(() => {
        expect(dispatch).toHaveBeenCalledOnce();
        expect(view.state.selection.main.head).toBe(lastLine.from);
      });
      expect(view.state.doc.toString()).toBe(DOC);
    } finally {
      view.destroy();
    }
  });

  it("moves the source editor's cursor to the exact final line", async () => {
    const state = EditorState.create({ doc: DOC });
    const view = new EditorView({ state, parent: host });
    try {
      const last = state.doc.line(state.doc.lines);
      revealLine(state.doc.lines);
      await vi.waitFor(() => {
        expect(view.state.selection.main.head).toBe(last.from);
      });
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(
        state.doc.lines,
      );
      expect(view.state.selection.main.head).toBe(state.doc.length);
    } finally {
      view.destroy();
    }
  });

  it("moves the cursor to the line before the final line, not the final one", async () => {
    const state = EditorState.create({ doc: DOC });
    const view = new EditorView({ state, parent: host });
    try {
      const penultimate = state.doc.line(state.doc.lines - 1);
      revealLine(state.doc.lines - 1);
      await vi.waitFor(() => {
        expect(view.state.selection.main.head).toBe(penultimate.from);
      });
    } finally {
      view.destroy();
    }
  });

  it("clamps line 0 and negative lines to the first source line", async () => {
    const state = EditorState.create({ doc: DOC });
    const view = new EditorView({ state, parent: host });
    try {
      view.dispatch({ selection: { anchor: state.doc.line(8).from } });
      revealLine(0);
      await vi.waitFor(() => expect(view.state.selection.main.head).toBe(0));
      view.dispatch({ selection: { anchor: state.doc.line(8).from } });
      revealLine(-5);
      await vi.waitFor(() => expect(view.state.selection.main.head).toBe(0));
    } finally {
      view.destroy();
    }
  });

  it("handles a line far beyond the source document without throwing or rejecting", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: DOC }),
      parent: host,
    });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const lastLine = view.state.doc.line(view.state.doc.lines);
      for (const line of [
        view.state.doc.lines + 1,
        1_000_000,
        Number.MAX_SAFE_INTEGER,
      ]) {
        view.dispatch({ selection: { anchor: 0 } });
        let stop: (() => void) | undefined;
        expect(() => {
          stop = revealLine(line);
        }).not.toThrow();
        await vi.waitFor(() => {
          expect(view.state.selection.main.head).toBe(lastLine.from);
        });
        stop?.();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      view.destroy();
    }
  });

  it("does not throw for a line beyond the read view's last block", async () => {
    const article = document.createElement("article");
    article.className = "reading-surface";
    host.appendChild(article);
    const root = createRoot(article);
    vi.useFakeTimers();
    try {
      await act(async () => root.render(createElement(Renderer, { content: DOC })));
      const scroll = vi
        .spyOn(Element.prototype, "scrollIntoView")
        .mockImplementation(() => {});
      let stop: (() => void) | undefined;
      expect(() => {
        stop = revealLine(Number.MAX_SAFE_INTEGER);
      }).not.toThrow();
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(scroll).toHaveBeenCalledOnce();
      expect((scroll.mock.contexts[0] as Element).textContent).toBe("End.");
      stop?.();
      scroll.mockRestore();
    } finally {
      vi.useRealTimers();
      await act(async () => root.unmount());
    }
  });

  it("reveals a line in an empty source document at offset zero", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "" }),
      parent: host,
    });
    try {
      const dispatch = vi.spyOn(view, "dispatch");
      revealLine(100);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      expect(view.state.doc.toString()).toBe("");
      expect(view.state.selection.main.anchor).toBe(0);
      expect(view.state.selection.main.head).toBe(0);
    } finally {
      view.destroy();
    }
  });
});
