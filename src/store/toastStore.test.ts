import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "./toastStore";

function reset() {
  // Clear all toasts and any live timers via the store's own clear().
  useToastStore.getState().clear();
}

describe("toastStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Creation ────────────────────────────────────────────────────────────

  it("push returns a numeric id and adds the toast", () => {
    const id = useToastStore.getState().push({ message: "saved" });
    expect(typeof id).toBe("number");
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].id).toBe(id);
    expect(toasts[0].message).toBe("saved");
  });

  it("defaults to info kind when kind is omitted", () => {
    useToastStore.getState().push({ message: "hello" });
    expect(useToastStore.getState().toasts[0].kind).toBe("info");
  });

  it("respects explicit severity levels — success, error, info", () => {
    useToastStore.getState().push({ kind: "success", message: "ok" });
    useToastStore.getState().push({ kind: "error", message: "boom" });
    useToastStore.getState().push({ kind: "info", message: "fyi" });
    const kinds = useToastStore.getState().toasts.map((t) => t.kind);
    expect(kinds).toEqual(["success", "error", "info"]);
  });

  // ── Removal ─────────────────────────────────────────────────────────────

  it("dismiss removes the toast immediately", () => {
    const id = useToastStore.getState().push({ message: "gone" });
    useToastStore.getState().dismiss(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("dismissing the same toast twice leaves the remaining toasts unchanged", () => {
    const firstId = useToastStore.getState().push({ message: "first", timeout: 0 });
    const dismissedId = useToastStore
      .getState()
      .push({ message: "gone", timeout: 500 });
    const lastId = useToastStore.getState().push({ message: "last", timeout: 1000 });

    useToastStore.getState().dismiss(dismissedId);
    const remaining = useToastStore.getState().toasts;
    expect(remaining.map((toast) => toast.id)).toEqual([firstId, lastId]);
    expect(vi.getTimerCount()).toBe(1);

    expect(() => useToastStore.getState().dismiss(dismissedId)).not.toThrow();
    expect(useToastStore.getState().toasts).toEqual(remaining);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([firstId]);
  });

  it("dismissing a nonexistent toast is a no-op: no throw, toasts and timers unchanged", () => {
    const firstId = useToastStore.getState().push({ message: "first", timeout: 0 });
    const lastId = useToastStore.getState().push({ message: "last", timeout: 1000 });
    const before = useToastStore.getState().toasts;
    const unknownId = Math.max(firstId, lastId) + 1000;

    expect(() => useToastStore.getState().dismiss(unknownId)).not.toThrow();
    expect(() => useToastStore.getState().dismiss(-1)).not.toThrow();
    expect(() => useToastStore.getState().dismiss(Number.NaN)).not.toThrow();

    expect(useToastStore.getState().toasts).toEqual(before);
    expect(useToastStore.getState().toasts.map((t) => t.id)).toEqual([firstId, lastId]);
    // The surviving toast's pending auto-dismiss timer is untouched.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(useToastStore.getState().toasts.map((t) => t.id)).toEqual([firstId]);
  });

  it("dismiss on an empty queue does not throw", () => {
    expect(() => useToastStore.getState().dismiss(12345)).not.toThrow();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("dismiss preserves the other queued toast and its timeout", () => {
    const dismissedId = useToastStore
      .getState()
      .push({ message: "gone", timeout: 500 });
    const remainingId = useToastStore
      .getState()
      .push({ message: "stays", timeout: 1000 });

    useToastStore.getState().dismiss(dismissedId);
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ id: remainingId, message: "stays" }),
    ]);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(500);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([
      remainingId,
    ]);
    vi.advanceTimersByTime(500);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("clear removes all toasts at once", () => {
    useToastStore.getState().push({ message: "a" });
    useToastStore.getState().push({ message: "b" });
    useToastStore.getState().clear();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  // ── Auto-dismiss ────────────────────────────────────────────────────────

  it("auto-dismisses after the default 2500 ms timeout", () => {
    useToastStore.getState().push({ message: "auto" });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(2500);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("timeout: 0 disables auto-dismiss", () => {
    useToastStore.getState().push({ message: "sticky", timeout: 0 });
    vi.advanceTimersByTime(10_000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it("custom timeout is respected", () => {
    useToastStore.getState().push({ message: "quick", timeout: 500 });
    vi.advanceTimersByTime(499);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("expires staggered toasts according to their own lifetimes", () => {
    const firstId = useToastStore.getState().push({ message: "first", timeout: 1000 });
    vi.advanceTimersByTime(400);
    const secondId = useToastStore.getState().push({ message: "second", timeout: 800 });

    vi.advanceTimersByTime(599);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([
      firstId,
      secondId,
    ]);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([
      secondId,
    ]);
    vi.advanceTimersByTime(199);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([
      secondId,
    ]);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  // ── Cap / eviction ──────────────────────────────────────────────────────

  it("evicts the oldest toast when the MAX_TOASTS (4) cap is exceeded", () => {
    const ids = [
      useToastStore.getState().push({ message: "1", timeout: 0 }),
      useToastStore.getState().push({ message: "2", timeout: 0 }),
      useToastStore.getState().push({ message: "3", timeout: 0 }),
      useToastStore.getState().push({ message: "4", timeout: 0 }),
    ];
    // 5th push should evict the oldest (ids[0]).
    useToastStore.getState().push({ message: "5", timeout: 0 });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(4);
    expect(toasts.find((t) => t.id === ids[0])).toBeUndefined();
    expect(toasts.map((t) => t.message)).toEqual(["2", "3", "4", "5"]);
  });

  // ── onClick callback ────────────────────────────────────────────────────

  it("stores and exposes the onClick handler", () => {
    const handler = vi.fn();
    useToastStore.getState().push({ message: "click me", onClick: handler });
    const toast = useToastStore.getState().toasts[0];
    toast.onClick?.();
    expect(handler).toHaveBeenCalledOnce();
  });
});
