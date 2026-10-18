import { describe, expect, it } from "vitest";
import { isDismissEscape } from "./keymap";

describe("isDismissEscape", () => {
  it("is true for a plain Escape", () => {
    expect(isDismissEscape(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
  });

  it("is false for an Escape that belongs to an IME composition", () => {
    expect(
      isDismissEscape(
        new KeyboardEvent("keydown", { key: "Escape", isComposing: true }),
      ),
    ).toBe(false);
    // WebKit: the Escape that ends a composition has keyCode 229.
    expect(
      isDismissEscape(new KeyboardEvent("keydown", { key: "Escape", keyCode: 229 })),
    ).toBe(false);
  });

  it("is false for other keys", () => {
    expect(isDismissEscape(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);
  });

  it("reads a React event's native event", () => {
    const composing = new KeyboardEvent("keydown", {
      key: "Escape",
      isComposing: true,
    });
    expect(isDismissEscape({ key: "Escape", nativeEvent: composing })).toBe(false);
    const plain = new KeyboardEvent("keydown", { key: "Escape" });
    expect(isDismissEscape({ key: "Escape", nativeEvent: plain })).toBe(true);
  });
});
