/**
 * The command palette is a modal: focus goes back to what had it when it
 * closes, and Tab stays inside it. It "restored" focus to its own removed
 * input (it read document.activeElement after autoFocus had moved focus
 * there), and Tab left it for the app behind.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { useUiStore } from "../store/uiStore";
import { CommandPalette } from "./CommandPalette";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("command palette focus", () => {
  let host: HTMLDivElement;
  let root: Root;
  let trigger: HTMLButtonElement;

  beforeEach(() => {
    trigger = document.createElement("button");
    trigger.textContent = "trigger";
    document.body.appendChild(trigger);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useUiStore.setState({ commandPaletteOpen: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("focuses its input, keeps Tab inside, and gives focus back on close", () => {
    trigger.focus();
    act(() => root.render(createElement(CommandPalette)));
    act(() => useUiStore.setState({ commandPaletteOpen: true }));
    const input = host.querySelector<HTMLInputElement>(".cmdk-input");
    expect(document.activeElement).toBe(input);

    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    input?.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);

    act(() => useUiStore.setState({ commandPaletteOpen: false }));
    expect(host.querySelector(".cmdk-input")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("is a combobox that names the listbox it controls", () => {
    act(() => root.render(createElement(CommandPalette)));
    act(() => useUiStore.setState({ commandPaletteOpen: true }));
    const input = host.querySelector(".cmdk-input");
    expect(input?.getAttribute("role")).toBe("combobox");
    expect(input?.getAttribute("aria-label")).toBe("Search commands");
    const list = host.querySelector('[role="listbox"]');
    expect(input?.getAttribute("aria-controls")).toBe(list?.id);
    expect(list?.getAttribute("aria-label")).toBe("Commands");
  });

  it("puts each group's options in a role=group labelled by its header", () => {
    act(() => root.render(createElement(CommandPalette)));
    act(() => useUiStore.setState({ commandPaletteOpen: true }));
    const list = host.querySelector('[role="listbox"]') as HTMLElement;
    const groups = Array.from(list.children);
    expect(groups.length).toBeGreaterThan(1);
    let index = 0;
    for (const g of groups) {
      expect(g.getAttribute("role")).toBe("group");
      const label = document.getElementById(g.getAttribute("aria-labelledby") ?? "");
      expect(label?.classList.contains("cmdk-group")).toBe(true);
      expect(label?.textContent).not.toBe("");
      expect(label?.getAttribute("aria-hidden")).toBe("true");
      // A group holds its header and options only, in the palette's order.
      for (const child of Array.from(g.children)) {
        if (child === label) continue;
        expect(child.getAttribute("role")).toBe("option");
        expect(child.id).toBe(`cmdk-row-${index}`);
        index += 1;
      }
    }
    expect(index).toBe(list.querySelectorAll('[role="option"]').length);
  });
});

describe("groupRuns", () => {
  it("splits rows into runs of one group, with each run's first index", async () => {
    const { groupRuns } = await import("./CommandPalette");
    const runs = groupRuns([
      { group: "A" },
      { group: "A" },
      { group: "B" },
      { group: "A" },
    ]);
    expect(runs.map((r) => [r.group, r.start, r.rows.length])).toEqual([
      ["A", 0, 2],
      ["B", 2, 1],
      ["A", 3, 1],
    ]);
  });
});
