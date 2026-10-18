/**
 * With no AI provider, the sidebar's setup nudge offered only Ollama and an
 * Anthropic key. On a Mac, where the README promises a zero-install
 * on-device model, it now says what that model needs and to restart.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../ai/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ai/registry")>();
  const noop = {
    id: real.NOOP_PROVIDER_ID,
    capabilities: { tier: 1, modelName: "None" },
    isAvailable: async () => true,
    async *generate() {},
  };
  return {
    ...real,
    detectProvider: vi.fn().mockResolvedValue(noop),
    getCachedProvider: () => noop,
  };
});

import { useAIStore } from "../../store/aiStore";
import { AISidebar } from "./AISidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the no-provider nudge", () => {
  let host: HTMLDivElement;
  let root: Root;
  let platformSpy: { mockRestore(): void } | undefined;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useAIStore.setState({ open: true, messages: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    platformSpy?.mockRestore();
  });

  async function nudgeText(platform: string): Promise<string> {
    platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    await act(async () => root.render(createElement(AISidebar)));
    const body = host.querySelector(".ai-setup-nudge__body");
    expect(body).not.toBeNull();
    return body!.textContent ?? "";
  }

  it("on a Mac, says the on-device model needs Apple Intelligence", async () => {
    const text = await nudgeText("MacIntel");
    expect(text).toContain("needs Apple Intelligence");
    expect(text).toContain("System Settings");
    expect(text).toContain("restart Ashlr MD");
    expect(text).toContain("Ollama");
  });

  it("elsewhere, offers Ollama and a key only", async () => {
    const text = await nudgeText("Linux x86_64");
    expect(text).not.toContain("Apple Intelligence");
    expect(text).toContain("Ollama");
  });
});
