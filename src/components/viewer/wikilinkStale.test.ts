/**
 * A resolved wikilink was cached for the whole session, so a link to a note
 * deleted or renamed since still showed as a working link (and a click
 * failed). A file event from the watchers now drops the cache and the link
 * resolves again, showing as broken.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let planExists = true;
const handlers = new Map<string, () => void>();
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: () => void) => {
    handlers.set(event, cb);
    return () => handlers.delete(event);
  }),
}));

import { invalidateWikilinkCache, watchWikilinkChanges } from "../../lib/wikilink";
import { useDocumentStore } from "../../store/documentStore";
import { useSettingsStore } from "../../store/settingsStore";
import { Wikilink } from "./Wikilink";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("a wikilink to a note deleted or renamed since it resolved", () => {
  let host: HTMLDivElement;
  let root: Root;
  let stop: () => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    planExists = true;
    handlers.clear();
    invalidateWikilinkCache();
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "resolve_wikilink" ? (planExists ? "/v/plan.md" : null) : undefined,
    );
    useSettingsStore.setState({ vaultRoot: "/v" });
    useDocumentStore.setState({ path: "/v/a.md" });
    stop = await watchWikilinkChanges();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Wikilink, { target: "plan" })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    stop();
    vi.useRealTimers();
  });

  const link = () => host.querySelector<HTMLButtonElement>("button.wikilink");

  for (const event of ["file-changed", "file-renamed", "activity://file"]) {
    it(`shows as broken after a ${event} event`, async () => {
      expect(link()?.classList.contains("wikilink--broken")).toBe(false);
      expect(link()?.disabled).toBe(false);
      planExists = false;
      await act(async () => {
        handlers.get(event)?.();
        vi.advanceTimersByTime(300);
      });
      expect(link()?.classList.contains("wikilink--broken")).toBe(true);
      expect(link()?.title).toBe("Not found: plan");
    });
  }

  it("resolves once for a burst of events", async () => {
    const calls = () =>
      invoke.mock.calls.filter(([c]) => c === "resolve_wikilink").length;
    const before = calls();
    await act(async () => {
      for (let i = 0; i < 5; i++) handlers.get("activity://file")?.();
      vi.advanceTimersByTime(300);
    });
    expect(calls()).toBe(before + 1);
  });
});
