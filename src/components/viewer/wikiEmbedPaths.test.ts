/**
 * An embedded note's own relative links, images and wikilinks resolve from
 * the embedded file, not from the document holding the embed. They used to
 * resolve from the open document (the store's path), so `![](img.png)` in
 * `sub/embedded.md` was looked for next to the host and never shown, and its
 * `[[other]]` and `[x](rel.md)` pointed at the host's folder.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { invalidateWikilinkCache } from "../../lib/wikilink";
import { useDocumentStore } from "../../store/documentStore";
import { useSettingsStore } from "../../store/settingsStore";
import { Renderer } from "./Renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMBEDDED = "# Embedded\n\n![pic](img.png)\n\n[[other]] [rel](rel.md)\n";

describe("relative links in an embedded note", () => {
  let host: HTMLDivElement;
  let root: Root;
  const openPath = vi.fn().mockResolvedValue(null);

  beforeEach(() => {
    invalidateWikilinkCache();
    invoke.mockReset();
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "detect_vault_root":
          return Promise.resolve(null);
        case "resolve_wikilink": {
          const { baseDir, target } = args as { baseDir: string; target: string };
          if (baseDir === "/vault" && target === "sub/embedded")
            return Promise.resolve("/vault/sub/embedded.md");
          if (baseDir === "/vault/sub" && target === "other")
            return Promise.resolve("/vault/sub/other.md");
          return Promise.resolve(null);
        }
        case "read_markdown_file":
          return args?.path === "/vault/sub/embedded.md"
            ? Promise.resolve({ content: EMBEDDED })
            : Promise.reject("not found (os error 2)");
        case "read_image_data_url":
          return args?.path === "/vault/sub/img.png"
            ? Promise.resolve("data:image/png;base64,AA==")
            : Promise.reject("not found (os error 2)");
        default:
          return Promise.resolve(null);
      }
    });
    openPath.mockClear();
    useSettingsStore.setState({ vaultRoot: null });
    useDocumentStore.setState({ path: "/vault/host.md", openPath });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render(content: string) {
    await act(async () => {
      root.render(createElement(Renderer, { content }));
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }

  it("resolves the embed's image, wikilink and Markdown link from its own file", async () => {
    await render("Host [[top]] text\n\n![[sub/embedded]]\n");
    expect(host.textContent).toContain("Embedded");
    // The image next to the embedded note shows.
    expect(invoke).toHaveBeenCalledWith("read_image_data_url", {
      path: "/vault/sub/img.png",
    });
    const img = host.querySelector(".wikiembed img");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AA==");
    // Its wikilink is looked up from its folder, and resolves.
    expect(invoke).toHaveBeenCalledWith("resolve_wikilink", {
      baseDir: "/vault/sub",
      target: "other",
      vaultRoot: null,
    });
    const wikilink = host.querySelector<HTMLButtonElement>(
      ".wikiembed button.wikilink",
    );
    expect(wikilink?.disabled).toBe(false);
    await act(async () => wikilink?.click());
    expect(openPath).toHaveBeenCalledWith("/vault/sub/other.md", {
      keepViewOnError: true,
    });
    // Its Markdown link opens next to it.
    const a = [...host.querySelectorAll("a")].find((x) => x.textContent === "rel");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    window.addEventListener("click", (e) => e.preventDefault(), { once: true });
    act(() => {
      a?.dispatchEvent(ev);
    });
    expect(openPath).toHaveBeenCalledWith("/vault/sub/rel.md", {
      keepViewOnError: true,
    });
  });
});
