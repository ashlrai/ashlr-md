import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useDocumentStore } from "../store/documentStore";
import { applyLinkHeading, applyLinkViewMode } from "./linkViewMode";

describe("applyLinkViewMode", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useDocumentStore.setState({ path: "/notes/a.md", viewMode: "read" });
  });

  it("switches to the mode the link asked for, asking for that path", async () => {
    invokeMock.mockResolvedValue("edit");
    await applyLinkViewMode("/notes/a.md");
    expect(invokeMock).toHaveBeenCalledWith("take_link_view_mode", {
      path: "/notes/a.md",
    });
    expect(useDocumentStore.getState().viewMode).toBe("edit");
  });

  it("keeps the view when the link asked for none", async () => {
    invokeMock.mockResolvedValue(null);
    await applyLinkViewMode("/notes/a.md");
    expect(useDocumentStore.getState().viewMode).toBe("read");
  });

  it("leaves another active document alone", async () => {
    invokeMock.mockResolvedValue("edit");
    await applyLinkViewMode("/notes/b.md");
    expect(useDocumentStore.getState().viewMode).toBe("read");
  });

  it("ignores an unknown mode and a failed call", async () => {
    invokeMock.mockResolvedValue("split");
    await applyLinkViewMode("/notes/a.md");
    expect(useDocumentStore.getState().viewMode).toBe("read");
    invokeMock.mockRejectedValue(new Error("no such command"));
    await applyLinkViewMode("/notes/a.md");
    expect(useDocumentStore.getState().viewMode).toBe("read");
  });
});

describe("applyLinkHeading", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useDocumentStore.setState({ path: "/notes/a.md" });
    document.body.innerHTML = '<h2 id="caf\u00e9-menu">Café menu</h2>';
  });

  it("scrolls to the heading the link named, asking for that path", async () => {
    const seen: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      seen.push(this.id);
    };
    invokeMock.mockResolvedValue("caf\u00e9-menu");
    await applyLinkHeading("/notes/a.md");
    expect(invokeMock).toHaveBeenCalledWith("take_link_heading", {
      path: "/notes/a.md",
    });
    expect(seen).toEqual(["caf\u00e9-menu"]);
    // Another document, no heading, or a failed call: no scroll.
    await applyLinkHeading("/notes/b.md");
    invokeMock.mockResolvedValue(null);
    await applyLinkHeading("/notes/a.md");
    invokeMock.mockRejectedValue(new Error("no such command"));
    await applyLinkHeading("/notes/a.md");
    expect(seen).toEqual(["caf\u00e9-menu"]);
  });
});
