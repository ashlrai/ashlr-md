import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useDocumentStore } from "../store/documentStore";
import { applyLinkViewMode } from "./linkViewMode";

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
