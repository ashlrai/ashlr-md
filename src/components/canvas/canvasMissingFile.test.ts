/**
 * A canvas file card whose file was deleted or moved after the card found
 * it. Clicking its title read the file, and the error replaced the canvas:
 * the view showed only "Could not read …". The canvas now stays in view
 * and a toast says why.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MISSING = "Could not read /v/plan.md: No such file or directory (os error 2)";
const CANVAS = JSON.stringify({
  nodes: [
    { id: "n1", type: "file", file: "plan.md", x: 0, y: 0, width: 200, height: 100 },
  ],
  edges: [],
});

let planExists = true;
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useDocumentStore } from "../../store/documentStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useToastStore } from "../../store/toastStore";
import { CanvasViewer } from "./CanvasViewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("a canvas file card whose file is gone", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    planExists = true;
    invoke.mockImplementation(async (cmd: string, args?: { path?: string }) => {
      if (cmd === "resolve_wikilink") return "/v/plan.md";
      if (cmd === "read_markdown_file") {
        if (args?.path === "/v/board.canvas") {
          return {
            path: "/v/board.canvas",
            file_name: "board.canvas",
            content: CANVAS,
            size: 1,
          };
        }
        if (args?.path === "/v/plan.md" && planExists) {
          return {
            path: "/v/plan.md",
            file_name: "plan.md",
            content: "# Plan\n",
            size: 7,
          };
        }
        throw MISSING;
      }
      return undefined;
    });
    useSettingsStore.setState({ vaultRoot: "/v" });
    useToastStore.setState({ toasts: [] });
    await useDocumentStore.getState().openPath("/v/board.canvas");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root.render(createElement(CanvasViewer, { content: CANVAS })),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    for (const t of useDocumentStore.getState().tabs) {
      useDocumentStore.getState().closeTab(t.id);
    }
  });

  it("keeps the canvas in view and says why in a toast", async () => {
    const open = await vi.waitFor(() => {
      const b = host.querySelector<HTMLButtonElement>(".canvas-node__open");
      if (!b) throw new Error("no open button yet");
      return b;
    });
    planExists = false;
    await act(async () => open.click());
    await vi.waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));
    const s = useDocumentStore.getState();
    expect(s.error).toBeNull();
    expect(s.isLoading).toBe(false);
    expect(s.path).toBe("/v/board.canvas");
    const t = useToastStore.getState().toasts[0];
    expect(t.kind).toBe("error");
    expect(t.message).toBe(`Could not open the link to plan.md: ${MISSING}`);
  });
});
