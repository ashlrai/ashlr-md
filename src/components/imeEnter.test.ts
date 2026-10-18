/**
 * An Enter that commits an IME composition belongs to the input method. In
 * the command palette, the find bar, the AI chat and the memory field it
 * used to also run the selected command, jump to the next match, send the
 * message or remember the text half typed; a plain Enter still does.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
// The AI sidebar shows its chat input only once it has a provider.
vi.mock("../ai/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ai/registry")>();
  const fake = {
    id: "fake",
    capabilities: { tier: 1, modelName: "fake" },
    isAvailable: async () => true,
    async *generate() {},
  };
  return {
    ...real,
    detectProvider: vi.fn().mockResolvedValue(fake),
    getCachedProvider: () => fake,
  };
});
// The palette's first row is "Open file", which opens the file dialog.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

import { useAIStore } from "../store/aiStore";
import { useMemoryStore } from "../store/memoryStore";
import { useUiStore } from "../store/uiStore";
import { AISidebar } from "./ai/AISidebar";
import { CommandPalette } from "./CommandPalette";
import { FindBar } from "./find/FindBar";
import { MemorySection } from "./settings/sections/MemorySection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pressEnter(target: Element, init: KeyboardEventInit = {}) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("an IME composition's Enter", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("does not run the palette's selected command", async () => {
    useUiStore.setState({ commandPaletteOpen: true });
    await act(async () => root.render(createElement(CommandPalette)));
    const input = host.querySelector("input");
    expect(input).not.toBeNull();
    expect(host.querySelector("[data-index='0']")).not.toBeNull();

    pressEnter(input!, { isComposing: true });
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);
    pressEnter(input!, { keyCode: 229 });
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);

    // A plain Enter runs the row, which closes the palette first.
    pressEnter(input!);
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it("does not move the find bar to the next match", async () => {
    const page = document.createElement("div");
    page.className = "app-content";
    page.innerHTML = `<div class="markdown-body"><p>fox fox fox</p></div>`;
    document.body.appendChild(page);
    useUiStore.setState({ findOpen: true });
    await act(async () => root.render(createElement(FindBar)));
    const input = host.querySelector("input") as HTMLInputElement;
    typeInto(input, "fox");
    const countText = () => host.querySelector(".find-count")?.textContent;
    expect(countText()).toBe("1/3");

    pressEnter(input, { isComposing: true });
    expect(countText()).toBe("1/3");
    pressEnter(input, { keyCode: 229 });
    expect(countText()).toBe("1/3");

    pressEnter(input);
    expect(countText()).toBe("2/3");
  });

  it("does not send a half typed AI chat message", async () => {
    useAIStore.setState({ open: true, messages: [] });
    await act(async () => root.render(createElement(AISidebar)));
    const input = host.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Chat input']",
    );
    expect(input).not.toBeNull();
    typeInto(input!, "日本");

    pressEnter(input!, { isComposing: true });
    expect(input!.value).toBe("日本");
    pressEnter(input!, { keyCode: 229 });
    expect(input!.value).toBe("日本");
    expect(useAIStore.getState().messages).toEqual([]);

    // A plain Enter sends it.
    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(input!.value).toBe("");
    expect(useAIStore.getState().messages[0]?.content).toBe("日本");
  });

  it("does not remember a half typed memory", async () => {
    useMemoryStore.setState({ items: [] });
    await act(async () => root.render(createElement(MemorySection)));
    const input = host.querySelector<HTMLInputElement>(".settings-memory-input")!;
    typeInto(input, "日本");

    pressEnter(input, { isComposing: true });
    pressEnter(input, { keyCode: 229 });
    expect(useMemoryStore.getState().items).toEqual([]);
    expect(input.value).toBe("日本");

    pressEnter(input);
    expect(useMemoryStore.getState().items.map((i) => i.text)).toEqual(["日本"]);
  });
});

describe("no raw Enter comparison bypasses isActionEnter", () => {
  // Source files compare e.key to "Enter" only inside keymap.ts, so a new
  // submit handler cannot forget the IME composition check. The WYSIWYG
  // editor's list continuation needs a live Milkdown view to exercise, so
  // this is what keeps it on the shared check.
  const sources = import.meta.glob<string>(
    ["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../lib/keymap.ts"],
    { query: "?raw", import: "default", eager: true },
  );

  it("compares e.key to Enter only in keymap.ts", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    const raw = /\.key\s*[!=]==?\s*["'`]Enter["'`]/;
    const offenders = Object.entries(sources)
      .filter(([, src]) => raw.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
