import { describe, expect, it, vi } from "vitest";
import { flushPendingEdits, registerPendingEdits } from "./pendingEdits";

describe("pendingEdits", () => {
  it("asks each registered editor, until it unregisters, and survives one that throws", () => {
    const a = vi.fn();
    const bad = vi.fn(() => {
      throw new Error("gone");
    });
    const offA = registerPendingEdits(a);
    const offBad = registerPendingEdits(bad);
    flushPendingEdits();
    expect(a).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);
    offA();
    offBad();
    flushPendingEdits();
    expect(a).toHaveBeenCalledTimes(1);
  });
});
