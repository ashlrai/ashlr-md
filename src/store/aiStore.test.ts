import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStoredState } from "../test-setup";

// Mock the Tauri bridge so the store runs in plain Node/happy-dom.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import type { AICapabilities } from "../ai/types";
import { useAIStore } from "./aiStore";

const CAPS: AICapabilities = {
  tier: 1,
  modelName: "llama3.2",
  isLocal: true,
  isFree: true,
  streaming: true,
};

function reset() {
  useAIStore.setState({
    open: false,
    provider: null,
    providerId: null,
    messages: [],
    busy: false,
    apiKey: null,
    preferredTier: null,
    libraryScope: false,
  });
}

describe("aiStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    reset();
  });

  // ── Panel open/close ────────────────────────────────────────────────────

  it("toggle flips open state", () => {
    expect(useAIStore.getState().open).toBe(false);
    useAIStore.getState().toggle();
    expect(useAIStore.getState().open).toBe(true);
    useAIStore.getState().toggle();
    expect(useAIStore.getState().open).toBe(false);
  });

  it("open_() and close() set open unconditionally", () => {
    useAIStore.getState().open_();
    expect(useAIStore.getState().open).toBe(true);
    useAIStore.getState().close();
    expect(useAIStore.getState().open).toBe(false);
  });

  // ── Provider detection caching ──────────────────────────────────────────

  it("setProvider stores id and capabilities", () => {
    useAIStore.getState().setProvider("ollama", CAPS);
    const s = useAIStore.getState();
    expect(s.providerId).toBe("ollama");
    expect(s.provider).toEqual(CAPS);
  });

  it("clearProvider resets id and capabilities to null", () => {
    useAIStore.getState().setProvider("ollama", CAPS);
    useAIStore.getState().clearProvider();
    const s = useAIStore.getState();
    expect(s.providerId).toBeNull();
    expect(s.provider).toBeNull();
  });

  // ── Chat history ────────────────────────────────────────────────────────

  it("pushMessage appends with an id and timestamp", () => {
    const before = Date.now();
    const msg = useAIStore.getState().pushMessage({ role: "user", content: "hello" });
    const s = useAIStore.getState();
    expect(s.messages).toHaveLength(1);
    expect(msg.id).toBeTruthy();
    expect(msg.content).toBe("hello");
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("clearMessages empties the transcript", () => {
    useAIStore.getState().pushMessage({ role: "user", content: "a" });
    useAIStore.getState().pushMessage({ role: "assistant", content: "b" });
    useAIStore.getState().clearMessages();
    expect(useAIStore.getState().messages).toHaveLength(0);
  });

  it("updateLastAssistantMessage appends delta to streaming message", () => {
    useAIStore.getState().pushMessage({ role: "assistant", content: "Hi", streaming: true });
    useAIStore.getState().updateLastAssistantMessage(" there");
    const msgs = useAIStore.getState().messages;
    expect(msgs[0].content).toBe("Hi there");
    expect(msgs[0].streaming).toBe(true);
  });

  it("finalizeLastAssistantMessage clears streaming flag", () => {
    useAIStore.getState().pushMessage({ role: "assistant", content: "done", streaming: true });
    useAIStore.getState().finalizeLastAssistantMessage();
    expect(useAIStore.getState().messages[0].streaming).toBe(false);
  });

  // ── API key lifecycle ───────────────────────────────────────────────────

  it("setApiKey stores key in memory and calls keychain invoke", () => {
    invokeMock.mockResolvedValue(undefined);
    useAIStore.getState().setApiKey("sk-test-key");
    expect(useAIStore.getState().apiKey).toBe("sk-test-key");
    expect(invokeMock).toHaveBeenCalledWith("set_ai_key", {
      account: "anthropic",
      key: "sk-test-key",
    });
  });

  it("setApiKey(null) calls delete_ai_key", () => {
    invokeMock.mockResolvedValue(undefined);
    useAIStore.getState().setApiKey("sk-key");
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    useAIStore.getState().setApiKey(null);
    expect(useAIStore.getState().apiKey).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("delete_ai_key", { account: "anthropic" });
  });

  it("loadApiKey reads key from keychain and stores in memory", async () => {
    invokeMock.mockResolvedValue("sk-from-keychain");
    await useAIStore.getState().loadApiKey();
    expect(useAIStore.getState().apiKey).toBe("sk-from-keychain");
    expect(invokeMock).toHaveBeenCalledWith("get_ai_key", { account: "anthropic" });
  });

  it("loadApiKey migrates legacy plaintext key from localStorage to keychain", async () => {
    // Plant a legacy key in localStorage (old blob format).
    localStorage.setItem(
      "mdopener-ai",
      JSON.stringify({ state: { apiKey: "sk-legacy" } }),
    );
    invokeMock.mockResolvedValue(undefined); // set_ai_key succeeds
    await useAIStore.getState().loadApiKey();
    expect(useAIStore.getState().apiKey).toBe("sk-legacy");
    // After migration the plaintext key is stripped from localStorage.
    const blob = getStoredState<{ apiKey?: string }>("mdopener-ai");
    expect(blob?.state?.apiKey).toBeUndefined();
  });

  // ── Preferences ────────────────────────────────────────────────────────

  it("setPreferredTier persists the tier preference", () => {
    useAIStore.getState().setPreferredTier(2);
    expect(useAIStore.getState().preferredTier).toBe(2);
  });

  it("setLibraryScope toggles the grounding flag", () => {
    expect(useAIStore.getState().libraryScope).toBe(false);
    useAIStore.getState().setLibraryScope(true);
    expect(useAIStore.getState().libraryScope).toBe(true);
  });
});
