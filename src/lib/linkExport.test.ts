import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useDocumentStore } from "../store/documentStore";
import { useUiStore } from "../store/uiStore";
import { applyLinkExport } from "./linkExport";

describe("applyLinkExport", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useDocumentStore.setState({ path: "/notes/a.md" });
    useUiStore.getState().closeExport();
  });

  it("opens the export dialog with the link's format, asking for that path", async () => {
    invokeMock.mockResolvedValue("docx");
    await applyLinkExport("/notes/a.md");
    expect(invokeMock).toHaveBeenCalledWith("take_link_export", {
      path: "/notes/a.md",
    });
    expect(useUiStore.getState().exportOpen).toBe(true);
    expect(useUiStore.getState().exportFormat).toBe("docx");
  });

  it("does nothing when the link asked for no export", async () => {
    invokeMock.mockResolvedValue(null);
    await applyLinkExport("/notes/a.md");
    expect(useUiStore.getState().exportOpen).toBe(false);
  });

  it("does not export another active document", async () => {
    invokeMock.mockResolvedValue("pdf");
    await applyLinkExport("/notes/b.md");
    expect(useUiStore.getState().exportOpen).toBe(false);
  });

  it("ignores an unknown format and a failed call", async () => {
    invokeMock.mockResolvedValue("md");
    await applyLinkExport("/notes/a.md");
    expect(useUiStore.getState().exportOpen).toBe(false);
    invokeMock.mockRejectedValue(new Error("no such command"));
    await applyLinkExport("/notes/a.md");
    expect(useUiStore.getState().exportOpen).toBe(false);
  });
});
