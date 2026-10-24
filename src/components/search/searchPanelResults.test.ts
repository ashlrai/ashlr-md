/**
 * The file search shows the results of the query in the box. A search for
 * an earlier query that answered after a later one replaced its results, so
 * the panel listed hits for text that was no longer being searched.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pending = new Map<string, (r: unknown) => void>();
const failing = new Map<string, (e: unknown) => void>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(
    (_cmd: string, args: { query: string }) =>
      new Promise((resolve, reject) => {
        pending.set(args.query, resolve);
        failing.set(args.query, reject);
      }),
  ),
}));

import { useRecentStore } from "../../store/recentStore";
import { useUiStore } from "../../store/uiStore";
import { SearchPanel } from "./SearchPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hit = (query: string) => [
  {
    path: `/notes/${query}.md`,
    fileName: `${query}.md`,
    matches: [{ lineNo: 1, snippet: `a line with ${query}` }],
  },
];

describe("search panel results", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    pending.clear();
    failing.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useRecentStore.setState({
      recents: [{ path: "/notes/a.md", fileName: "a.md", openedAt: 1 }],
    });
    useUiStore.setState({ searchOpen: true });
    act(() => root.render(createElement(SearchPanel)));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  const type = (text: string) => {
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
    act(() => {
      vi.advanceTimersByTime(200);
    });
  };

  it("keeps the newer query's results when an older search answers last", async () => {
    type("alpha");
    type("beta");
    expect([...pending.keys()]).toEqual(["alpha", "beta"]);
    await act(async () => {
      pending.get("beta")?.(hit("beta"));
    });
    await act(async () => {
      pending.get("alpha")?.(hit("alpha"));
    });
    const names = Array.from(host.querySelectorAll(".search-file__name")).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["beta.md"]);
    expect(host.querySelector(".search-panel__summary")?.textContent).toBe(
      "1 match in 1 file",
    );
  });

  /** A search that failed read as "0 matches in 0 files". */
  it("says why a search failed instead of showing no matches", async () => {
    type("alpha");
    await act(async () => {
      failing.get("alpha")?.("the search stopped: out of memory");
    });
    const summary = host.querySelector(".search-panel__summary");
    expect(summary?.textContent).toBe(
      "Couldn’t search the files: the search stopped: out of memory",
    );
    expect(summary?.getAttribute("role")).toBe("alert");
    type("beta");
    await act(async () => {
      pending.get("beta")?.(hit("beta"));
    });
    expect(host.querySelector(".search-panel__summary")?.textContent).toBe(
      "1 match in 1 file",
    );
  });
});
