/**
 * The selection popover opened the AI sidebar and then stopped without a
 * word when no provider was found. It now leaves the same plain message with
 * a next step that the editors' inline AI shows.
 */
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const { detect } = vi.hoisted(() => ({ detect: vi.fn() }));
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
    detectProvider: detect,
    getCachedProvider: () => fake,
    runSelectionAction: vi.fn().mockResolvedValue(undefined),
  };
});

import { NO_PROVIDER_MESSAGE } from "../../ai/errors";
import { NOOP_PROVIDER_ID } from "../../ai/registry";
import { useAIStore } from "../../store/aiStore";
import { AISidebar } from "./AISidebar";
import { SelectionPopover } from "./SelectionPopover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Selection popover with no provider", () => {
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
    // The popover saw a provider earlier, so it shows its actions.
    useAIStore.setState({ open: true, messages: [], busy: false, providerId: "fake" });
    detect.mockReset();
    detect.mockResolvedValue({
      id: "fake",
      capabilities: { tier: 1, modelName: "fake" },
      isAvailable: async () => true,
      async *generate() {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    doc.remove();
  });

  /** Opens the sidebar with a provider, then runs `arrange` (the provider
   *  goes away, say Ollama stops) and clicks Explain in the popover. */
  async function clickExplain(arrange: () => void) {
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
    arrange();
    const explain = host.querySelector<HTMLButtonElement>(
      ".ai-selection-popover button[title='Explain']",
    );
    expect(explain).not.toBeNull();
    await act(async () => explain!.click());
  }

  function lastAssistant() {
    const msgs = useAIStore.getState().messages;
    return msgs.filter((m) => m.role === "assistant").at(-1);
  }

  it.each([
    [
      "finds only the no-op provider",
      () => detect.mockResolvedValue({ id: NOOP_PROVIDER_ID }),
    ],
    ["fails", () => detect.mockRejectedValue(new Error("keychain locked"))],
  ])("says what to do when detection %s after the sidebar opened", async (_label, arrange) => {
    await clickExplain(arrange);

    expect(useAIStore.getState().open).toBe(true);
    expect(useAIStore.getState().busy).toBe(false);
    const msg = lastAssistant();
    expect(msg?.error?.message).toBe(NO_PROVIDER_MESSAGE);
    expect(msg?.streaming).toBeFalsy();
    expect(host.querySelector(".ai-msg__error-msg")?.textContent).toBe(
      NO_PROVIDER_MESSAGE,
    );
  });
});
