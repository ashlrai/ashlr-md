/**
 * Find wraps each hit in a `<mark>`, replacing the text node React rendered.
 * When the document changed while find was open (an agent's edit, a reload
 * from disk), React updated or removed the text node it held, which was no
 * longer in the page: the read view kept showing the old text, or React
 * threw removing a node that was not there.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useDocumentStore } from "../../store/documentStore";
import { Renderer } from "../viewer/Renderer";
import { FindBar } from "./FindBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function View({ find = true }: { find?: boolean }) {
  const content = useDocumentStore((s) => s.content);
  return createElement(
    "div",
    null,
    createElement(
      "main",
      { className: "app-content" },
      createElement(
        "article",
        { className: "reading-surface" },
        createElement(Renderer, { content }),
      ),
    ),
    find ? createElement(FindBar) : null,
  );
}

describe("find while the document changes", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    Element.prototype.scrollIntoView = () => {};
    useDocumentStore.setState({
      path: "/n/a.md",
      content: "alpha **b** one\n\nkeep one\n",
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(View)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function find(text: string) {
    const input = host.querySelector<HTMLInputElement>(".find-input");
    if (!input) throw new Error("no find input");
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      set?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  const paragraphs = () =>
    [...host.querySelectorAll(".markdown-body p")].map((p) => p.textContent);
  const count = () => host.querySelector(".find-count")?.textContent;
  const status = () => host.querySelector('[role="status"]');

  it("announces no results for a query with zero matches", async () => {
    expect(status()?.textContent).toBe("");
    await find("missing");
    expect(count()).toBe("0/0");
    expect(status()?.textContent).toBe("No results");
    expect(status()?.getAttribute("aria-live")).toBe("polite");
    expect(status()?.getAttribute("aria-atomic")).toBe("true");
    expect(host.querySelector(".find-count")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("announces a singular match", async () => {
    await find("alpha");
    expect(count()).toBe("1/1");
    expect(status()?.textContent).toBe("1 match. Match 1 of 1.");
  });

  it("announces plural matches and the active result when navigating", async () => {
    await find("one");
    expect(status()?.textContent).toBe("2 matches. Match 1 of 2.");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')?.click();
    });
    expect(count()).toBe("2/2");
    expect(status()?.textContent).toBe("2 matches. Match 2 of 2.");
  });

  it.each([
    "missing",
    "alpha",
    "one",
  ])("clears the status when resetting query %s", async (query) => {
    await find(query);
    const liveRegion = status();
    await find("");
    expect(status()).toBe(liveRegion);
    expect(status()?.textContent).toBe("");
    expect(count()).toBe("");
    expect(host.querySelector("mark")).toBeNull();
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')?.disabled,
    ).toBe(true);
  });

  it("shows the new text of a changed line", async () => {
    await find("one");
    expect(count()).toBe("1/2");
    await act(async () => {
      useDocumentStore.setState({ content: "alpha **b** two\n\nkeep one\n" });
    });
    expect(paragraphs()).toEqual(["alpha b two", "keep one"]);
    expect(count()).toBe("1/1");
  });

  it("drops a removed line without an error", async () => {
    await find("one");
    await act(async () => {
      useDocumentStore.setState({ content: "alpha **b**\n\nkeep one\n" });
    });
    expect(paragraphs()).toEqual(["alpha b", "keep one"]);
    expect(count()).toBe("1/1");
  });

  it("keeps the text React rendered once find closes", async () => {
    await find("one");
    await act(async () => root.render(createElement(View, { find: false })));
    expect(host.querySelector("mark")).toBeNull();
    await act(async () => {
      useDocumentStore.setState({ content: "alpha **b** three\n\nkeep one\n" });
    });
    expect(paragraphs()).toEqual(["alpha b three", "keep one"]);
  });
});
