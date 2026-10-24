/**
 * GitHub-flavored Markdown in the read view: tables (alignment, escaped
 * pipes, inline formatting, ragged rows) and task lists (checked state,
 * nesting, mixed with plain items). Rendered through the real Renderer
 * pipeline and asserted on the DOM, so a remark-gfm or sanitizer change that
 * drops a table, an alignment or a checkbox fails here. Issue #36.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { Renderer } from "./Renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TABLE_DOC = `# Tables

| Left | Center | Right | Default |
| :--- | :----: | ----: | ------- |
| a | **bold** | 1 | \`a \\| b\` |
| ragged | row |
| x | y | 3 | ~~gone~~ |
`;

const TASK_DOC = `# Tasks

- [x] done item
- [ ] open item
  - [x] nested done
  - [ ] nested open
- plain item
1. [ ] ordered task
`;

describe("GFM tables and task lists in the read view", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render(content: string) {
    await act(async () => {
      root.render(createElement(Renderer, { content }));
    });
  }

  it("renders a table with its header, every row and the declared alignments", async () => {
    await render(TABLE_DOC);
    const table = host.querySelector("table");
    expect(table).not.toBeNull();
    const heads = [...(table?.querySelectorAll("thead th") ?? [])].map(
      (th) => th.textContent,
    );
    expect(heads).toEqual(["Left", "Center", "Right", "Default"]);
    const rows = table?.querySelectorAll("tbody tr") ?? [];
    expect(rows).toHaveLength(3);
    const align = (cell: Element | null | undefined) =>
      cell?.getAttribute("align") ??
      (cell as HTMLElement | null | undefined)?.style.textAlign ??
      "";
    const first = rows[0]?.querySelectorAll("td");
    expect(align(first?.[0])).toBe("left");
    expect(align(first?.[1])).toBe("center");
    expect(align(first?.[2])).toBe("right");
    expect(align(first?.[3])).toBe("");
  });

  it("keeps inline formatting and an escaped pipe inside cells", async () => {
    await render(TABLE_DOC);
    const cells = host.querySelectorAll("tbody tr")[0]?.querySelectorAll("td");
    expect(cells?.[1]?.querySelector("strong")?.textContent).toBe("bold");
    expect(cells?.[3]?.querySelector("code")?.textContent).toBe("a | b");
    const last = host.querySelectorAll("tbody tr")[2]?.querySelectorAll("td");
    expect(last?.[3]?.querySelector("del")?.textContent).toBe("gone");
  });

  it("pads a ragged row to the header width", async () => {
    await render(TABLE_DOC);
    const ragged = host.querySelectorAll("tbody tr")[1]?.querySelectorAll("td");
    expect(ragged).toHaveLength(4);
    expect([...(ragged ?? [])].map((td) => td.textContent)).toEqual([
      "ragged",
      "row",
      "",
      "",
    ]);
  });

  it("renders task items as checkboxes with the right checked state, nested ones too", async () => {
    await render(TASK_DOC);
    const boxes = [
      ...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, true, false, false]);
    const nested = host.querySelectorAll("li li input[type='checkbox']");
    expect(nested).toHaveLength(2);
    const items = [...host.querySelectorAll("li")].map(
      (li) => li.textContent?.trim() ?? "",
    );
    expect(items.some((t) => t.startsWith("plain item"))).toBe(true);
    const plain = [...host.querySelectorAll("li")].find(
      (li) => li.textContent?.trim() === "plain item",
    );
    expect(plain?.querySelector("input")).toBeNull();
  });
});
