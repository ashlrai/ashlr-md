// ASHLR_MD_ANTHROPIC_KEY_FROM_ENV=1: the Anthropic key comes from
// ANTHROPIC_API_KEY in Rust. The webview only sees a value-free status, never
// sends the Settings key in that mode, and never stores anything.

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (e: { payload: { requestId: string } }) => void;
const listeners = new Map<string, Listener>();
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (channel: string, cb: Listener) => {
    listeners.set(channel, cb);
    return () => listeners.delete(channel);
  }),
}));

import { AnthropicKeySection } from "../components/settings/sections/AnthropicKeySection";
import { useAIStore } from "../store/aiStore";
import { anthropicEnvKeyStatus } from "./bridge";
import { detectProvider, NOOP_PROVIDER_ID } from "./registry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS_KEY = "sk-ant-settings-secret-0123456789";

function withStatus(status: unknown) {
  invokeMock.mockImplementation(async (cmd: string, args?: { requestId?: string }) => {
    if (cmd === "anthropic_env_key_status") return status;
    if (cmd === "ai_offline_mode") return false;
    if (cmd === "ai_generate") {
      // Finish the stream the way Rust does.
      queueMicrotask(() =>
        listeners.get("ai://done")?.({ payload: { requestId: args?.requestId ?? "" } }),
      );
      return undefined;
    }
    throw new Error(`no ${cmd} in tests`);
  });
}

async function runAnthropic() {
  const provider = await detectProvider();
  expect(provider.id).toBe("anthropic");
  for await (const _ of provider.generate([{ role: "user", content: "hi" }], {})) {
    // drain
  }
  const call = invokeMock.mock.calls.find((c) => c[0] === "ai_generate");
  expect(call).toBeDefined();
  return call?.[1] as { apiKey: string | null };
}

describe("Anthropic key from the environment (opt-in)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listeners.clear();
    useAIStore.setState({
      apiKey: null,
      hostedToken: null,
      provider: null,
      providerId: null,
    });
  });

  it("is off by default: the Settings key is used, as before", async () => {
    withStatus({ enabled: false, usable: false, placeholder: false, problem: null });
    useAIStore.setState({ apiKey: SETTINGS_KEY });
    expect((await runAnthropic()).apiKey).toBe(SETTINGS_KEY);
  });

  it("outside Tauri (no status) the Settings key is used", async () => {
    invokeMock.mockImplementation(
      async (cmd: string, args?: { requestId?: string }) => {
        if (cmd === "ai_offline_mode") return false;
        if (cmd === "ai_generate") {
          queueMicrotask(() =>
            listeners.get("ai://done")?.({
              payload: { requestId: args?.requestId ?? "" },
            }),
          );
          return undefined;
        }
        throw new Error("not in Tauri");
      },
    );
    expect(await anthropicEnvKeyStatus()).toBeNull();
    useAIStore.setState({ apiKey: SETTINGS_KEY });
    expect((await runAnthropic()).apiKey).toBe(SETTINGS_KEY);
  });

  it("when on and usable, Anthropic is available without a Settings key and no key is sent from the webview", async () => {
    withStatus({ enabled: true, usable: true, placeholder: true, problem: null });
    expect((await runAnthropic()).apiKey).toBeNull();
  });

  it("when on, the Settings key is never sent, even if one is saved", async () => {
    withStatus({ enabled: true, usable: true, placeholder: false, problem: null });
    useAIStore.setState({ apiKey: SETTINGS_KEY });
    const args = await runAnthropic();
    expect(args.apiKey).toBeNull();
    expect(JSON.stringify(invokeMock.mock.calls)).not.toContain(SETTINGS_KEY);
  });

  it("when on but refused, Anthropic is not chosen, with no fallback to the Settings key", async () => {
    withStatus({
      enabled: true,
      usable: false,
      placeholder: false,
      problem: "ANTHROPIC_API_KEY is a phm: reference",
    });
    useAIStore.setState({ apiKey: SETTINGS_KEY });
    const provider = await detectProvider();
    expect(provider.id).toBe(NOOP_PROVIDER_ID);
    expect(invokeMock.mock.calls.some((c) => c[0] === "ai_generate")).toBe(false);
  });

  it("nothing is written to Settings or the keychain", async () => {
    withStatus({ enabled: true, usable: true, placeholder: true, problem: null });
    await runAnthropic();
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).not.toContain("set_ai_key");
    expect(useAIStore.getState().apiKey).toBeNull();
  });

  it("Settings says the environment key is in use, without a value", async () => {
    withStatus({ enabled: true, usable: true, placeholder: true, problem: null });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(AnthropicKeySection)));
    const note = host.querySelector('[data-testid="anthropic-env-key"]');
    expect(note?.textContent).toContain("ANTHROPIC_API_KEY (a phm_ placeholder)");
    expect(note?.textContent).toContain("not the key saved here");
    act(() => root.unmount());
    host.remove();
  });
});
