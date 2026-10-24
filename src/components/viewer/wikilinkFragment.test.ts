/**
 * A wikilink's `#fragment` scrolls to the place it names: Wikilink passed
 * the fragment as written (a percent-encoded heading, or Obsidian's
 * `#Parent#Child` subheading path, matched nothing), and `^block` ids had no
 * anchor, so `[[note#^id]]` opened the note at its top with `^id` shown as
 * text on the block.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { wikilinkFragment } from "../../lib/docLinks";
import { invalidateWikilinkCache } from "../../lib/wikilink";
import { useDocumentStore } from "../../store/documentStore";
import { Renderer } from "./Renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("wikilinkFragment", () => {
  it("decodes, takes a heading path's last heading, and keeps a block id", () => {
    expect(wikilinkFragment(null)).toBeNull();
    expect(wikilinkFragment("My%20Heading")).toBe("My Heading");
    expect(wikilinkFragment("Parent#Child")).toBe("Child");
    expect(wikilinkFragment("^abc-1")).toBe("^abc-1");
    expect(wikilinkFragment(" Spaced ")).toBe("Spaced");
    expect(wikilinkFragment("#")).toBeNull();
  });
});

describe("wikilinks to a heading or a block", () => {
  let host: HTMLDivElement;
  let root: Root;
  const scrolled: string[] = [];
  const openPath = vi.fn().mockResolvedValue(null);

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    invalidateWikilinkCache();
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "resolve_wikilink" ? "/v/doc.md" : null),
    );
    scrolled.length = 0;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    openPath.mockClear();
    useDocumentStore.setState({ path: "/v/doc.md", openPath });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  async function settle() {
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
    }
  }

  const DOC = [
    "A paragraph to link to ^para-1",
    "",
    "- item one ^item1",
    "- item two",
    "",
    "| a |",
    "| - |",
    "| b |",
    "",
    "^table1",
    "",
    "# Parent",
    "",
    "## Child Heading",
    "",
    "[[doc#^para-1|P]] [[doc#^item1|I]] [[doc#^table1|T]] [[doc#Parent#Child Heading|C]] [[doc#Child%20Heading|E]]",
    "",
  ].join("\n");

  async function click(label: string) {
    const b = [...host.querySelectorAll<HTMLButtonElement>("button.wikilink")].find(
      (x) => x.textContent === label,
    );
    if (!b) throw new Error(`no wikilink ${label}`);
    await act(async () => b.click());
    await settle();
  }

  it("anchors block ids, hides their markers, and scrolls to them", async () => {
    await act(async () => {
      root.render(createElement(Renderer, { content: DOC }));
    });
    await settle();
    // The markers are not text on the page.
    expect(host.textContent).not.toContain("^para-1");
    expect(host.textContent).not.toContain("^item1");
    expect(host.textContent).not.toContain("^table1");
    expect(host.querySelector("p")?.id).toBe("user-content-^para-1");
    expect(host.querySelector("li")?.id).toBe("user-content-^item1");
    expect(host.querySelector("table")?.id).toBe("user-content-^table1");

    await click("P");
    await click("I");
    await click("T");
    await click("C");
    await click("E");
    expect(openPath).toHaveBeenCalledTimes(5);
    expect(scrolled).toEqual([
      "user-content-^para-1",
      "user-content-^item1",
      "user-content-^table1",
      "child-heading",
      "child-heading",
    ]);
  });
});
