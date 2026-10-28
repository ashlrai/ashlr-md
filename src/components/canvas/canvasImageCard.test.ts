/**
 * A canvas image card's title. It opened the image as a document, which
 * read the image as text and failed with a toast; nothing useful happened.
 * It now shows the image in its folder, and the canvas stays in view.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CANVAS = JSON.stringify({
  nodes: [
    { id: "n1", type: "file", file: "pic.png", x: 0, y: 0, width: 200, height: 100 },
  ],
  edges: [],
});

const invoke = vi.hoisted(() => vi.fn());
const REVEAL = "plugin:opener|reveal_item_in_dir";
let revealError: string | null = null;
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useDocumentStore } from "../../store/documentStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useToastStore } from "../../store/toastStore";
import { CanvasViewer } from "./CanvasViewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("a canvas image card's title", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    revealError = null;
    invoke
      .mockReset()
      .mockImplementation(async (cmd: string, args?: { path?: string }) => {
        if (cmd === REVEAL) {
          if (revealError !== null) throw revealError;
          return undefined;
        }
        if (cmd === "resolve_wikilink") return "/v/pic.png";
        if (cmd === "read_image_data_url") return "data:image/png;base64,AAAA";
        if (cmd === "read_markdown_file") {
          if (args?.path === "/v/board.canvas") {
            return {
              path: "/v/board.canvas",
              file_name: "board.canvas",
              content: CANVAS,
              size: 1,
            };
          }
          throw `Could not read ${args?.path}: stream did not contain valid UTF-8`;
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

  const titleButton = () =>
    vi.waitFor(() => {
      const b = host.querySelector<HTMLButtonElement>(".canvas-node__open");
      if (!b) throw new Error("no title button yet");
      return b;
    });

  it("shows the image in its folder instead of opening it as a document", async () => {
    const button = await titleButton();
    expect(button.title).toBe("Show pic.png in its folder");
    await act(async () => button.click());
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(REVEAL, { paths: ["/v/pic.png"] }),
    );
    expect(invoke).not.toHaveBeenCalledWith("read_markdown_file", {
      path: "/v/pic.png",
    });
    expect(useToastStore.getState().toasts).toEqual([]);
    const s = useDocumentStore.getState();
    expect(s.path).toBe("/v/board.canvas");
    expect(s.tabs.length).toBe(1);
  });

  it("says why in a toast when the folder cannot be shown", async () => {
    revealError = "No such file or directory (os error 2)";
    const button = await titleButton();
    await act(async () => button.click());
    await vi.waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));
    const t = useToastStore.getState().toasts[0];
    expect(t.kind).toBe("error");
    expect(t.message).toBe(
      "Could not show pic.png in its folder: No such file or directory (os error 2)",
    );
    expect(useDocumentStore.getState().path).toBe("/v/board.canvas");
  });
});
