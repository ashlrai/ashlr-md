/**
 * macOS: Option changes `KeyboardEvent.key` (Option+F reports "ƒ"), so the
 * global matcher falls back to `e.code` for a letter when Option is held.
 * keymap.ts reads the platform once at import, so this file imports it fresh
 * under a mac `navigator.platform`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Keymap = typeof import("./keymap");

function key(init: KeyboardEventInit) {
  return new KeyboardEvent("keydown", init);
}

async function importKeymap(platform: string): Promise<Keymap> {
  vi.stubGlobal("navigator", { ...navigator, platform, userAgent: "" });
  vi.resetModules();
  return import("./keymap");
}

describe("matchShortcut on macOS", () => {
  let mac: Keymap;

  beforeAll(async () => {
    mac = await importKeymap("MacIntel");
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("matches Cmd+Option+F, which reports key ƒ and code KeyF", () => {
    const e = key({ key: "ƒ", code: "KeyF", metaKey: true, altKey: true });
    expect(mac.matchShortcut(e, "mod+alt+f")).toBe(true);
  });

  it("still needs Option for an alt shortcut and the right physical key", () => {
    expect(
      mac.matchShortcut(key({ key: "ƒ", code: "KeyF", metaKey: true }), "mod+alt+f"),
    ).toBe(false);
    expect(
      mac.matchShortcut(
        key({ key: "∂", code: "KeyD", metaKey: true, altKey: true }),
        "mod+alt+f",
      ),
    ).toBe(false);
    // Without Option the code fallback never applies.
    expect(
      mac.matchShortcut(key({ key: "ƒ", code: "KeyF", metaKey: true }), "mod+f"),
    ).toBe(false);
  });

  it("matches by character when Option still types a letter", () => {
    // A layout whose Option layer types "f" on another physical key.
    expect(
      mac.matchShortcut(
        key({ key: "f", code: "KeyU", metaKey: true, altKey: true }),
        "mod+alt+f",
      ),
    ).toBe(true);
    expect(
      mac.matchShortcut(
        key({ key: "u", code: "KeyF", metaKey: true, altKey: true }),
        "mod+alt+f",
      ),
    ).toBe(false);
  });
});

describe("matchShortcut on other platforms", () => {
  let other: Keymap;

  beforeAll(async () => {
    other = await importKeymap("Win32");
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("matches Ctrl+Alt+F by e.key as before", () => {
    const e = key({ key: "f", code: "KeyF", ctrlKey: true, altKey: true });
    expect(other.matchShortcut(e, "mod+alt+f")).toBe(true);
  });

  it("does not fall back to e.code", () => {
    const e = key({ key: "ƒ", code: "KeyF", ctrlKey: true, altKey: true });
    expect(other.matchShortcut(e, "mod+alt+f")).toBe(false);
  });
});
