import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { Renderer } from "../components/viewer/Renderer";
import { useDocumentStore } from "../store/documentStore";
import { useToastStore } from "../store/toastStore";
import {
  anchorElement,
  imageSource,
  linkTarget,
  resolveFromDocument,
} from "./docLinks";
import { invalidateWikilinkCache } from "./wikilink";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("linkTarget", () => {
  const doc = "/v/notes/doc.md";
  it("leaves web and mail links to the opener plugin", () => {
    for (const h of ["https://x.org/a", "HTTP://x.org", "mailto:a@b.c", "tel:+1"]) {
      expect(linkTarget(h, doc)).toEqual({ kind: "external" });
    }
  });

  it("reads a fragment as an anchor in this document", () => {
    expect(linkTarget("#my-heading", doc)).toEqual({
      kind: "anchor",
      id: "my-heading",
    });
    expect(linkTarget("#caf%C3%A9", doc)).toEqual({ kind: "anchor", id: "café" });
  });

  it("opens a Markdown document relative to this one, with its heading", () => {
    expect(linkTarget("other.md", doc)).toEqual({
      kind: "document",
      path: "/v/notes/other.md",
      fragment: null,
    });
    expect(linkTarget("../My%20Note.md#Part%202", doc)).toEqual({
      kind: "document",
      path: "/v/My Note.md",
      fragment: "Part 2",
    });
    expect(linkTarget("./sub/caf%C3%A9.markdown?x=1", doc)).toMatchObject({
      path: "/v/notes/sub/café.markdown",
    });
    // `..` never climbs past the root.
    expect(linkTarget("../../../../x.md", doc)).toMatchObject({ path: "/x.md" });
    expect(linkTarget("/abs/x.md", doc)).toMatchObject({ path: "/abs/x.md" });
  });

  it("reads a bare name with no extension as a note to look up", () => {
    expect(linkTarget("Plan", doc)).toEqual({
      kind: "note",
      name: "Plan",
      fragment: null,
    });
    expect(linkTarget("sub/My%20Plan#Goals", doc)).toEqual({
      kind: "note",
      name: "sub/My Plan",
      fragment: "Goals",
    });
    // Unsaved, a folder, or hidden: not looked up.
    expect(linkTarget("Plan", null).kind).toBe("blocked");
    expect(linkTarget("sub/", doc).kind).toBe("blocked");
    expect(linkTarget(".env", doc).kind).toBe("blocked");
  });

  it("refuses other schemes, other files and hidden folders", () => {
    for (const h of [
      "obsidian://open?vault=x",
      "vscode://file/etc/passwd",
      "file:///etc/hosts",
      "javascript:alert(1)",
      "//evil.example/x.md",
      "irc://x",
    ]) {
      expect(linkTarget(h, doc).kind).toBe("blocked");
    }
    expect(linkTarget("../../.ssh/config", doc).kind).toBe("blocked");
    expect(linkTarget("../.secret/notes.md", doc).kind).toBe("blocked");
    expect(linkTarget("report.pdf", doc).kind).toBe("blocked");
    expect(linkTarget("", doc).kind).toBe("blocked");
    expect(linkTarget("other.md", null).kind).toBe("blocked");
  });
});

describe("anchorElement", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  /** A document whose embedded note, shown first, has a heading it shares. */
  function page() {
    document.body.innerHTML =
      '<main class="app-content"><div class="markdown-body" id="doc">' +
      '<div class="wikiembed"><div class="markdown-body" id="embed">' +
      '<h2 id="setup">Setup</h2></div></div>' +
      '<h2 id="setup">Setup</h2><p id="own">x</p></div></main>';
    const doc = document.getElementById("doc") as HTMLElement;
    const embed = document.getElementById("embed") as HTMLElement;
    return { doc, embed, own: doc.lastElementChild?.previousElementSibling };
  }

  it("takes the document's own heading over an embedded note's with that id", () => {
    const { doc, own } = page();
    expect(anchorElement("setup", doc)).toBe(own);
    expect(anchorElement("Setup", doc)).toBe(own);
    // From the whole page too (a link opened from another document).
    expect(anchorElement("setup")).toBe(own);
  });

  it("takes the embed's heading for a link inside that embed", () => {
    const { embed } = page();
    expect(anchorElement("setup", embed)).toBe(embed.firstElementChild);
  });

  it("still finds a heading that only an embed has", () => {
    const { doc, embed } = page();
    doc.lastElementChild?.previousElementSibling?.remove();
    expect(anchorElement("setup", doc)).toBe(embed.firstElementChild);
  });
});

describe("imageSource", () => {
  const doc = "/v/doc.md";
  it("reads a local image relative to the document, decoded", () => {
    expect(imageSource("assets/my%20pic.png", doc)).toEqual({
      kind: "local",
      path: "/v/assets/my pic.png",
    });
    expect(imageSource("../%E5%9B%BE.JPG", doc)).toEqual({
      kind: "local",
      path: "/图.JPG",
    });
    expect(imageSource("https://x.org/a.png", doc)).toEqual({
      kind: "remote",
      src: "https://x.org/a.png",
    });
  });

  it("refuses other schemes, non-images and hidden folders", () => {
    expect(imageSource("file:///x.png", doc).kind).toBe("blocked");
    expect(imageSource("notes.md", doc).kind).toBe("blocked");
    expect(imageSource(".cache/x.png", doc).kind).toBe("blocked");
    expect(imageSource("x.png", null).kind).toBe("blocked");
  });
});

describe("resolveFromDocument on Windows paths", () => {
  it("joins with backslashes and keeps the drive", () => {
    expect(resolveFromDocument("C:\\v\\n\\doc.md", "../a/b.md")).toBe("C:\\v\\a\\b.md");
    expect(resolveFromDocument("C:\\doc.md", "../../x.md")).toBe("C:\\x.md");
  });
});

describe("the read view follows links and shows local images", () => {
  let host: HTMLDivElement;
  let root: Root;
  const openPath = vi.fn().mockResolvedValue(null);
  const scrolled: string[] = [];

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "read_image_data_url") {
        return args?.path === "/v/assets/my pic.png"
          ? Promise.resolve("data:image/png;base64,AA==")
          : Promise.reject("not found (os error 2)");
      }
      return Promise.resolve(null);
    });
    openPath.mockClear();
    scrolled.length = 0;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    useDocumentStore.setState({ path: "/v/doc.md", openPath });
    useToastStore.setState({ toasts: [] });
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

  /** Click the link `text`; whether the app's handler prevented it. */
  function click(text: string): boolean {
    const a = [...host.querySelectorAll("a")].find((x) => x.textContent === text);
    if (!a) throw new Error(`no link ${text}`);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    // Seen after React's handler (as the opener plugin's window listener
    // sees it), then prevented so the test environment does not navigate.
    let prevented = false;
    const seen = (e: Event) => {
      prevented = e.defaultPrevented;
      e.preventDefault();
    };
    window.addEventListener("click", seen);
    act(() => {
      a.dispatchEvent(ev);
    });
    window.removeEventListener("click", seen);
    return prevented;
  }

  it("opens a relative Markdown link in a tab and scrolls to a #heading here", async () => {
    await render(
      "[Other](other%20note.md#Intro) [Top](#My%20Heading) [Slug](#my-heading) [Web](https://x.org) [App](irc://x)\n\n# My Heading\n",
    );
    expect(click("Other")).toBe(true);
    expect(openPath).toHaveBeenCalledWith("/v/other note.md", {
      keepViewOnError: true,
    });
    // A fragment is the heading's text or its slug.
    expect(click("Top")).toBe(true);
    click("Slug");
    expect(scrolled).toEqual(["my-heading", "my-heading"]);
    // A web link is the opener plugin's: not prevented.
    expect(click("Web")).toBe(false);
    // Another scheme the sanitizer keeps: not followed, and said why.
    expect(click("App")).toBe(true);
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(
      useToastStore
        .getState()
        .toasts.map((t) => t.message)
        .join(),
    ).toMatch(/does not open irc/);
  });

  it("opens a bare [x](Note) as a wikilink resolves it, and says when there is none", async () => {
    invalidateWikilinkCache();
    invokeMock.mockImplementation((cmd: string, args?: { target?: string }) => {
      if (cmd === "resolve_wikilink") {
        return Promise.resolve(args?.target === "Plan" ? "/v/notes/Plan.md" : null);
      }
      return Promise.resolve(null);
    });
    await render("[Plan](Plan#Goals) [Gone](Gone)\n");
    expect(click("Plan")).toBe(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(invokeMock).toHaveBeenCalledWith("resolve_wikilink", {
      baseDir: "/v",
      target: "Plan",
      vaultRoot: null,
    });
    expect(openPath).toHaveBeenCalledWith("/v/notes/Plan.md", {
      keepViewOnError: true,
    });
    expect(click("Gone")).toBe(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(
      useToastStore
        .getState()
        .toasts.map((t) => t.message)
        .join(),
    ).toMatch(/No note named “Gone”/);
  });

  it("shows a relative image through Rust, and says when one is missing", async () => {
    await render("![pic](assets/my%20pic.png) ![gone](missing.png)\n");
    const img = host.querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AA==");
    expect(invokeMock).toHaveBeenCalledWith("read_image_data_url", {
      path: "/v/assets/my pic.png",
    });
    expect(host.textContent).toContain("Missing image “gone”");
  });
});
