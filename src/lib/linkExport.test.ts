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
import { exportHtml } from "./export";
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

  it("opens the export dialog for an empty document", async () => {
    useDocumentStore.setState({ content: "" });
    invokeMock.mockResolvedValue("html");
    await expect(applyLinkExport("/notes/a.md")).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("take_link_export", {
      path: "/notes/a.md",
    });
    expect(useUiStore.getState().exportOpen).toBe(true);
    expect(useUiStore.getState().exportFormat).toBe("html");
  });

  it("preserves multiline prose and its link when exporting HTML", async () => {
    const content =
      "Before the link,\nvisit [the guide](https://example.com/guide) today.\nAfter the link.\n";
    const rendered =
      '<p>Before the link,\nvisit <a href="https://example.com/guide">the guide</a> today.\nAfter the link.</p>';
    useDocumentStore.setState({ content });
    const body = document.createElement("div");
    body.className = "markdown-body";
    body.innerHTML = rendered;
    document.body.appendChild(body);
    invokeMock.mockResolvedValueOnce("html").mockResolvedValue(undefined);

    try {
      await applyLinkExport("/notes/a.md");
      expect(useUiStore.getState().exportOpen).toBe(true);
      expect(useUiStore.getState().exportFormat).toBe("html");
      expect(useDocumentStore.getState().content).toBe(content);

      await expect(exportHtml("a", "/notes/a.html")).resolves.toBe(true);
      const write = invokeMock.mock.calls.find(
        ([command]) => command === "write_file_bytes",
      );
      expect(write).toBeDefined();
      expect(new TextDecoder().decode(write?.[1])).toContain(rendered);
    } finally {
      body.remove();
    }
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
