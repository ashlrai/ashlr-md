/**
 * The Agent Activity entry of the open document is marked active. It was
 * matched by exact path, so a document open under another spelling (here a
 * link to the watched folder) left its entry unmarked.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = (name: string) => ({
  path: `/w/${name}`,
  name,
  dir: "/w",
  mtimeMs: 1,
  size: 1,
});

describe("the Agent Activity entry of the open document", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    // /link is a symbolic link to /w.
    invoke.mockImplementation(async (cmd: string, args?: { path?: string }) => {
      if (cmd === "read_markdown_file") {
        const path = args?.path ?? "";
        const name = path.split("/").pop();
        return {
          path,
          file_name: name,
          content: "# x\n",
          size: 4,
          canonical_path: `/w/${name}`,
        };
      }
      if (cmd === "scan_markdown_files" || cmd === "list_markdown_files") {
        return { files: [file("a.md"), file("b.md")], scanCut: false };
      }
      return undefined;
    });
    useUiStore.setState({ activityOpen: true });
    useActivityStore.setState({
      watchedDir: "/w",
      files: [file("a.md"), file("b.md")],
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(ActivityDrawer)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    for (const t of useDocumentStore.getState().tabs) {
      useDocumentStore.getState().closeTab(t.id);
    }
  });

  const marked = () =>
    Array.from(host.querySelectorAll(".activity-item--active")).map((el) =>
      el.getAttribute("title"),
    );

  it("is marked when the document is open through a link", async () => {
    await act(async () => {
      await useDocumentStore.getState().openPath("/link/b.md");
    });
    expect(useDocumentStore.getState().path).toBe("/link/b.md");
    expect(marked()).toEqual(["/w/b.md"]);
  });

  it("is marked by its own path, and only it", async () => {
    await act(async () => {
      await useDocumentStore.getState().openPath("/w/a.md");
    });
    expect(marked()).toEqual(["/w/a.md"]);
  });
});
