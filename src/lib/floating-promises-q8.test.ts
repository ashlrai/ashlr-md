import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("./commands", () => ({
  getShortcutCommands: () => [{ shortcut: "mod+o", run: mocks.run }],
}));
vi.mock("./wikilink", () => ({
  resolveWikilink: mocks.resolve,
  useWikilinkCacheVersion: () => 0,
}));
vi.mock("../components/viewer/Renderer", () => ({ Renderer: () => null }));

import { WikiEmbed } from "../components/viewer/WikiEmbed";
import { Wikilink } from "../components/viewer/Wikilink";
import { useToastStore } from "../store/toastStore";
import { handleGlobalKeyDown } from "./globalKeys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.clearAllMocks();
  useToastStore.getState().clear();
});

it.each([
  "reject",
  "throw",
  "resolve",
])("handles a shortcut that will %s", async (mode) => {
  mocks.run.mockImplementation(() => {
    if (mode === "throw") throw new Error("failure");
    return mode === "reject" ? Promise.reject(new Error("failure")) : Promise.resolve();
  });
  const event = new KeyboardEvent("keydown", {
    key: "o",
    ctrlKey: !/Mac|iPhone|iPad|iPod/.test(
      navigator.platform || navigator.userAgent || "",
    ),
    metaKey: /Mac|iPhone|iPad|iPod/.test(
      navigator.platform || navigator.userAgent || "",
    ),
    cancelable: true,
  });
  handleGlobalKeyDown(event);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(event.defaultPrevented).toBe(true);
  expect(mocks.run).toHaveBeenCalledOnce();
  expect(useToastStore.getState().toasts).toHaveLength(mode === "resolve" ? 0 : 1);
});

it.each([
  "link",
  "embed",
])("renders a rejected %s resolution as broken", async (kind) => {
  mocks.resolve.mockRejectedValue(new Error("resolver unavailable"));
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(kind === "link" ? Wikilink : WikiEmbed, { target: "missing" }),
      ),
    );
    expect(host.querySelector(".wikilink--broken, .wikiembed--broken")).not.toBeNull();
    if (kind === "link") expect(host.querySelector("button")?.disabled).toBe(true);
  } finally {
    act(() => root.unmount());
  }
});

it.each(["link", "embed"])("ignores a stale rejected %s resolution", async (kind) => {
  let rejectOld!: (reason: Error) => void;
  mocks.resolve.mockReturnValueOnce(
    new Promise<string>((_, reject) => {
      rejectOld = reject;
    }),
  );
  mocks.resolve.mockResolvedValueOnce(null);
  const host = document.createElement("div");
  const root = createRoot(host);
  const component = kind === "link" ? Wikilink : WikiEmbed;
  try {
    await act(async () => root.render(createElement(component, { target: "old" })));
    await act(async () => root.render(createElement(component, { target: "new" })));
    await act(async () => rejectOld(new Error("late failure")));
    expect(host.textContent).toContain("new");
    expect(host.textContent).not.toContain("old");
  } finally {
    act(() => root.unmount());
  }
});
