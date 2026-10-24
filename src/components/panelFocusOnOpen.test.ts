/**
 * Opening the outline or agent activity moves focus into it. Opened from a
 * shortcut, focus stayed where it was (the editor, say), so a keyboard user
 * had to hunt for the panel; on close focus goes back (useReturnFocus).
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

import { useActivityStore } from "../store/activityStore";
import { useDocumentStore } from "../store/documentStore";
import { useUiStore } from "../store/uiStore";
import { ActivityDrawer } from "./ActivityDrawer";
import { Outline } from "./Outline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no IntersectionObserver (the outline's scrollspy).
class NoopObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??=
  NoopObserver;

describe("side panels take focus when opened", () => {
  let host: HTMLDivElement;
  let root: Root;
  let trigger: HTMLButtonElement;

  beforeEach(() => {
    trigger = document.createElement("button");
    document.body.appendChild(trigger);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useUiStore.setState({ outlineOpen: false, activityOpen: false, searchOpen: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("the outline focuses its first heading, and gives focus back on close", () => {
    useDocumentStore.setState({
      path: "/d/a.md",
      content: "# One\n\n## Two\n",
      viewMode: "source",
    });
    act(() => root.render(createElement(Outline)));
    trigger.focus();
    act(() => useUiStore.getState().openOutline());
    const first = host.querySelector<HTMLElement>(".outline-item");
    expect(first).not.toBeNull();
    expect(document.activeElement).toBe(first);
    act(() => useUiStore.getState().closeOutline());
    expect(document.activeElement).toBe(trigger);
  });

  it("an empty outline focuses its close button", () => {
    useDocumentStore.setState({ path: null, content: "" });
    act(() => root.render(createElement(Outline)));
    trigger.focus();
    act(() => useUiStore.getState().openOutline());
    expect(document.activeElement).toBe(host.querySelector(".outline-panel__close"));
  });

  it("agent activity focuses its call to action when no folder is watched", () => {
    useActivityStore.setState({ watchedDir: null, files: [], lastError: null });
    act(() => root.render(createElement(ActivityDrawer)));
    trigger.focus();
    act(() => useUiStore.getState().openActivity());
    expect(document.activeElement).toBe(host.querySelector(".activity-empty__cta"));
    act(() => useUiStore.getState().closeActivity());
    expect(document.activeElement).toBe(trigger);
  });
});
