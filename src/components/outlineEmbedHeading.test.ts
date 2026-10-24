/**
 * An embedded note (`![[other]]`) renders with its own heading ids, so a
 * heading it shares with the document has its id twice. The outline jumped
 * by `document.getElementById`, the first in the page: with the embed above,
 * "Setup" in the outline scrolled to the embed's heading, not the document's.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

import { useDocumentStore } from "../store/documentStore";
import { useUiStore } from "../store/uiStore";
import { Outline } from "./Outline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoopObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??=
  NoopObserver;

describe("the outline and an embedded note", () => {
  let host: HTMLDivElement;
  let root: Root;
  const scrolled: Element[] = [];

  beforeEach(() => {
    scrolled.length = 0;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    document.body.innerHTML =
      '<main class="app-content"><div class="markdown-body">' +
      '<div class="wikiembed"><div class="markdown-body">' +
      '<h2 id="setup" data-from="embed">Setup</h2></div></div>' +
      '<h2 id="setup" data-from="doc">Setup</h2></div></main>';
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useDocumentStore.setState({
      path: "/d/a.md",
      content: "![[other]]\n\n## Setup\n",
      viewMode: "read",
    });
    useUiStore.setState({ outlineOpen: true });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("jumps to the document's own heading", () => {
    act(() => root.render(createElement(Outline)));
    const item = host.querySelector<HTMLButtonElement>('[data-slug="setup"]');
    expect(item).not.toBeNull();
    scrolled.length = 0;
    act(() => item?.click());
    const headings = scrolled.filter((el) => el.tagName === "H2");
    expect(headings.map((el) => el.getAttribute("data-from"))).toEqual(["doc"]);
  });
});
