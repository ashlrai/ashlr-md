/**
 * With no AI provider, the no-op provider's answer and the change banner's
 * "Explain changes" said only "Install Ollama or add an Anthropic API key",
 * with no word on the Mac's on-device model, and the README's quick start
 * promised "No account, no API key" on every platform, which is untrue on
 * Windows and Linux. All three now say what is true for the platform, from
 * one source (noProviderSetupHint in errors.ts) where the code can share it.
 * The banner's note is now a failed turn the sidebar's setup panel shows on
 * top, and the panel says what is true for the platform.
 */
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import readme from "../../README.md?raw";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { AISidebar } from "../components/ai/AISidebar";
import { ExternalChangeBanner } from "../components/layout/ExternalChangeBanner";
import { useAIStore } from "../store/aiStore";
import { useDocumentStore } from "../store/documentStore";
import {
  NO_PROVIDER_EXPLAIN_MESSAGE,
  noProviderAnswer,
  noProviderSetupHint,
} from "./errors";
import { detectProvider, NOOP_PROVIDER_ID } from "./registry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let platformSpy: { mockRestore(): void } | undefined;
function onPlatform(platform: string) {
  platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
}

afterEach(() => {
  platformSpy?.mockRestore();
  platformSpy = undefined;
});

async function noopAnswer(): Promise<string> {
  useAIStore.setState({ apiKey: null, hostedToken: null, preferredTier: null });
  const p = await detectProvider();
  expect(p.id).toBe(NOOP_PROVIDER_ID);
  let out = "";
  for await (const d of p.generate([], {})) out += d;
  return out;
}

describe("the no-provider wording", () => {
  it("the hint names the on-device model's needs on a Mac only", () => {
    const mac = noProviderSetupHint(true);
    expect(mac).toContain("Apple Silicon");
    expect(mac).toContain("macOS 26");
    expect(mac).toContain("Apple Intelligence");
    expect(mac).toContain("restart Ashlr MD");
    expect(mac).toContain("Ollama");
    const other = noProviderSetupHint(false);
    expect(other).not.toContain("Apple");
    expect(other).toContain("Ollama");
    expect(other).toContain("Anthropic API key");
  });

  it("the no-op provider answers with the platform's hint", async () => {
    onPlatform("MacIntel");
    const mac = await noopAnswer();
    expect(mac).toBe(noProviderAnswer(true));
    expect(mac).toContain("Apple Intelligence");
    platformSpy?.mockRestore();
    onPlatform("Linux x86_64");
    const linux = await noopAnswer();
    expect(linux).toBe(noProviderAnswer(false));
    expect(linux).not.toContain("Apple");
  });

  it("README's quick start does not promise keyless AI everywhere", () => {
    const step = readme.split("\n").find((l) => l.startsWith("3. "));
    expect(step, "README.md has no quick start step 3").toBeDefined();
    expect(step).not.toMatch(/^3\. [^.]*\. No account, no API key\.$/);
    for (const needed of [
      "Apple Silicon",
      "macOS 26",
      "Apple Intelligence",
      "restart Ashlr MD",
      "Windows and Linux",
      "Ollama",
      "Anthropic API key",
    ]) {
      expect(step, `README.md quick start step 3 should mention ${needed}`).toContain(
        needed,
      );
    }
  });
});

describe("the change banner's Explain changes with no provider", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useAIStore.setState({
      open: false,
      messages: [],
      apiKey: null,
      hostedToken: null,
      preferredTier: null,
      providerId: null,
      provider: null,
    });
    useDocumentStore.setState({ content: "mine", pendingDisk: "theirs" });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  /** Renders the banner beside the AI sidebar and clicks Explain changes. */
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

  // The note used to be plain chat text, which the sidebar's setup panel
  // hides, so the user saw the panel and no reason. It is now a failed turn,
  // which the panel shows on top of its options.
  it("records a failed turn the setup panel shows", async () => {
    onPlatform("Linux x86_64");
    await explain();
    const last = useAIStore.getState().messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.content).toBe("");
    expect(last?.error?.message).toBe(NO_PROVIDER_EXPLAIN_MESSAGE);
    const nudge = host.querySelector(".ai-setup-nudge");
    expect(nudge, "the sidebar shows its setup panel").not.toBeNull();
    const notice = nudge!.querySelector(".ai-setup-nudge__notice [role='alert']");
    expect(notice, "the panel shows why nothing was explained").not.toBeNull();
    expect(notice!.textContent).toContain(NO_PROVIDER_EXPLAIN_MESSAGE);
    expect(nudge!.querySelector(".ai-key-form")).not.toBeNull();
  });

  it("on a Mac, the panel names the on-device model's needs", async () => {
    onPlatform("MacIntel");
    await explain();
    const body = host.querySelector(".ai-setup-nudge__body")?.textContent ?? "";
    expect(body).toContain("Apple Intelligence");
    expect(body).toContain("macOS 26");
  });

  it("elsewhere, the panel offers Ollama and a key only", async () => {
    onPlatform("Linux x86_64");
    await explain();
    const body = host.querySelector(".ai-setup-nudge__body")?.textContent ?? "";
    expect(body).toContain("Ollama");
    expect(body).not.toContain("Apple");
  });
});
