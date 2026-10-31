/**
 * Switching tabs in the read view went to the top of the document every
 * time, so the place in a long document was lost on each switch. A tab
 * switched back to now returns to where it was read; a newly opened
 * document still starts at the top. A change on disk to the document shown
 * (an agent writing it) went to the top too; it now keeps the place.
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

  it("keeps keyboard focus on tabs when their document is rendered", async () => {
    await open("a.md");
    await open("b.md");
    const tabs = host.querySelectorAll<HTMLElement>('[role="tab"]');
    tabs[0].focus();
    for (const [from, key, to] of [
      [0, "ArrowRight", 1],
      [1, "ArrowLeft", 0],
    ] as const) {
      await act(async () => {
        tabs[from].dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
      expect(document.activeElement).toBe(tabs[to]);
      expect(tabs[to].getAttribute("aria-selected")).toBe("true");
    }
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
  const changeOnDisk = (name: string, text: string) =>
    act(async () => {
      const s = useDocumentStore.getState();
      expect(s.path).toBe(`/n/${name}`);
      s.handleDiskUpdate(text, `v-${text.length}`);
    });

  it("keeps the place when the document shown changes on disk", async () => {
    await open("a.md");
    await scrollTo(400);
    const nonce = useDocumentStore.getState().reloadNonce;
    await changeOnDisk("a.md", `# a.md\n\n${"Another paragraph.\n\n".repeat(60)}`);
    expect(useDocumentStore.getState().reloadNonce).toBe(nonce + 1);
    expect(main().scrollTop).toBe(400);
    await changeOnDisk("a.md", `# a.md\n\n${"A third paragraph.\n\n".repeat(60)}`);
    expect(main().scrollTop).toBe(400);
  });

  it("does not take focus from a field when the document changes on disk", async () => {
    await open("a.md");
    const field = document.createElement("input");
    document.body.appendChild(field);
    try {
      field.focus();
      await changeOnDisk("a.md", "# a.md\n\nChanged.\n");
      expect(document.activeElement).toBe(field);
    } finally {
      field.remove();
    }
  });

  it("gives focus back to the document after a reload when it was lost", async () => {
    await open("a.md");
    (document.activeElement as HTMLElement | null)?.blur();
    await changeOnDisk("a.md", "# a.md\n\nChanged.\n");
    expect(document.activeElement).toBe(main());
  });
});
