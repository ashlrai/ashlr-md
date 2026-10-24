/**
 * The AI sidebar's quick actions, context and failures say what is going
 * on: a disabled quick action names its reason in its tooltip, and a
 * document cut to the context limit says so, and a refused key or an
 * empty account offers its fix instead of a Retry that fails again.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const fail = vi.hoisted(() => ({ error: null as Error | null }));
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
          if (fail.error) {
            reject(fail.error);
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
import { useDocumentStore } from "../../store/documentStore";
import { useUiStore } from "../../store/uiStore";
import { AISidebar, MAX_CONTEXT_CHARS } from "./AISidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AI sidebar notes", () => {
  let host: HTMLDivElement;
  let root: Root;

  async function mount(content: string) {
    useDocumentStore.setState({ content });
    await act(async () => root.render(createElement(AISidebar)));
  }

  function quickButtons(): HTMLButtonElement[] {
    return [...host.querySelectorAll<HTMLButtonElement>("button.ai-quick-btn")];
  }

  beforeEach(() => {
    fail.error = null;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useAIStore.setState({ open: true, messages: [], busy: false, providerId: "fake" });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("a quick action disabled on an empty document says why", async () => {
    await mount("  \n");
    const buttons = quickButtons();
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.disabled).toBe(true);
      expect(b.title).toMatch(/no text to work on/);
    }
  });

  it("a quick action disabled while an answer streams says why", async () => {
    await mount("# Doc\n\nSome text.");
    const first = quickButtons()[0];
    expect(first.disabled).toBe(false);
    expect(first.title).not.toMatch(/:/);
    await act(async () => first.click());
    expect(useAIStore.getState().busy).toBe(true);
    for (const b of quickButtons()) {
      expect(b.disabled).toBe(true);
      expect(b.title).toMatch(/wait for the current answer/);
    }
  });
  it("says when the document is cut before it is sent", async () => {
    await mount("short");
    expect(host.querySelector(".ai-context-note")).toBeNull();
    act(() =>
      useDocumentStore.setState({ content: "x".repeat(MAX_CONTEXT_CHARS + 500) }),
    );
    const note = host.querySelector(".ai-context-note")?.textContent ?? "";
    expect(note).toContain("first 8,000");
    expect(note).toContain("8,500 characters");
  });
  async function failQuickAction(error: Error) {
    fail.error = error;
    await mount("# Doc\n\nSome text.");
    await act(async () => quickButtons()[0].click());
    return host.querySelector(".ai-retry-toast");
  }

  it("a refused key offers Preferences, not Retry", async () => {
    useUiStore.setState({ settingsOpen: false });
    const toast = await failQuickAction(
      new Error('Anthropic error 401 Unauthorized: {"type":"authentication_error"}'),
    );
    expect(
      toast?.querySelector("[aria-label='Retry failed AI generation']"),
    ).toBeNull();
    const open = [...(toast?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Open Preferences",
    );
    expect(open).toBeDefined();
    await act(async () => open!.click());
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(host.querySelector(".ai-retry-toast")).toBeNull();
  });

  it("an empty account offers to add credit, not Retry", async () => {
    const toast = await failQuickAction(
      new Error(
        'Anthropic error 400 Bad Request: {"message":"Your credit balance is too low"}',
      ),
    );
    expect(
      toast?.querySelector("[aria-label='Retry failed AI generation']"),
    ).toBeNull();
    const link = toast?.querySelector<HTMLAnchorElement>("a.ai-retry-btn");
    expect(link?.textContent).toBe("Add credit");
    expect(link?.href).toContain("console.anthropic.com");
  });

  it("any other failure still offers Retry", async () => {
    const toast = await failQuickAction(
      new Error("Anthropic error 529: overloaded_error"),
    );
    expect(
      toast?.querySelector("[aria-label='Retry failed AI generation']"),
    ).not.toBeNull();
  });
});
