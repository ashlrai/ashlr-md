/**
 * Clicking a task checkbox in the read view toggles its `[ ]` / `[x]` in
 * the document. The checkbox input remark-rehype creates has no source
 * position (rehype-raw keeps none either), so TaskCheckbox read line 0 and
 * returned before toggling: every click was a no-op. These tests render
 * through the real Renderer pipeline, click, and read the document text.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useDocumentStore } from "../../store/documentStore";
import { Renderer } from "./Renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("task checkboxes in the read view", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invoke.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  /** Render the open document `doc` as the read view does. */
  async function open(doc: string) {
    useDocumentStore.setState({
      path: "/notes/plan.md",
      content: doc,
      diskContent: doc,
    });
    await act(async () => {
      root.render(
        createElement(() =>
          createElement(Renderer, { content: useDocumentStore((s) => s.content) }),
        ),
      );
    });
  }

  function boxes(): HTMLInputElement[] {
    return [...host.querySelectorAll<HTMLInputElement>("input.task-checkbox")];
  }

  async function click(i: number) {
    await act(async () => boxes()[i].click());
  }

  const content = () => useDocumentStore.getState().content;

  it("toggles the clicked task and saves the document", async () => {
    await open("# Plan\n\n- [ ] one\n- [x] two\n");
    expect(boxes().map((b) => b.checked)).toEqual([false, true]);
    await click(0);
    expect(content()).toBe("# Plan\n\n- [x] one\n- [x] two\n");
    expect(invoke).toHaveBeenCalledWith("write_markdown_file", {
      path: "/notes/plan.md",
      content: "# Plan\n\n- [x] one\n- [x] two\n",
    });
    await click(1);
    expect(content()).toBe("# Plan\n\n- [x] one\n- [ ] two\n");
    // The page follows the document.
    expect(boxes().map((b) => b.checked)).toEqual([true, false]);
    await click(0);
    expect(content()).toBe("# Plan\n\n- [ ] one\n- [ ] two\n");
  });

  it("finds the line of a task after front matter", async () => {
    await open("---\ntitle: Plan\ntags: [a]\n---\n- [ ] after\n");
    await click(0);
    expect(content()).toBe("---\ntitle: Plan\ntags: [a]\n---\n- [x] after\n");
  });

  it("toggles tasks in nested lists, loose lists and ordered items", async () => {
    await open(
      "- [ ] outer\n  - [ ] inner\n    1) [x] deep\n\n- [ ] loose\n\n  more\n",
    );
    await click(1);
    expect(content()).toBe(
      "- [ ] outer\n  - [x] inner\n    1) [x] deep\n\n- [ ] loose\n\n  more\n",
    );
    await click(2);
    expect(content()).toBe(
      "- [ ] outer\n  - [x] inner\n    1) [ ] deep\n\n- [ ] loose\n\n  more\n",
    );
    await click(3);
    expect(content()).toBe(
      "- [ ] outer\n  - [x] inner\n    1) [ ] deep\n\n- [x] loose\n\n  more\n",
    );
    await click(0);
    expect(content()).toBe(
      "- [x] outer\n  - [x] inner\n    1) [ ] deep\n\n- [x] loose\n\n  more\n",
    );
  });

  it("toggles tasks in blockquotes and callouts", async () => {
    await open("> - [ ] quoted\n>   - [x] nested\n\n> [!note]\n> - [ ] in a callout\n");
    expect(boxes()).toHaveLength(3);
    await click(0);
    await click(1);
    await click(2);
    expect(content()).toBe(
      "> - [x] quoted\n>   - [ ] nested\n\n> [!note]\n> - [x] in a callout\n",
    );
  });

  it("toggles a checkbox on a bare item's next line, and keeps tabs", async () => {
    await open("-\n  [ ] next line\n-\t[x] tabbed\n");
    await click(0);
    await click(1);
    expect(content()).toBe("-\n  [x] next line\n-\t[ ] tabbed\n");
  });

  it("leaves raw HTML checkboxes and embedded text alone", async () => {
    const doc = '- [ ] real\n\n<input type="checkbox" data-task-line="1">\n';
    await open(doc);
    const raw = host.querySelectorAll('input[type="checkbox"]');
    expect(raw).toHaveLength(2);
    await act(async () => (raw[1] as HTMLInputElement).click());
    expect(content()).toBe(doc);
    // Text another Renderer shows (an embed) is not the open document.
    await act(async () => {
      root.render(createElement(Renderer, { content: "- [ ] embedded\n" }));
    });
    expect(boxes()).toHaveLength(1);
    expect(boxes()[0].disabled).toBe(true);
    await click(0);
    expect(content()).toBe(doc);
  });
});
