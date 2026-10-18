import { describe, expect, it } from "vitest";
import { isActionEnter, isDismissEscape } from "./keymap";

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

describe("isActionEnter", () => {
  it("is true for a plain Enter", () => {
    expect(isActionEnter(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(true);
  });

  it("is false for an Enter that commits an IME composition", () => {
    expect(
      isActionEnter(new KeyboardEvent("keydown", { key: "Enter", isComposing: true })),
    ).toBe(false);
    // WebKit: the Enter that commits a composition has keyCode 229.
    expect(
      isActionEnter(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229 })),
    ).toBe(false);
  });

  it("is false for other keys", () => {
    expect(isActionEnter(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
  });

  it("reads a React event's native event", () => {
    const composing = new KeyboardEvent("keydown", { key: "Enter", isComposing: true });
    expect(isActionEnter({ key: "Enter", nativeEvent: composing })).toBe(false);
    const plain = new KeyboardEvent("keydown", { key: "Enter" });
    expect(isActionEnter({ key: "Enter", nativeEvent: plain })).toBe(true);
  });
});
