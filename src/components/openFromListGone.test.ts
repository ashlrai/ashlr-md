/**
 * A recent in the command palette, a file search hit or a related note
 * whose file was deleted or moved since the list was made. Opening it put
 * the read error in place of the open document, and with one tab (no tab
 * bar) the document could not be got back without opening another file.
 * The document now stays in view and a toast says why.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MISSING = "Could not read /n/gone.md: No such file or directory (os error 2)";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useDocumentStore } from "../store/documentStore";
import { useRecentStore } from "../store/recentStore";
import { useToastStore } from "../store/toastStore";
import { useUiStore } from "../store/uiStore";
import { CommandPalette } from "./CommandPalette";
import { SearchPanel } from "./search/SearchPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("opening a listed file that is gone", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    invoke.mockImplementation(async (cmd: string, args?: { path?: string }) => {
      if (cmd === "read_markdown_file") {
        if (args?.path === "/n/here.md") {
          return {
            path: "/n/here.md",
            file_name: "here.md",
            content: "# Here\n",
            size: 7,
          };
        }
        throw MISSING;
      }
      if (cmd === "search_files") {
        return [
          {
            path: "/n/gone.md",
            fileName: "gone.md",
            matches: [{ lineNo: 1, snippet: "x" }],
          },
        ];
      }
      return undefined;
    });
    useToastStore.setState({ toasts: [] });
    await useDocumentStore.getState().openPath("/n/here.md");
    useRecentStore.setState({
      recents: [
        { path: "/n/gone.md", fileName: "gone.md", openedAt: 2 },
        { path: "/n/here.md", fileName: "here.md", openedAt: 1 },
      ],
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    for (const t of useDocumentStore.getState().tabs) {
      useDocumentStore.getState().closeTab(t.id);
    }
  });

  async function expectKeptWithToast() {
    await vi.waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));
    const s = useDocumentStore.getState();
    expect(s.error).toBeNull();
    expect(s.path).toBe("/n/here.md");
    expect(s.content).toBe("# Here\n");
    expect(useToastStore.getState().toasts[0].message).toBe(
      `Could not open gone.md: ${MISSING}`,
    );
  }

  it("from the command palette's recents", async () => {
    useUiStore.setState({ commandPaletteOpen: true });
    await act(async () => root.render(createElement(CommandPalette)));
    const row = [...host.querySelectorAll<HTMLElement>("[role='option']")].find((el) =>
      el.textContent?.includes("Open recent: gone.md"),
    );
    if (!row) throw new Error("no recent row");
    await act(async () => row.click());
    await expectKeptWithToast();
  });

  it("from a file search hit", async () => {
    vi.useFakeTimers();
    useUiStore.setState({ searchOpen: true });
    await act(async () => root.render(createElement(SearchPanel)));
    const input = host.querySelector<HTMLInputElement>(".search-panel__input");
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      set?.call(input, "x");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    vi.useRealTimers();
    const hit = host.querySelector<HTMLButtonElement>(".search-match");
    await act(async () => hit?.click());
    await expectKeptWithToast();
  });
});
