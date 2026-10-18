/**
 * An Escape that ends an IME composition (or closes its candidate list) in a
 * dialog's field belongs to the input method. Each overlay used to treat it
 * as "close", dropping what was being typed; a plain Escape still closes.
 */
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { useAIStore } from "../store/aiStore";
import { useUiStore } from "../store/uiStore";
import { SelectionPopover } from "./ai/SelectionPopover";
import { CommandPalette } from "./CommandPalette";
import { ExportDialog } from "./export/ExportDialog";
import { FindBar } from "./find/FindBar";
import { SearchPanel } from "./search/SearchPanel";
import { SettingsPanel } from "./settings/SettingsPanel";
import { AiProviderSection } from "./settings/sections/AiProviderSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type OpenFlag =
  | "commandPaletteOpen"
  | "exportOpen"
  | "findOpen"
  | "searchOpen"
  | "settingsOpen";

const cases: [string, FunctionComponent, OpenFlag][] = [
  ["SettingsPanel", SettingsPanel, "settingsOpen"],
  ["ExportDialog", ExportDialog, "exportOpen"],
  ["CommandPalette", CommandPalette, "commandPaletteOpen"],
  ["SearchPanel", SearchPanel, "searchOpen"],
  ["FindBar", FindBar, "findOpen"],
];

function pressEscape(target: Element, init: KeyboardEventInit = {}) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

describe("overlays ignore an IME composition's Escape", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it.each(
    cases,
  )("%s stays open on a composing Escape and closes on a plain one", async (_name, C, flag) => {
    useUiStore.setState({ [flag]: true });
    // Async so the settings sections' load-on-mount effects settle inside act.
    await act(async () => root.render(createElement(C)));
    const field = host.querySelector("input, textarea") ?? host.firstElementChild;
    expect(field).not.toBeNull();

    pressEscape(field!, { isComposing: true });
    expect(useUiStore.getState()[flag]).toBe(true);
    pressEscape(field!, { keyCode: 229 });
    expect(useUiStore.getState()[flag]).toBe(true);

    pressEscape(field!);
    expect(useUiStore.getState()[flag]).toBe(false);
  });
});

describe("other Escape handlers ignore an IME composition's Escape", () => {
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

  it("the selection popover stays up on a composing Escape", async () => {
    const page = document.createElement("div");
    page.className = "markdown-body";
    page.innerHTML = "<p>some selected words</p>";
    document.body.appendChild(page);
    await act(async () => root.render(createElement(SelectionPopover)));

    const text = page.querySelector("p")!.firstChild!;
    act(() => {
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 4);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const popover = () => host.querySelector(".ai-selection-popover");
    expect(popover()).not.toBeNull();

    pressEscape(document.body, { isComposing: true });
    expect(popover()).not.toBeNull();
    pressEscape(document.body, { keyCode: 229 });
    expect(popover()).not.toBeNull();

    pressEscape(document.body);
    expect(popover()).toBeNull();
  });

  it("the hosted token field keeps editing on a composing Escape", async () => {
    useAIStore.setState({ hostedToken: null });
    await act(async () => root.render(createElement(AiProviderSection)));
    const add = host.querySelector<HTMLButtonElement>(
      "button[aria-label='Add hosted AI token']",
    );
    act(() => add!.click());
    const field = () =>
      host.querySelector("input[aria-label='Hosted AI bearer token']");
    expect(field()).not.toBeNull();

    pressEscape(field()!, { isComposing: true });
    expect(field()).not.toBeNull();
    pressEscape(field()!, { keyCode: 229 });
    expect(field()).not.toBeNull();

    pressEscape(field()!);
    expect(field()).toBeNull();
  });
});

describe("no raw Escape comparison bypasses isDismissEscape", () => {
  // Source files compare e.key to "Escape" only inside keymap.ts, so a new
  // dismiss handler cannot forget the IME composition check. The AI abort in
  // MarkdownEditor needs a live Milkdown view to exercise, so this is what
  // keeps it on the shared check.
  const sources = import.meta.glob<string>(
    ["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../lib/keymap.ts"],
    { query: "?raw", import: "default", eager: true },
  );

  it("finds the sources", () => {
    expect(Object.keys(sources).some((p) => p.endsWith("MarkdownEditor.tsx"))).toBe(
      true,
    );
  });

  it("compares e.key to Escape only in keymap.ts", () => {
    const raw = /\.key\s*[!=]==?\s*["'`]Escape["'`]/;
    const offenders = Object.entries(sources)
      .filter(([, src]) => raw.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
