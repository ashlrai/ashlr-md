/**
 * The keyboard shortcut cheat sheet (#34): mod+/ opens it from anywhere,
 * it lists every registry shortcut plus the editor's own, labelled for the
 * platform, and Escape closes it.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

import { getCommands, getShortcutCommands } from "../lib/commands";
import { handleGlobalKeyDown } from "../lib/globalKeys";
import { formatShortcut } from "../lib/keymap";
import { EDITOR_SHORTCUTS, shortcutSheet } from "../lib/shortcutSheet";
import { useUiStore } from "../store/uiStore";
import { ShortcutSheet } from "./ShortcutSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("shortcutSheet()", () => {
  it("lists every registry shortcut exactly once, plus the editor's own", () => {
    const keys = shortcutSheet(getCommands()).flatMap((g) =>
      g.rows.flatMap((r) => r.keys),
    );
    const registry = [
      ...new Set(getShortcutCommands().map((c) => c.shortcut as string)),
    ];
    expect(keys.sort()).toEqual(
      [...registry, ...EDITOR_SHORTCUTS.flatMap((r) => r.keys)].sort(),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("puts the cheat sheet itself under Help and the editor bindings last", () => {
    const groups = shortcutSheet(getCommands());
    const help = groups.find((g) => g.group === "Help");
    expect(help?.rows).toContainEqual({ title: "Keyboard shortcuts", keys: ["mod+/"] });
    expect(groups[groups.length - 1].group).toBe("In the editor");
  });
});

describe("<ShortcutSheet />", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useUiStore.setState({ shortcutsOpen: false, commandPaletteOpen: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("mod+/ opens it (closing the palette), and it shows platform labels", () => {
    useUiStore.setState({ commandPaletteOpen: true });
    const mac = /Mac|iPhone|iPad|iPod/.test(
      navigator.platform || navigator.userAgent || "",
    );
    act(() => {
      handleGlobalKeyDown(
        new KeyboardEvent("keydown", { key: "/", metaKey: mac, ctrlKey: !mac }),
      );
    });
    expect(useUiStore.getState().shortcutsOpen).toBe(true);
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);

    act(() => root.render(createElement(ShortcutSheet)));
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-labelledby")).toBe("shortcut-sheet-title");
    const kbds = [...host.querySelectorAll("kbd")].map((k) => k.textContent);
    expect(kbds).toContain(formatShortcut("mod+k"));
    expect(kbds).toContain(formatShortcut("mod+/"));
    expect(kbds).toContain(formatShortcut("mod+i"));
  });

  it("Escape closes it", () => {
    useUiStore.setState({ shortcutsOpen: true });
    act(() => root.render(createElement(ShortcutSheet)));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(useUiStore.getState().shortcutsOpen).toBe(false);
  });

  it("its list is a named Tab stop, so the keyboard can scroll it", () => {
    useUiStore.setState({ shortcutsOpen: true });
    act(() => root.render(createElement(ShortcutSheet)));
    const list = host.querySelector<HTMLElement>(".shortcut-sheet-body");
    expect(list?.tabIndex).toBe(0);
    expect(list?.getAttribute("role")).toBe("region");
    expect(list?.getAttribute("aria-label")).toBe("Shortcuts");
  });
});
