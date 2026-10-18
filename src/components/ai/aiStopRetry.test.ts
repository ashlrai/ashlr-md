/**
 * Stopping before any text arrived left an empty "Assistant" bubble and no
 * word that it was stopped; and each Retry after a failure added the user's
 * message to the chat again. A stopped turn now shows a "stopped" note and
 * no empty bubble, and a retry replaces the failed answer.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const mode = vi.hoisted(() => ({ value: "hang" as "hang" | "fail" }));
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
    runSelectionAction: vi.fn(
      (_p: unknown, _m: unknown, _d: unknown, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          if (mode.value === "fail") {
            reject(new Error("Ollama request failed: error sending request"));
            return;
          }
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ),
  };
});

import { useAIStore } from "../../store/aiStore";
import { AISidebar } from "./AISidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Stop and Retry in the AI sidebar", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useAIStore.setState({ open: true, messages: [], busy: false, providerId: "fake" });
    await act(async () => root.render(createElement(AISidebar)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function sendText(text: string) {
    const input = host.querySelector<HTMLTextAreaElement>("textarea.ai-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = host.querySelector<HTMLButtonElement>(
      "button[aria-label='Send message']",
    )!;
    await act(async () => send.click());
  }

  it("a stop before any text shows a stopped note, not an empty bubble", async () => {
    mode.value = "hang";
    await sendText("hello");
    expect(useAIStore.getState().busy).toBe(true);
    const stop = host.querySelector<HTMLButtonElement>(
      "button[aria-label='Stop generation']",
    )!;
    await act(async () => stop.click());

    expect(useAIStore.getState().busy).toBe(false);
    expect(host.querySelectorAll(".ai-msg--assistant .ai-msg__bubble")).toHaveLength(0);
    expect(host.querySelector(".ai-msg__stopped")?.textContent).toContain("Stopped");
    expect(useAIStore.getState().messages.at(-1)?.stopped).toBe(true);
  });

  it("each retry keeps the user's message once and replaces the failed answer", async () => {
    mode.value = "fail";
    await sendText("hello");
    for (let i = 0; i < 2; i++) {
      const retry = host.querySelector<HTMLButtonElement>(
        "button[aria-label='Retry failed AI generation']",
      );
      expect(retry).not.toBeNull();
      await act(async () => retry!.click());
    }
    const msgs = useAIStore.getState().messages;
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(host.querySelectorAll(".ai-msg--user")).toHaveLength(1);
  });
});
