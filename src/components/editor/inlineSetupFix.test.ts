/**
 * After a refused key or an empty account, the editors' inline AI offered
 * Retry, which fails the same way. It now offers the step that fixes it
 * (Open Preferences, or an Add credit link), as the AI sidebar does, and
 * any other failure still offers Retry.
 */
import { EditorView } from "@codemirror/view";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const fail = vi.hoisted(() => ({ error: new Error("") }));
vi.mock("../../ai/inline", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ai/inline")>();
  return {
    ...real,
    runInlineTransform: vi.fn(async () => {
      throw fail.error;
    }),
  };
});

import { getSourceView } from "../../lib/sourceSearchBridge";
import { useUiStore } from "../../store/uiStore";
import { SourceEditor } from "./SourceEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("source editor: inline AI failures a retry cannot fix", () => {
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
    useUiStore.setState({ settingsOpen: false });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    act(() => root.unmount());
    host.remove();
  });

  async function failRewrite(err: Error): Promise<HTMLElement> {
    fail.error = err;
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
    const error = host.querySelector<HTMLElement>(".inline-ai-error");
    expect(error).not.toBeNull();
    return error!;
  }

  const buttons = (el: HTMLElement) =>
    [...el.querySelectorAll("button")].map((b) => b.textContent);

  it("a refused key offers Preferences, not Retry", async () => {
    const error = await failRewrite(
      new Error('Anthropic error 401 Unauthorized: {"type":"authentication_error"}'),
    );
    expect(buttons(error)).not.toContain("Retry");
    const open = [...error.querySelectorAll("button")].find(
      (b) => b.textContent === "Open Preferences",
    );
    expect(open).toBeDefined();
    await act(async () => open!.click());
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(host.querySelector(".inline-ai-error")).toBeNull();
  });

  it("an empty account offers to add credit, not Retry", async () => {
    const error = await failRewrite(
      new Error(
        'Anthropic error 400 Bad Request: {"message":"Your credit balance is too low"}',
      ),
    );
    expect(buttons(error)).not.toContain("Retry");
    const link = error.querySelector<HTMLAnchorElement>("a.inline-ai-retry");
    expect(link?.textContent).toBe("Add credit");
    expect(link?.href).toContain("console.anthropic.com");
  });

  it("any other failure still offers Retry", async () => {
    const error = await failRewrite(new Error("Anthropic error 529: overloaded_error"));
    expect(buttons(error)).toContain("Retry");
    expect(error.querySelector("a")).toBeNull();
  });
});
