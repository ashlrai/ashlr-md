/**
 * With no AI provider, the editors' inline AI said "Set one up in the AI
 * sidebar." and left the user to find the sidebar. The message now has a
 * "Set up AI" button that opens it, as the selection popover's does.
 */
import { EditorView } from "@codemirror/view";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../ai/inline", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ai/inline")>();
  return {
    ...real,
    runInlineTransform: vi.fn(async () => {
      throw new real.NoProviderError();
    }),
  };
});

import { NO_PROVIDER_MESSAGE } from "../../ai/errors";
import { getSourceView } from "../../lib/sourceSearchBridge";
import { useAIStore } from "../../store/aiStore";
import { SourceEditor } from "./SourceEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("source editor: inline AI with no provider", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // jsdom has no layout, so give the selection a place for the menu.
    vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue({
      top: 100,
      bottom: 120,
      left: 10,
      right: 20,
    });
    useAIStore.setState({ open: false });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    act(() => root.unmount());
    host.remove();
  });

  it("offers a button that opens the AI sidebar", async () => {
    await act(async () =>
      root.render(createElement(SourceEditor, { initialContent: "hello world" })),
    );
    const view = getSourceView();
    expect(view).not.toBeNull();
    act(() => view!.dispatch({ selection: { anchor: 0, head: 5 } }));
    // Mod-I runs Rewrite (mod is Ctrl outside macOS).
    await act(async () => {
      view!.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "i",
          keyCode: 73,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    const error = host.querySelector(".inline-ai-error");
    expect(error?.textContent).toContain(NO_PROVIDER_MESSAGE);
    const setup = [...error!.querySelectorAll("button")].find(
      (b) => b.textContent === "Set up AI",
    );
    expect(setup, "the message has a Set up AI button").toBeDefined();
    await act(async () => setup!.click());
    expect(useAIStore.getState().open).toBe(true);
    expect(host.querySelector(".inline-ai-error")).toBeNull();
  });
});
