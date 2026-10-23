/**
 * The selection popover's Translate button read only "Translate", and the
 * popover, which has no language picker, translated into Spanish. The button
 * and the chat now name the language it translates into.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
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
    runSelectionAction: run,
  };
});

import { DEFAULT_TRANSLATE_LANGUAGE } from "../../ai/actions";
import { useAIStore } from "../../store/aiStore";
import { SelectionPopover } from "./SelectionPopover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the selection popover's Translate button", () => {
  let host: HTMLDivElement;
  let doc: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    doc = document.createElement("div");
    doc.className = "markdown-body";
    doc.textContent = "Hello there";
    document.body.appendChild(doc);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useAIStore.setState({ open: true, messages: [], busy: false, providerId: "fake" });
    run.mockReset();
    run.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    doc.remove();
  });

  it("names the language it translates into", async () => {
    expect(DEFAULT_TRANSLATE_LANGUAGE).toBe("Spanish");
    await act(async () => root.render(createElement(SelectionPopover)));
    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(doc);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const button = host.querySelector<HTMLButtonElement>(
      ".ai-selection-popover button[title='Translate to Spanish']",
    );
    expect(button, "the button's title names the language").not.toBeNull();
    expect(button!.textContent).toContain("To Spanish");

    await act(async () => button!.click());
    const user = useAIStore.getState().messages.find((m) => m.role === "user");
    expect(user?.content).toBe('Translate to Spanish: "Hello there"');
    const sent = run.mock.calls[0][1] as { role: string; content: string }[];
    expect(sent.at(-1)?.content).toContain("into Spanish");
  });
});
