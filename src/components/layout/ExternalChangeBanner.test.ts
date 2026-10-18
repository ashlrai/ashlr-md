/**
 * The change banner's "Explain changes" streams into the AI sidebar like a
 * chat turn, so it ends like one. It held its AbortController to itself (the
 * sidebar's Stop button did nothing and a stop was not marked as stopped)
 * and wrote a failure into the answer as "*Error: ...*" chat text instead of
 * a failed turn.
 */
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const run: { signal?: AbortSignal; fail?: Error } = {};
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
    // Streams a little, then fails if told to, else waits to be aborted.
    runSelectionAction: vi.fn(
      (_p: unknown, _m: unknown, onDelta: (d: string) => void, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          run.signal = signal;
          onDelta("The file ");
          if (run.fail) {
            reject(run.fail);
            return;
          }
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ),
  };
});

import { describeAIError } from "../../ai/errors";
import { useAIStore } from "../../store/aiStore";
import { useDocumentStore } from "../../store/documentStore";
import { AISidebar } from "../ai/AISidebar";
import { ExternalChangeBanner } from "./ExternalChangeBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the change banner's Explain changes", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    run.signal = undefined;
    run.fail = undefined;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useAIStore.setState({
      open: true,
      messages: [],
      busy: false,
      abortController: null,
      providerId: "fake",
    });
    useDocumentStore.setState({ content: "mine", pendingDisk: "theirs" });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function explain(): Promise<void> {
    await act(async () =>
      root.render(
        createElement(
          Fragment,
          null,
          createElement(AISidebar),
          createElement(ExternalChangeBanner),
        ),
      ),
    );
    const btn = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Explain changes",
    );
    expect(btn).toBeDefined();
    await act(async () => btn!.click());
    await act(async () => {});
  }

  it("is stopped by the sidebar's Stop button and marked as stopped", async () => {
    await explain();
    expect(useAIStore.getState().busy).toBe(true);
    expect(run.signal?.aborted).toBe(false);

    const stop = host.querySelector<HTMLButtonElement>(
      "button[aria-label='Stop generation']",
    );
    expect(stop).not.toBeNull();
    await act(async () => stop!.click());

    expect(run.signal?.aborted).toBe(true);
    const s = useAIStore.getState();
    expect(s.busy).toBe(false);
    expect(s.abortController).toBeNull();
    const last = s.messages.at(-1);
    expect(last?.stopped).toBe(true);
    expect(last?.error).toBeUndefined();
    expect(last?.content).toBe("The file ");
    expect(last?.streaming).toBe(false);
  });

  it("records a failure as a failed turn, not chat text", async () => {
    run.fail = new Error("HTTP 401: invalid x-api-key");
    await explain();
    const s = useAIStore.getState();
    expect(s.busy).toBe(false);
    expect(s.abortController).toBeNull();
    const last = s.messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.content).toBe("The file ");
    expect(last?.content).not.toContain("*Error:");
    expect(last?.error).toEqual(describeAIError(run.fail));
    expect(last?.stopped).toBeUndefined();
  });
});
