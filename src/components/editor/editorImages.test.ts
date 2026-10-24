/**
 * Images in the WYSIWYG (Milkdown) editor load as they do in the read view
 * (MarkdownImage, Renderer.tsx): a relative path is read through Rust as a
 * `data:` URL, relative to the document. The editor used the path as the
 * `<img>` src, which loads from the app's own origin, so a pasted image
 * (`![](assets/x.png)`) showed broken while editing. The Markdown written
 * back keeps the path as written.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { useDocumentStore } from "../../store/documentStore";
import { MarkdownEditor } from "./MarkdownEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA_URL = "data:image/png;base64,AA==";

describe("WYSIWYG editor: images", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "read_image_data_url") {
        return args?.path === "/v/notes/assets/my pic.png"
          ? Promise.resolve(DATA_URL)
          : Promise.reject("not found (os error 2)");
      }
      return Promise.resolve(undefined);
    });
    useDocumentStore.setState({ path: "/v/notes/doc.md" });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function srcs(content: string): Promise<string[]> {
    await act(async () =>
      root.render(createElement(MarkdownEditor, { initialContent: content })),
    );
    let found: string[] = [];
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 25));
      });
      found = [...host.querySelectorAll<HTMLImageElement>(".ProseMirror img")]
        .map((img) => img.getAttribute("src") ?? "")
        .filter((s) => s !== "");
      if (found.length > 0 && found.every((s) => !s.startsWith("assets"))) break;
    }
    return found;
  }

  it("shows a relative image through Rust, relative to the document", async () => {
    const found = await srcs("Text\n\n![pic](assets/my%20pic.png)\n");
    expect(invoke).toHaveBeenCalledWith("read_image_data_url", {
      path: "/v/notes/assets/my pic.png",
    });
    expect(found).toContain(DATA_URL);
    expect(found.some((s) => s.startsWith("assets"))).toBe(false);
  });

  it("shows a web image as written", async () => {
    const found = await srcs("![web](https://example.com/a.png)\n");
    expect(found).toContain("https://example.com/a.png");
  });
});
