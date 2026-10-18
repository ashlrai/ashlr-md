/**
 * A failed generation in the AI sidebar showed the provider's raw text as
 * "*Error: Anthropic error 401 Unauthorized: {json}*" inside the answer, and
 * that text was sent back to the model as part of the history. It now shows
 * a plain next step, with the raw text in a collapsed Details line, outside
 * the message content.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const { RAW } = vi.hoisted(() => ({
  RAW: 'Anthropic error 401 Unauthorized: {"type":"error","error":{"type":"authentication_error"}}',
}));

vi.mock("../../ai/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ai/registry")>();
  const fake = {
    id: "anthropic",
    capabilities: { tier: 2, modelName: "fake" },
    isAvailable: async () => true,
    async *generate() {},
  };
  return {
    ...real,
    detectProvider: vi.fn().mockResolvedValue(fake),
    getCachedProvider: () => fake,
    runSelectionAction: vi.fn().mockRejectedValue(new Error(RAW)),
  };
});

import { useAIStore } from "../../store/aiStore";
import { AISidebar } from "./AISidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("a provider error in the AI sidebar", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useAIStore.setState({ open: true, messages: [], busy: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows the next step first and the raw text as secondary detail", async () => {
    await act(async () => root.render(createElement(AISidebar)));
    const input = host.querySelector<HTMLTextAreaElement>("textarea.ai-input")!;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "hello");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = host.querySelector<HTMLButtonElement>(
      "button[aria-label='Send message']",
    )!;
    await act(async () => send.click());

    const msg = host.querySelector(".ai-msg__error-msg");
    expect(msg?.textContent).toContain("Replace it in Preferences, Anthropic API key.");
    expect(msg?.textContent).not.toContain("401");
    const detail = host.querySelector("details.ai-msg__error-detail");
    expect(detail).not.toBeNull();
    expect((detail as HTMLDetailsElement).open).toBe(false);
    expect(detail?.textContent).toContain(RAW);

    const last = useAIStore.getState().messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.content).not.toContain("Error:");
    expect(last.content).not.toContain("401");
    // No empty answer bubble above the error.
    expect(host.querySelectorAll(".ai-msg--assistant .ai-msg__bubble")).toHaveLength(0);
  });
});
