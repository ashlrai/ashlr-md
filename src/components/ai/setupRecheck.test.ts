/**
 * The sidebar's setup panel looked for a provider only when the sidebar
 * opened, so a user who started Ollama with the panel open saw no change
 * until they closed and reopened it. Its key button read "Save key & retry"
 * though it retried nothing. The panel now has a "Check again" button that
 * says when it still finds nothing, and the key button reads "Save key".
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const { detect, noop, ollama } = vi.hoisted(() => {
  const make = (id: string, modelName: string) => ({
    id,
    capabilities: { tier: 1, modelName },
    isAvailable: async () => true,
    async *generate() {},
  });
  return {
    detect: vi.fn(),
    noop: make("noop", "None"),
    ollama: make("ollama", "llama3.2"),
  };
});
vi.mock("../../ai/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ai/registry")>();
  noop.id = real.NOOP_PROVIDER_ID;
  return { ...real, detectProvider: detect, getCachedProvider: () => null };
});

import { useAIStore } from "../../store/aiStore";
import { AISidebar } from "./AISidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the setup panel's Check again", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useAIStore.setState({ open: true, messages: [], apiKey: null, providerId: null });
    detect.mockReset();
    detect.mockResolvedValue(noop);
    await act(async () => root.render(createElement(AISidebar)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function checkAgain(): HTMLButtonElement {
    const b = [
      ...host.querySelectorAll<HTMLButtonElement>(".ai-setup-nudge button"),
    ].find((x) => x.textContent === "Check again");
    expect(b, "the panel has a Check again button").toBeDefined();
    return b!;
  }

  it("finds a provider started while the panel is open", async () => {
    expect(host.querySelector(".ai-setup-nudge")).not.toBeNull();
    detect.mockResolvedValue(ollama);
    await act(async () => checkAgain().click());
    expect(
      host.querySelector(".ai-setup-nudge"),
      "the chat replaces the panel",
    ).toBeNull();
    expect(host.querySelector(".ai-input")).not.toBeNull();
  });

  it("says when it still finds none", async () => {
    expect(host.querySelector(".ai-setup-nudge__still")).toBeNull();
    await act(async () => checkAgain().click());
    expect(host.querySelector(".ai-setup-nudge__still")?.textContent).toContain(
      "Still no AI provider found",
    );
  });

  it("the key button says it saves the key, not that it retries", () => {
    const submit = host.querySelector<HTMLButtonElement>(".ai-key-submit");
    expect(submit?.textContent).toBe("Save key");
  });
});
