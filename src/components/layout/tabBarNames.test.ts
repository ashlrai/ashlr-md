/**
 * Tabs that share a file name show enough of their folder to tell them
 * apart: two README.md tabs looked identical.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { type Tab, useDocumentStore } from "../../store/documentStore";
import { TabBar } from "./TabBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function tab(id: string, path: string): Tab {
  return {
    id,
    key: path,
    path,
    fileName: path.split("/").pop() ?? "",
    content: "",
    diskContent: "",
    size: 0,
    viewMode: "read",
    isDirty: false,
    externalChange: false,
    pendingDisk: null,
    diskVersion: null,
    pendingVersion: null,
    missing: false,
    reloadNonce: 0,
    splitView: false,
  };
}

describe("tab names", () => {
  let host: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("show the folder only where file names collide", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useDocumentStore.setState({
      tabs: [
        tab("a", "/w/api/README.md"),
        tab("b", "/w/web/README.md"),
        tab("c", "/w/plan.md"),
      ],
      activeId: "a",
      path: "/w/api/README.md",
    });
    act(() => root.render(createElement(TabBar)));
    const names = Array.from(host.querySelectorAll('[role="tab"]')).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["README.md, in api", "README.md, in web", "plan.md"]);
  });
});
