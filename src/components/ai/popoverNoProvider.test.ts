/**
 * The selection popover opened the AI sidebar and then stopped without a
 * word when no provider was found. It now leaves a plain message with a next
 * step. A sidebar the action opens fresh shows its setup panel, which hid
 * that message in the chat behind it; the panel now shows it on top, and the
 * message points at the panel instead of at "the AI sidebar".
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

import { NO_PROVIDER_RUN_MESSAGE } from "../../ai/errors";
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
  async function clickExplain(arrange: () => void = () => {}) {
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
    expect(msg?.error?.message).toBe(NO_PROVIDER_RUN_MESSAGE);
    expect(msg?.streaming).toBeFalsy();
    expect(host.querySelector(".ai-msg__error-msg")?.textContent).toBe(
      NO_PROVIDER_RUN_MESSAGE,
    );
  });

  it("a sidebar the action opens fresh shows the message on its setup panel", async () => {
    // Closed sidebar, no provider any more: both the popover's detection and
    // the sidebar's own find only the no-op provider.
    useAIStore.setState({ open: false });
    detect.mockResolvedValue({
      id: NOOP_PROVIDER_ID,
      capabilities: { tier: 1, modelName: "None" },
      isAvailable: async () => true,
      async *generate() {},
    });
    await clickExplain();
    await act(async () => {});

    expect(useAIStore.getState().open).toBe(true);
    const nudge = host.querySelector(".ai-setup-nudge");
    expect(nudge, "the sidebar shows its setup panel").not.toBeNull();
    const notice = nudge!.querySelector(".ai-setup-nudge__notice [role='alert']");
    expect(notice, "the panel shows why nothing ran").not.toBeNull();
    expect(notice!.textContent).toContain(NO_PROVIDER_RUN_MESSAGE);
    expect(notice!.textContent).not.toContain("in the AI sidebar");
    // The setup options are still there to act on.
    expect(nudge!.querySelector(".ai-key-form")).not.toBeNull();
  });

  it("an open chat switches to the setup panel when the provider is gone", async () => {
    await clickExplain(() => detect.mockResolvedValue({ id: NOOP_PROVIDER_ID }));
    expect(host.querySelector(".ai-setup-nudge__notice")?.textContent).toContain(
      NO_PROVIDER_RUN_MESSAGE,
    );
  });
});
