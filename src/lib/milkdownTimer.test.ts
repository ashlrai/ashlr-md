import { createTimer } from "@milkdown/kit/ctx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression coverage for patches/@milkdown%2Fctx@7.21.2.patch. Resolved
// readiness timers must not access DOM globals after an editor is destroyed.
describe("Milkdown readiness timers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("cancels the timeout when resolved and reuses the settled promise", async () => {
    const timer = createTimer("resolved", 100).create(new Map());
    const pending = timer.start();
    expect(timer.start()).toBe(pending);
    expect(vi.getTimerCount()).toBe(1);

    timer.done();
    await pending;
    expect(timer.status).toBe("resolved");
    expect(vi.getTimerCount()).toBe(0);
    expect(timer.start()).toBe(pending);

    const removeListener = vi.spyOn(globalThis, "removeEventListener");
    try {
      await vi.advanceTimersByTimeAsync(100);
      timer.done();
      expect(removeListener).not.toHaveBeenCalled();
      expect(timer.status).toBe("resolved");
    } finally {
      removeListener.mockRestore();
    }
  });

  it("still rejects unresolved timers at the deadline", async () => {
    const timer = createTimer("unresolved", 100).create(new Map());
    const rejected = expect(timer.start()).rejects.toThrow(
      "Timing unresolved timeout.",
    );
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(timer.status).toBe("rejected");
    expect(vi.getTimerCount()).toBe(0);
    timer.done();
    expect(timer.status).toBe("rejected");
  });

  it("resolves only the matching timer when editors share a timer type", async () => {
    const type = createTimer("shared", 100);
    const first = type.create(new Map());
    const second = type.create(new Map());
    const pending = first.start();
    const rejected = expect(second.start()).rejects.toThrow("Timing shared timeout.");
    first.done();
    await pending;
    expect(second.status).toBe("pending");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(first.status).toBe("resolved");
    expect(second.status).toBe("rejected");
  });
});
