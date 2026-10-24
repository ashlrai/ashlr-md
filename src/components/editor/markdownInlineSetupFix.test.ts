/**
 * The WYSIWYG editor's inline AI, like the source editor's
 * (inlineSetupFix.test.ts), offers the step that fixes a refused key (Open
 * Preferences) or an empty account (an Add credit link) instead of a Retry
 * that fails the same way, and any other failure still offers Retry. Only
 * the source editor's was tested.
 */

import { TextSelection } from "@milkdown/kit/prose/state";
import { EditorView as ProseView } from "@milkdown/kit/prose/view";
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

import { runInlineTransform } from "../../ai/inline";
import { useUiStore } from "../../store/uiStore";
import { MarkdownEditor } from "./MarkdownEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WYSIWYG editor: inline AI failures a retry cannot fix", () => {
  let host: HTMLDivElement;
  let root: Root;
  // The editor's ProseMirror view, caught when the editor asks for focus.
  let view: ProseView | null;

  beforeEach(() => {
    view = null;
    // happy-dom has no focus or layout for the editor, so it holds focus
    // and the selection has a place for the menu.
    vi.spyOn(ProseView.prototype, "hasFocus").mockImplementation(function (
      this: ProseView,
    ) {
      view = this;
      return true;
    });
    vi.spyOn(ProseView.prototype, "coordsAtPos").mockReturnValue({
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
      root.render(createElement(MarkdownEditor, { initialContent: "hello world" })),
    );
    // Crepe creates its editor asynchronously.
    for (let i = 0; i < 40 && !view; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 25));
        document.dispatchEvent(new Event("selectionchange"));
      });
    }
    expect(view).not.toBeNull();
    const v = view as ProseView;
    // Select "hello" and show the inline AI menu.
    await act(async () => {
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(host.querySelector(".inline-ai-menu")).not.toBeNull();
    // Mod-I runs Rewrite (mod is Ctrl outside macOS).
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "i",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(runInlineTransform).toHaveBeenCalled();
    const error = host.querySelector<HTMLElement>(".inline-ai-error");
    expect(error).not.toBeNull();
    return error as HTMLElement;
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
    await act(async () => open?.click());
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
