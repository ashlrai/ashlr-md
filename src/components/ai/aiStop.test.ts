/**
 * The sidebar's Stop button stops a selection popover action. The popover
 * kept its AbortController to itself, so while its answer streamed into the
 * sidebar, Stop was shown and did nothing.
 */
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const seen: { signal?: AbortSignal } = {};
vi.mock("../../ai/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ai/registry")>();
  const fake = {
    id: "fake",
    capabilities: { tier: 1, modelName: "fake" },
    isAvailable: async () => true,
    async *generate() {},
  };
  return {
    ...real,
    detectProvider: vi.fn().mockResolvedValue(fake),
    getCachedProvider: () => fake,
    // Streams until aborted, as a slow model does.
    runSelectionAction: vi.fn(
      (_p: unknown, _m: unknown, _d: unknown, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          seen.signal = signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ),
  };
});

import { useAIStore } from "../../store/aiStore";
import { AISidebar } from "./AISidebar";
import { SelectionPopover } from "./SelectionPopover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Stop during a selection popover action", () => {
  let host: HTMLDivElement;
  let doc: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    doc = document.createElement("div");
    doc.className = "markdown-body";
    doc.textContent = "Some selected words";
    document.body.appendChild(doc);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useAIStore.setState({ open: true, messages: [], busy: false, providerId: "fake" });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    doc.remove();
  });

  it("aborts the action and ends the busy state", async () => {
    await act(async () =>
      root.render(
        createElement(
          Fragment,
          null,
          createElement(AISidebar),
          createElement(SelectionPopover),
        ),
      ),
    );

    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(doc);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    const explain = host.querySelector<HTMLButtonElement>(
      ".ai-selection-popover button[title='Explain']",
    );
    expect(explain).not.toBeNull();
    await act(async () => explain!.click());
    expect(useAIStore.getState().busy).toBe(true);
    expect(seen.signal?.aborted).toBe(false);

    const stop = host.querySelector<HTMLButtonElement>(
      "button[aria-label='Stop generation']",
    );
    expect(stop).not.toBeNull();
    await act(async () => stop!.click());

    expect(seen.signal?.aborted).toBe(true);
    expect(useAIStore.getState().busy).toBe(false);
    expect(useAIStore.getState().abortController).toBeNull();
  });
});
