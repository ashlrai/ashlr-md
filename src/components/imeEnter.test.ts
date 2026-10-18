/**
 * An Enter that commits an IME composition in the command palette's query or
 * the find bar belongs to the input method. It used to also run the selected
 * command or jump to the next match; a plain Enter still does.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
// The palette's first row is "Open file", which opens the file dialog.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

import { useUiStore } from "../store/uiStore";
import { CommandPalette } from "./CommandPalette";
import { FindBar } from "./find/FindBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pressEnter(target: Element, init: KeyboardEventInit = {}) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("an IME composition's Enter", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("does not run the palette's selected command", async () => {
    useUiStore.setState({ commandPaletteOpen: true });
    await act(async () => root.render(createElement(CommandPalette)));
    const input = host.querySelector("input");
    expect(input).not.toBeNull();
    expect(host.querySelector("[data-index='0']")).not.toBeNull();

    pressEnter(input!, { isComposing: true });
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);
    pressEnter(input!, { keyCode: 229 });
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);

    // A plain Enter runs the row, which closes the palette first.
    pressEnter(input!);
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it("does not move the find bar to the next match", async () => {
    const page = document.createElement("div");
    page.className = "app-content";
    page.innerHTML = `<div class="markdown-body"><p>fox fox fox</p></div>`;
    document.body.appendChild(page);
    useUiStore.setState({ findOpen: true });
    await act(async () => root.render(createElement(FindBar)));
    const input = host.querySelector("input") as HTMLInputElement;
    typeInto(input, "fox");
    const countText = () => host.querySelector(".find-count")?.textContent;
    expect(countText()).toBe("1/3");

    pressEnter(input, { isComposing: true });
    expect(countText()).toBe("1/3");
    pressEnter(input, { keyCode: 229 });
    expect(countText()).toBe("1/3");

    pressEnter(input);
    expect(countText()).toBe("2/3");
  });
});
