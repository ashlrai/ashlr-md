import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForElement } from "./waitForElement";

describe("waitForElement", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("returns an already mounted element without starting a timer or observer", async () => {
    const element = document.createElement("main");
    element.className = "markdown-body";
    document.body.append(element);
    const observe = vi.spyOn(MutationObserver.prototype, "observe");

    await expect(waitForElement(".markdown-body")).resolves.toBe(element);

    expect(observe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finds a nested element mounted later and releases the observer and timer", async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const waiting = waitForElement(".markdown-body");
    const wrapper = document.createElement("section");
    const element = document.createElement("main");
    element.className = "markdown-body";
    wrapper.append(element);
    document.body.append(wrapper);

    await vi.advanceTimersByTimeAsync(0);
    await expect(waiting).resolves.toBe(element);

    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores unrelated mutations and still finds the requested element", async () => {
    const settled = vi.fn();
    const waiting = waitForElement("#target").then((element) => {
      settled(element);
      return element;
    });
    document.body.append(document.createElement("aside"));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();

    const element = document.createElement("main");
    element.id = "target";
    document.body.append(element);
    await vi.advanceTimersByTimeAsync(0);

    await expect(waiting).resolves.toBe(element);
    expect(settled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    undefined,
    40,
  ])("returns null at the timeout (%s) and stops observing", async (timeout) => {
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const settled = vi.fn();
    const waiting = waitForElement("#missing", timeout).then((element) => {
      settled(element);
      return element;
    });
    await vi.advanceTimersByTimeAsync((timeout ?? 2500) - 1);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBeNull();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    const late = document.createElement("main");
    late.id = "missing";
    document.body.append(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith(null);
  });

  it("checks the DOM again at timeout if observer delivery has not happened", async () => {
    const element = document.createElement("main");
    vi.spyOn(document, "querySelector")
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(element);

    const waiting = waitForElement("main", 0);
    await vi.advanceTimersByTimeAsync(0);

    await expect(waiting).resolves.toBe(element);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps simultaneous waits independent when one times out", async () => {
    const missing = waitForElement("#missing", 10);
    const waiting = waitForElement("#target", 100);
    await vi.advanceTimersByTimeAsync(10);
    await expect(missing).resolves.toBeNull();

    const element = document.createElement("main");
    element.id = "target";
    document.body.append(element);
    await vi.advanceTimersByTimeAsync(0);

    await expect(waiting).resolves.toBe(element);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores an observer delivery that was queued before the timeout settled", async () => {
    const Observer = MutationObserver;
    let deliver = () => {};
    vi.spyOn(globalThis, "MutationObserver").mockImplementation((callback) => {
      const observer = new Observer(callback);
      deliver = () => callback([], observer);
      return observer;
    });
    const disconnect = vi.spyOn(Observer.prototype, "disconnect");
    const settled = vi.fn();
    const waiting = waitForElement("main", 10).then(settled);
    await vi.advanceTimersByTimeAsync(10);
    await waiting;
    expect(settled).toHaveBeenCalledWith(null);

    document.body.append(document.createElement("main"));
    deliver();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
