import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkScroll } from "./syncScroll";

// requestAnimationFrame is replaced by a manual queue so each frame is explicit.
// Ids only ever increase, as in a browser, so a stale cancel cannot hit a new frame.
let nextId = 0;
let queue = new Map<number, (t: number) => void>();

beforeEach(() => {
  nextId = 0;
  queue = new Map();
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    queue.set(++nextId, cb);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queue.delete(id);
  });
});
afterEach(() => vi.unstubAllGlobals());

function flushFrame() {
  const pending = [...queue.values()];
  queue = new Map();
  for (const cb of pending) cb(0);
}

function pane(scrollHeight: number, clientHeight: number, scrollTop = 0): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
  el.scrollTop = scrollTop;
  return el;
}

describe("linkScroll", () => {
  it("moves the other pane to the same scroll percentage", () => {
    const a = pane(1100, 100); // max 1000
    const b = pane(2100, 100); // max 2000
    linkScroll(a, b);
    a.scrollTop = 500;
    a.dispatchEvent(new Event("scroll"));
    flushFrame();
    expect(b.scrollTop).toBe(1000);
  });

  it("works in both directions", () => {
    const a = pane(1100, 100);
    const b = pane(2100, 100);
    linkScroll(a, b);
    b.scrollTop = 500; // 25%
    b.dispatchEvent(new Event("scroll"));
    flushFrame();
    expect(a.scrollTop).toBe(250);
  });

  it("does not echo: the induced scroll event on the follower is ignored until the lock releases", () => {
    const a = pane(1100, 100);
    const b = pane(2100, 100);
    linkScroll(a, b);
    a.scrollTop = 400;
    a.dispatchEvent(new Event("scroll"));
    flushFrame(); // drives b
    b.dispatchEvent(new Event("scroll")); // induced event, lock still held
    flushFrame();
    expect(a.scrollTop).toBe(400);
    flushFrame(); // release frame
    b.scrollTop = 1000;
    b.dispatchEvent(new Event("scroll")); // a real user scroll now drives a
    flushFrame();
    expect(a.scrollTop).toBe(500);
  });

  it("a pane with nothing to scroll reports ratio 0 and does not divide by zero", () => {
    const a = pane(100, 100, 0); // max 0
    const b = pane(2100, 100, 700);
    linkScroll(a, b);
    a.dispatchEvent(new Event("scroll"));
    flushFrame();
    expect(b.scrollTop).toBe(0);
  });

  it("the disposer detaches both listeners", () => {
    const a = pane(1100, 100);
    const b = pane(2100, 100);
    const dispose = linkScroll(a, b);
    dispose();
    a.scrollTop = 500;
    a.dispatchEvent(new Event("scroll"));
    flushFrame();
    expect(b.scrollTop).toBe(0);
  });
});
