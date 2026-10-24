/**
 * A diagram still rendering is marked, so an export waits for it (and keeps
 * its source if it never comes): it was an empty block, exported as such.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

let draw: (svg: string) => void = () => {};
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(
      () =>
        new Promise<{ svg: string }>((resolve) => {
          draw = (svg) => resolve({ svg });
        }),
    ),
  },
}));

import { MermaidBlock } from "./MermaidBlock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MermaidBlock", () => {
  let root: Root;
  const host = document.createElement("div");

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("is marked as loading, with its source, until the diagram is drawn", async () => {
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root.render(createElement(MermaidBlock, { code: "graph TD; A-->B" })),
    );
    const loading = host.querySelector(".mermaid-block--loading");
    expect(loading?.getAttribute("data-code")).toBe("graph TD; A-->B");
    await act(async () => {
      draw(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"></rect></svg>',
      );
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector(".mermaid-block--loading")).toBeNull();
    expect(host.querySelector(".mermaid-block rect")).not.toBeNull();
  });
});
