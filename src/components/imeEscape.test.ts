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

import { useUiStore } from "../store/uiStore";
import { CommandPalette } from "./CommandPalette";
import { ExportDialog } from "./export/ExportDialog";
import { FindBar } from "./find/FindBar";
import { SearchPanel } from "./search/SearchPanel";
import { SettingsPanel } from "./settings/SettingsPanel";

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
