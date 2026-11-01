import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../viewer/Renderer", () => ({
  Renderer: ({ content }: { content: string }) => createElement("p", null, content),
}));

import { useDocumentStore } from "../../store/documentStore";
import { CanvasViewer } from "./CanvasViewer";

const board = {
  nodes: [
    {
      id: "a",
      type: "text",
      text: "old",
      x: 10,
      y: 20,
      width: 200,
      height: 100,
      extra: { keep: true },
    },
    { id: "b", type: "text", text: "other", x: 300, y: 20, width: 100, height: 100 },
  ],
  edges: [],
  plugin: ["keep"],
};
const content = JSON.stringify(board);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("canvas editing and write back", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    useDocumentStore.setState({ tabs: [], activeId: null, path: null });
    invoke
      .mockReset()
      .mockImplementation(async (cmd: string, args?: { path: string }) => {
        if (cmd === "read_markdown_file")
          return {
            path: args?.path,
            file_name: "board.canvas",
            content,
            size: content.length,
            version: "v1",
          };
        if (cmd === "write_markdown_file") return "v2";
      });
    await useDocumentStore.getState().openPath("/v/board.canvas");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    function Board() {
      return createElement(CanvasViewer, {
        content: useDocumentStore((s) => s.content),
      });
    }
    await act(async () => root.render(createElement(Board)));
    const surface = host.querySelector<HTMLElement>(".canvas-surface")!;
    surface.setPointerCapture = vi.fn();
    surface.releasePointerCapture = vi.fn();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
  const pointer = (
    target: Element,
    type: string,
    x: number,
    y: number,
    button = 0,
    pointerId = 1,
  ) =>
    act(() => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId,
          button,
          clientX: x,
          clientY: y,
        }),
      );
    });
  const writes = () =>
    invoke.mock.calls.filter(([cmd]) => cmd === "write_markdown_file");
  const editText = async (text: string) => {
    await act(async () => button("Edit text").click());
    const textarea = host.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  it("previews a zoom-scaled move and saves once without losing other data", async () => {
    act(() =>
      host
        .querySelector('[aria-label="Zoom in"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    const node = host.querySelector('[data-canvas-node="a"]')!;
    pointer(node, "pointerdown", 0, 0);
    pointer(node, "pointermove", 60, 24);
    expect(writes()).toHaveLength(0);
    expect(
      (host.querySelector('[data-canvas-node="a"]') as HTMLElement).style.left,
    ).toBe("60px");
    await act(async () => pointer(node, "pointerup", 60, 24));
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].content)).toEqual({
      ...board,
      nodes: [{ ...board.nodes[0], x: 60, y: 40 }, board.nodes[1]],
    });
    expect(writes()[0][1]).toMatchObject({ path: "/v/board.canvas", expected: "v1" });
    expect(useDocumentStore.getState().isDirty).toBe(false);
  });
  it("saves edited text through the guarded document store", async () => {
    await editText("# Changed\ntext");
    await act(async () => button("Save text").click());
    expect(JSON.parse(writes()[0][1].content)).toEqual({
      ...board,
      nodes: [{ ...board.nodes[0], text: "# Changed\ntext" }, board.nodes[1]],
    });
  });
  it("cancels text and pointer edits without writing", async () => {
    await editText("discard");
    await act(async () => button("Cancel").click());
    const node = host.querySelector('[data-canvas-node="a"]')!;
    pointer(node, "pointerdown", 0, 0);
    pointer(node, "pointermove", 60, 24);
    pointer(node, "pointercancel", 60, 24);
    pointer(node, "pointerup", 60, 24);
    expect(writes()).toHaveLength(0);
    expect(useDocumentStore.getState().content).toBe(content);
  });
  it("rejects a draft after the source changes", async () => {
    await editText("stale");
    const changed = content.replace("old", "external");
    act(() => useDocumentStore.getState().setContent(changed));
    await act(async () => button("Save text").click());
    expect(writes()).toHaveLength(0);
    expect(useDocumentStore.getState().content).toBe(changed);
  });
  it("does not apply an in-flight drag to another tab", async () => {
    const node = host.querySelector('[data-canvas-node="a"]')!;
    pointer(node, "pointerdown", 0, 0);
    await act(async () => useDocumentStore.getState().openPath("/v/other.canvas"));
    await act(async () =>
      pointer(host.querySelector(".canvas-surface")!, "pointerup", 50, 50),
    );
    expect(writes()).toHaveLength(0);
    expect(useDocumentStore.getState().content).toBe(content);
  });
  it("ignores unrelated pointers and right clicks", async () => {
    const node = host.querySelector('[data-canvas-node="a"]')!;
    pointer(node, "pointerdown", 0, 0, 2);
    pointer(node, "pointerup", 50, 50, 2);
    expect(writes()).toHaveLength(0);
    pointer(node, "pointerdown", 0, 0);
    pointer(node, "pointerdown", 10, 10, 0, 2);
    pointer(node, "pointermove", 200, 200, 0, 2);
    pointer(node, "pointerup", 200, 200, 0, 2);
    expect(writes()).toHaveLength(0);
    await act(async () => pointer(node, "pointerup", 10, 20));
    expect(JSON.parse(writes()[0][1].content).nodes[0]).toMatchObject({ x: 20, y: 40 });
  });
  it("keeps the viewport steady after moving a node", async () => {
    const surface = host.querySelector<HTMLElement>(".canvas-surface")!;
    Object.defineProperties(surface, {
      clientWidth: { value: 800 },
      clientHeight: { value: 600 },
    });
    await act(async () => useDocumentStore.getState().setContent(`${content}\n`));
    const world = host.querySelector<HTMLElement>(".canvas-world")!;
    const transform = world.style.transform;
    const node = host.querySelector('[data-canvas-node="a"]')!;
    pointer(node, "pointerdown", 0, 0);
    await act(async () => pointer(node, "pointerup", 100, 100));
    expect(world.style.transform).toBe(transform);
  });
  it.each([
    { isComposing: true },
    { keyCode: 229 },
  ])("keeps composition keys in the text field: %j", async (composition) => {
    await editText("composed text");
    const textarea = host.querySelector("textarea")!;
    act(() => {
      for (const key of ["Escape", "Enter"])
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            ctrlKey: true,
            bubbles: true,
            ...composition,
          }),
        );
    });
    expect(host.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("composed text");
    expect(writes()).toHaveLength(0);
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      ),
    );
    expect(JSON.parse(writes()[0][1].content).nodes[0].text).toBe("composed text");
  });
  it("cancels text with a plain Escape", async () => {
    await editText("discard");
    act(() =>
      host
        .querySelector("textarea")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(host.querySelector("textarea")).toBeNull();
    expect(writes()).toHaveLength(0);
  });
  it("keeps edits dirty if writing fails", async () => {
    await editText("keep locally");
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "write_markdown_file") throw new Error("disk full");
    });
    await act(async () => button("Save text").click());
    expect(useDocumentStore.getState().isDirty).toBe(true);
    expect(JSON.parse(useDocumentStore.getState().content).nodes[0].text).toBe(
      "keep locally",
    );
  });
});
