/**
 * The tab bar is announced as tabs, so it answers their keys: only the
 * active tab is a Tab stop, and Left/Right/Home/End move between documents.
 * Every tab was its own Tab stop with no arrow keys, and the unsaved dot's
 * aria-label (on a plain span) was never read.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === "read_markdown_file"
      ? Promise.reject("not in this test")
      : Promise.resolve(),
  ),
}));

import { type Tab, useDocumentStore } from "../../store/documentStore";
import { DOCUMENT_PANEL_ID, TabBar, tabElementId } from "./TabBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function tab(id: string, isDirty = false): Tab {
  return {
    id,
    key: `/v/${id}.md`,
    path: `/v/${id}.md`,
    fileName: `${id}.md`,
    content: id,
    diskContent: id,
    size: 1,
    viewMode: "read",
    isDirty,
    externalChange: false,
    pendingDisk: null,
    diskVersion: null,
    pendingVersion: null,
    missing: false,
    reloadNonce: 0,
    splitView: false,
  };
}

describe("tab bar keyboard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useDocumentStore.setState({
      tabs: [tab("a"), tab("b", true), tab("c")],
      activeId: "a",
      path: "/v/a.md",
    });
    act(() => root.render(createElement(TabBar)));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  const tabs = () => Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]'));
  const press = (el: HTMLElement, key: string) => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => {
      el.dispatchEvent(e);
    });
    return e;
  };

  it("keeps only the active tab in the Tab order", () => {
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves to and opens the next, previous, first and last tab", () => {
    tabs()[0].focus();
    expect(press(tabs()[0], "ArrowRight").defaultPrevented).toBe(true);
    expect(useDocumentStore.getState().activeId).toBe("b");
    expect(document.activeElement).toBe(tabs()[1]);
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);

    press(tabs()[1], "End");
    expect(useDocumentStore.getState().activeId).toBe("c");
    press(tabs()[2], "ArrowRight");
    expect(useDocumentStore.getState().activeId).toBe("a");
    press(tabs()[0], "ArrowLeft");
    expect(useDocumentStore.getState().activeId).toBe("c");
    press(tabs()[2], "Home");
    expect(useDocumentStore.getState().activeId).toBe("a");
    expect(document.activeElement).toBe(tabs()[0]);

    // Other keys, and keys on a close button, are left alone.
    expect(press(tabs()[0], "a").defaultPrevented).toBe(false);
    const close = host.querySelector<HTMLElement>(".tab-close");
    if (close) expect(press(close, "ArrowRight").defaultPrevented).toBe(false);
  });

  it("reads an unsaved tab's state as text", () => {
    const dirty = tabs()[1];
    expect(dirty.textContent).toContain("unsaved changes");
    expect(dirty.querySelector(".tab-dirty")?.getAttribute("aria-hidden")).toBe("true");
    expect(dirty.querySelector("[aria-label]")).toBeNull();
  });

  it("owns only tabs: rows are presentational, close buttons hidden and out of the Tab order", () => {
    const list = host.querySelector('[role="tablist"]') as HTMLElement;
    for (const row of Array.from(list.children)) {
      expect(row.getAttribute("role")).toBe("presentation");
      expect(row.querySelectorAll('[role="tab"]')).toHaveLength(1);
      const close = row.querySelector<HTMLElement>(".tab-close");
      expect(close?.getAttribute("aria-hidden")).toBe("true");
      expect(close?.tabIndex).toBe(-1);
      expect(close?.hasAttribute("aria-label")).toBe(false);
    }
    // Nothing focusable but the tabs is exposed inside the tablist.
    const exposed = Array.from(list.querySelectorAll<HTMLElement>("button")).filter(
      (b) => b.closest('[aria-hidden="true"]') === null,
    );
    expect(exposed.every((b) => b.getAttribute("role") === "tab")).toBe(true);
  });

  it("names the panel the active tab controls", () => {
    const [a, b] = tabs();
    expect(a.id).toBe(tabElementId("a"));
    expect(a.getAttribute("aria-controls")).toBe(DOCUMENT_PANEL_ID);
    expect(b.hasAttribute("aria-controls")).toBe(false);
  });

  it("closes the focused tab on Delete", () => {
    tabs()[2].focus();
    expect(press(tabs()[2], "Delete").defaultPrevented).toBe(true);
    expect(useDocumentStore.getState().tabs.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("still closes a tab from its close button", () => {
    const close = host.querySelectorAll<HTMLElement>(".tab-close")[2];
    act(() => close.click());
    expect(useDocumentStore.getState().tabs.map((t) => t.id)).toEqual(["a", "b"]);
  });
});
