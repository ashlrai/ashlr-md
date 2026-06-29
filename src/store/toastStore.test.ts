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
