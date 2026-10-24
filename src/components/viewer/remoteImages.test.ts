/**
 * Settings → "Load remote images". A web image (`![](https://...)`, or a raw
 * `<img>` or `<picture><source srcset>`) is fetched as the document renders,
 * which tells its host the document was opened. The CSP allows `https:`
 * images and cannot change at run time, so the renderer enforces the
 * setting: on (the default), images load as before; off, they show as
 * placeholders until the document's "Load remote images" is clicked.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { editorImageUrl } from "../../lib/docLinks";
import { cloneWithoutInjectedChrome } from "../../lib/export";
import { useDocumentStore } from "../../store/documentStore";
import { useRemoteImagesStore } from "../../store/remoteImagesStore";
import { useSettingsStore } from "../../store/settingsStore";
import { Renderer } from "./Renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DOC = [
  "![pixel](https://tracker.example/p.png)",
  "",
  '<picture><source srcset="https://tracker.example/big.png"><img src="https://tracker.example/raw.png" alt="raw"></picture>',
  "",
].join("\n");

describe("remote images in the read view", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useDocumentStore.setState({ path: "/v/doc.md" });
    useRemoteImagesStore.setState({ allowed: {} });
    useSettingsStore.setState({ loadRemoteImages: true });
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
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  /** Every web address the page would fetch an image from. */
  const fetched = () => [
    ...[...host.querySelectorAll("img")].map((i) => i.getAttribute("src")),
    ...[...host.querySelectorAll("source")].map((x) => x.getAttribute("srcset")),
  ];

  it("loads them by default, as before the setting", async () => {
    expect(useSettingsStore.getInitialState().loadRemoteImages).toBe(true);
    await render(DOC);
    expect(fetched()).toEqual(
      expect.arrayContaining([
        "https://tracker.example/p.png",
        "https://tracker.example/raw.png",
        "https://tracker.example/big.png",
      ]),
    );
    expect(host.querySelector(".remote-images-banner")).toBeNull();
  });

  it("with the setting off, renders none until the document's are loaded", async () => {
    useSettingsStore.setState({ loadRemoteImages: false });
    await render(DOC);
    expect(fetched()).toEqual([]);
    expect(host.querySelectorAll(".remote-image-blocked")).toHaveLength(2);
    expect(host.textContent).toContain("pixel");
    const banner = host.querySelector(".remote-images-banner");
    expect(banner?.textContent).toContain(
      "Remote images in this document are not loaded.",
    );

    // Exports and copies leave out the bar and its buttons.
    const clone = cloneWithoutInjectedChrome(host.querySelector(".markdown-body")!);
    expect(clone.querySelector(".remote-images-banner, .remote-image-load")).toBeNull();
    expect(clone.textContent).toContain("pixel");

    await act(async () => banner?.querySelector("button")?.click());
    expect(fetched()).toContain("https://tracker.example/p.png");
    expect(fetched()).toContain("https://tracker.example/big.png");
    expect(host.querySelector(".remote-images-banner")).toBeNull();

    // Only for that document.
    useDocumentStore.setState({ path: "/v/other.md" });
    await render(`${DOC}\n`);
    expect(fetched()).toEqual([]);
  });

  it("the editor shows no web image while they are blocked", async () => {
    const read = vi.fn().mockResolvedValue("data:image/png;base64,AA==");
    const url = "https://tracker.example/p.png";
    expect(await editorImageUrl(url, "/v/doc.md", read)).toBe(url);
    expect(await editorImageUrl(url, "/v/doc.md", read, false)).toBe("");
    expect(await editorImageUrl("a.png", "/v/doc.md", read, false)).toBe(
      "data:image/png;base64,AA==",
    );
  });
});
