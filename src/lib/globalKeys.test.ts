import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { useUiStore } from "../store/uiStore";
import { handleGlobalKeyDown } from "./globalKeys";

function key(init: KeyboardEventInit) {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

describe("handleGlobalKeyDown: Zen mode", () => {
  beforeEach(() => {
    useUiStore.setState({ zenMode: true });
  });

  it("leaves Zen mode on a plain Escape", () => {
    const e = key({ key: "Escape" });
    handleGlobalKeyDown(e);
    expect(useUiStore.getState().zenMode).toBe(false);
    expect(e.defaultPrevented).toBe(true);
  });

  it("stays in Zen mode on an Escape that ends an IME composition", () => {
    handleGlobalKeyDown(key({ key: "Escape", isComposing: true }));
    expect(useUiStore.getState().zenMode).toBe(true);
    // WebKit reports the composition's Escape with keyCode 229.
    handleGlobalKeyDown(key({ key: "Escape", keyCode: 229 }));
    expect(useUiStore.getState().zenMode).toBe(true);
  });
});
