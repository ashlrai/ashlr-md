/**
 * Closing the file search gives focus back to what had it. The closed panel
 * is inert, so focus in it (Escape in the query, the close button) fell to
 * the page.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

import { useUiStore } from "../../store/uiStore";
import { SearchPanel } from "./SearchPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("search panel focus", () => {
  let host: HTMLDivElement;
  let root: Root;
  let trigger: HTMLButtonElement;

  beforeEach(() => {
    trigger = document.createElement("button");
    document.body.appendChild(trigger);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useUiStore.setState({ searchOpen: false });
    act(() => root.render(createElement(SearchPanel)));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("focuses the labelled query on open and returns focus on Escape", () => {
    trigger.focus();
    act(() => useUiStore.setState({ searchOpen: true }));
    const input = host.querySelector<HTMLInputElement>(".search-panel__input");
    expect(document.activeElement).toBe(input);
    expect(input?.getAttribute("aria-label")).toMatch(/search/i);

    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(useUiStore.getState().searchOpen).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves focus alone when it already moved out of the panel", () => {
    trigger.focus();
    act(() => useUiStore.setState({ searchOpen: true }));
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    act(() => useUiStore.setState({ searchOpen: false }));
    expect(document.activeElement).toBe(elsewhere);
  });
});
