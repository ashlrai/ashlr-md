/**
 * Switching tabs in the read view went to the top of the document every
 * time, so the place in a long document was lost on each switch. A tab
 * switched back to now returns to where it was read; a newly opened
 * document still starts at the top.
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
  ask: vi.fn().mockResolvedValue(true),
}));

// Banners that ask the backend about the app itself; not under test here.
vi.mock("../DefaultHandlerBanner", () => ({ DefaultHandlerBanner: () => null }));
vi.mock("../ActivationBanner", () => ({ ActivationBanner: () => null }));
vi.mock("../DigestCard", () => ({ DigestCard: () => null }));

import { useDocumentStore } from "../../store/documentStore";
import { Shell } from "./Shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class {
  observe() {}
  disconnect() {}
  unobserve() {}
};

const doc = (name: string) => ({
  path: `/n/${name}`,
  file_name: name,
  content: `# ${name}\n\n${"A paragraph.\n\n".repeat(50)}`,
  size: 1,
});

describe("the read view's place in each tab", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    invoke.mockImplementation(async (cmd: string, args?: { path?: string }) =>
      cmd === "read_markdown_file"
        ? doc(String(args?.path).split("/").pop() ?? "")
        : undefined,
    );
    useDocumentStore.setState({ viewMode: "read" });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Shell, { dragOver: false })));
  });

  afterEach(() => {
    for (const t of useDocumentStore.getState().tabs) {
      useDocumentStore.getState().closeTab(t.id);
    }
    act(() => root.unmount());
    host.remove();
  });

  const main = () => host.querySelector<HTMLElement>("main.app-content") as HTMLElement;
  async function scrollTo(top: number) {
    await act(async () => {
      main().scrollTop = top;
      main().dispatchEvent(new Event("scroll"));
    });
  }
  const open = (name: string) =>
    act(async () => {
      await useDocumentStore.getState().openPath(`/n/${name}`);
    });
  const switchTo = (name: string) =>
    act(async () => {
      const s = useDocumentStore.getState();
      const tab = s.tabs.find((t) => t.fileName === name);
      if (tab) s.switchTab(tab.id);
    });

  it("returns to where each tab was read", async () => {
    await open("a.md");
    await scrollTo(400);
    await open("b.md");
    expect(main().scrollTop).toBe(0);
    await scrollTo(150);
    await switchTo("a.md");
    expect(main().scrollTop).toBe(400);
    await switchTo("b.md");
    expect(main().scrollTop).toBe(150);
  });

  it("starts a newly opened document at the top", async () => {
    await open("a.md");
    await scrollTo(400);
    await open("c.md");
    expect(main().scrollTop).toBe(0);
  });
});
