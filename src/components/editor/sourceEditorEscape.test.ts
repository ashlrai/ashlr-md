/**
 * Esc cancels a running inline AI transform in the source editor, but an
 * Escape that ends an IME composition belongs to the input method. The
 * editor's CodeMirror "Escape" binding used to take that one too and cancel
 * the rewrite; the WYSIWYG editor already checked isDismissEscape.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const seen: { signal?: AbortSignal } = {};
vi.mock("../../ai/inline", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ai/inline")>();
  return {
    ...real,
    // Streams until aborted, as a slow model does.
    runInlineTransform: vi.fn(
      (opts: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          seen.signal = opts.signal;
          opts.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ),
  };
});

import { getSourceView } from "../../lib/sourceSearchBridge";
import { SourceEditor } from "./SourceEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function press(target: Element, init: KeyboardEventInit) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
}

describe("source editor: Esc during an inline AI transform", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    seen.signal = undefined;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("ignores a composing Escape and cancels on a plain one", async () => {
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
    expect(seen.signal).toBeDefined();
    expect(seen.signal!.aborted).toBe(false);

    press(view!.contentDOM, { key: "Escape", keyCode: 229 });
    expect(seen.signal!.aborted).toBe(false);
    press(view!.contentDOM, { key: "Escape", keyCode: 27, isComposing: true });
    expect(seen.signal!.aborted).toBe(false);

    press(view!.contentDOM, { key: "Escape", keyCode: 27 });
    expect(seen.signal!.aborted).toBe(true);
  });
});
