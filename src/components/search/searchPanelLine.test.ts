/**
 * A search hit names its line ("Line 7"), and clicking it opens the file at
 * that line. It opened the file at its top, so the hit had to be found again
 * by hand. These tests render the real read view and search panel, click a
 * hit and see which block is scrolled to.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DOC = [
  "# Plan", // 1
  "", // 2
  "Intro paragraph.", // 3
  "", // 4
  "## Goals", // 5
  "", // 6
  "Ship the needle fix.", // 7
  "Second line of it.", // 8
  "", // 9
  "## Later", // 10
  "", // 11
  "Another needle here.", // 12
  "",
].join("\n");

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useDocumentStore } from "../../store/documentStore";
import { useRecentStore } from "../../store/recentStore";
import { useUiStore } from "../../store/uiStore";
import { Renderer } from "../viewer/Renderer";
import { SearchPanel } from "./SearchPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("clicking a search hit", () => {
  let host: HTMLDivElement;
  let root: Root;
  const scrolled: Element[] = [];
  const openPath = vi.fn(async (_path: string) => null);

  beforeEach(async () => {
    vi.useFakeTimers();
    scrolled.length = 0;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "search_files"
        ? [
            {
              path: "/notes/plan.md",
              fileName: "plan.md",
              matches: [
                { lineNo: 7, snippet: "Ship the needle fix." },
                { lineNo: 12, snippet: "Another needle here." },
              ],
            },
          ]
        : undefined,
    );
    useRecentStore.setState({
      recents: [{ path: "/notes/plan.md", fileName: "plan.md", openedAt: 1 }],
    });
    useUiStore.setState({ searchOpen: true });
    useDocumentStore.setState({
      path: "/notes/plan.md",
      content: DOC,
      diskContent: DOC,
      viewMode: "read",
      openPath,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(
            "main",
            { className: "app-content" },
            createElement(
              "article",
              { className: "reading-surface" },
              createElement(Renderer, { content: DOC }),
            ),
          ),
          createElement(SearchPanel),
        ),
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  async function search(text: string) {
    const input = host.querySelector<HTMLInputElement>(".search-panel__input");
    if (!input) throw new Error("no input");
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      set?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
  }

  async function clickHit(line: number) {
    const hit = [...host.querySelectorAll<HTMLButtonElement>(".search-match")].find(
      (b) => b.title === `Line ${line}`,
    );
    if (!hit) throw new Error(`no hit for line ${line}`);
    await act(async () => hit.click());
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
  }

  it("scrolls the read view to the block holding the hit's line", async () => {
    await search("needle");
    await clickHit(7);
    expect(openPath).toHaveBeenCalledWith("/notes/plan.md");
    expect(scrolled.map((el) => el.textContent)).toEqual([
      "Ship the needle fix.\nSecond line of it.",
    ]);
  });

  it("goes to each hit's own line", async () => {
    await search("needle");
    await clickHit(12);
    expect(scrolled.map((el) => el.textContent)).toEqual(["Another needle here."]);
  });

  it("does not scroll when the file could not be opened", async () => {
    openPath.mockResolvedValueOnce("gone" as never);
    await search("needle");
    await clickHit(7);
    expect(scrolled).toEqual([]);
  });
});
