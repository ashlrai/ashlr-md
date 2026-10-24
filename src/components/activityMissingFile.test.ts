/**
 * The Agent Activity list keeps a file deleted or moved since it was
 * listed (the folder watcher reports no deletions). Clicking it read the
 * file, and the error replaced the open document; the entry stayed, so the
 * next click did the same. The document now stays in view, a toast says
 * why, and the entry leaves the list.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MISSING = "Could not read /w/gone.md: No such file or directory (os error 2)";
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
import { useToastStore } from "../store/toastStore";
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

describe("an Agent Activity entry whose file is gone", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    invoke.mockImplementation(async (cmd: string, args?: { path?: string }) => {
      if (cmd === "read_markdown_file") {
        if (args?.path === "/w/here.md") {
          return {
            path: "/w/here.md",
            file_name: "here.md",
            content: "# Here\n",
            size: 7,
          };
        }
        throw MISSING;
      }
      if (cmd === "scan_markdown_files" || cmd === "list_markdown_files") {
        return { files: [file("gone.md"), file("here.md")], scanCut: false };
      }
      return undefined;
    });
    useToastStore.setState({ toasts: [] });
    await useDocumentStore.getState().openPath("/w/here.md");
    useUiStore.setState({ activityOpen: true });
    useActivityStore.setState({
      watchedDir: "/w",
      files: [file("gone.md"), file("here.md")],
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(ActivityDrawer)));
    useActivityStore.setState({ files: [file("gone.md"), file("here.md")] });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    for (const t of useDocumentStore.getState().tabs) {
      useDocumentStore.getState().closeTab(t.id);
    }
  });

  const names = () =>
    [...host.querySelectorAll(".activity-item__name")].map((n) => n.textContent);

  it("keeps the document in view, says why, and drops the entry", async () => {
    expect(names()).toEqual(["gone.md", "here.md"]);
    const gone = host.querySelector<HTMLButtonElement>(
      '.activity-item[title="/w/gone.md"]',
    );
    await act(async () => gone?.click());
    await vi.waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));
    const s = useDocumentStore.getState();
    expect(s.error).toBeNull();
    expect(s.path).toBe("/w/here.md");
    expect(useToastStore.getState().toasts[0].message).toBe(
      `Could not open gone.md: ${MISSING}`,
    );
    expect(names()).toEqual(["here.md"]);
  });
});
