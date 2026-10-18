/**
 * A saved Anthropic key could only be entered in the sidebar's setup nudge,
 * which shows only when no provider is found, so it could never be replaced
 * or removed. Preferences now has a key field that writes through the same
 * keychain path and never shows the key.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useAIStore } from "../../../store/aiStore";
import { AnthropicKeySection } from "./AnthropicKeySection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OLD_KEY = "sk-ant-old-secret-0123456789";
const NEW_KEY = "sk-ant-new-secret-9876543210";

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
  expect(found, label).toBeDefined();
  return found as HTMLButtonElement;
}

describe("Preferences: Anthropic API key", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    invokeMock.mockClear();
    useAIStore.setState({ apiKey: OLD_KEY });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(AnthropicKeySection)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("says a key is saved without showing any of it", () => {
    expect(host.textContent).toContain("A key is saved.");
    expect(host.textContent).not.toContain(OLD_KEY.slice(0, 8));
    expect(host.innerHTML).not.toContain(OLD_KEY);
  });

  it("replaces the saved key through the keychain", async () => {
    await act(async () => button(host, "Replace key").click());
    const input = host.querySelector<HTMLInputElement>("input[type='password']");
    expect(input).not.toBeNull();
    expect(input!.value).toBe("");
    await act(async () => setInput(input!, NEW_KEY));
    await act(async () => button(host, "Save key").click());

    expect(useAIStore.getState().apiKey).toBe(NEW_KEY);
    expect(invokeMock).toHaveBeenCalledWith("set_ai_key", {
      account: "anthropic",
      key: NEW_KEY,
    });
    expect(host.innerHTML).not.toContain(NEW_KEY);
  });

  it("removes the saved key from the keychain", async () => {
    await act(async () => button(host, "Remove key").click());
    expect(useAIStore.getState().apiKey).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("delete_ai_key", { account: "anthropic" });
    expect(host.textContent).toContain("No key saved.");
    expect(host.textContent).toContain("Add key");
  });

  it("the Anthropic provider uses the replaced key, not the one it detected", async () => {
    const { detectProvider } = await import("../../../ai/registry");
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "ai_detect_ollama" || cmd === "afm_detect" ? null : undefined,
    );
    const provider = await detectProvider();
    expect(provider.id).toBe("anthropic");
    useAIStore.setState({ apiKey: NEW_KEY });
    invokeMock.mockClear();
    const ac = new AbortController();
    const it_ = provider.generate([{ role: "user", content: "hi" }], {
      signal: ac.signal,
    });
    const pending = it_.next();
    await new Promise((r) => setTimeout(r, 0));
    const call = invokeMock.mock.calls.find((c) => c[0] === "ai_generate");
    expect(call?.[1]).toMatchObject({ apiKey: NEW_KEY });
    ac.abort();
    await pending.catch(() => {});
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });
});
