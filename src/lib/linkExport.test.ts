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

  it("preserves Unicode link text in exported HTML", async () => {
    const linkText = "日本語 café 🚀 e\u0301";
    const content = `See [${linkText}](https://example.com/guide).`;
    useDocumentStore.setState({ content });
    const body = document.createElement("div");
    body.className = "markdown-body";
    body.innerHTML = `<p>See <a href="https://example.com/guide">${linkText}</a>.</p>`;
    document.body.appendChild(body);
    invokeMock.mockResolvedValueOnce("html").mockResolvedValue(undefined);

    try {
      await applyLinkExport("/notes/a.md");
      expect(useUiStore.getState().exportOpen).toBe(true);
      await expect(exportHtml("a", "/notes/a.html")).resolves.toBe(true);
      const write = invokeMock.mock.calls.find(
        ([command]) => command === "write_file_bytes",
      );
      expect(write).toBeDefined();
      const html = new TextDecoder().decode(write?.[1]);
      const exported = new DOMParser().parseFromString(html, "text/html");
      const link = exported.querySelector(".markdown-body a");
      expect(link?.textContent).toBe(linkText);
      expect(link?.getAttribute("href")).toBe("https://example.com/guide");
    } finally {
      body.remove();
    }
  });

  it("preserves brackets in a link label and its destination in exported HTML", async () => {
    const content = "See [the [setup] guide](https://example.com/guide#setup).";
    useDocumentStore.setState({ content });
    const body = document.createElement("div");
    body.className = "markdown-body";
    body.innerHTML =
      '<p>See <a href="https://example.com/guide#setup">the [setup] guide</a>.</p>';
    document.body.appendChild(body);
    invokeMock.mockResolvedValueOnce("html").mockResolvedValue(undefined);

    try {
      await applyLinkExport("/notes/a.md");
      expect(useUiStore.getState().exportOpen).toBe(true);
      expect(useDocumentStore.getState().content).toBe(content);
      await expect(exportHtml("a", "/notes/a.html")).resolves.toBe(true);

      const write = invokeMock.mock.calls.find(
        ([command]) => command === "write_file_bytes",
      );
      expect(write).toBeDefined();
      const html = new TextDecoder().decode(write?.[1]);
      const exported = new DOMParser().parseFromString(html, "text/html");
      const link = exported.querySelector(".markdown-body a");
      expect(link?.textContent).toBe("the [setup] guide");
      expect(link?.getAttribute("href")).toBe("https://example.com/guide#setup");
    } finally {
      body.remove();
    }
  });

  it("exports plain text without inventing a link", async () => {
    const content = "Just some plain text.\nAnother line of prose.";
    useDocumentStore.setState({ content });
    const body = document.createElement("div");
    body.className = "markdown-body";
    body.innerHTML = `<p>${content}</p>`;
    document.body.appendChild(body);
    invokeMock.mockResolvedValueOnce("html").mockResolvedValue(undefined);

    try {
      await applyLinkExport("/notes/a.md");
      expect(useUiStore.getState().exportOpen).toBe(true);
      expect(useDocumentStore.getState().content).toBe(content);
      await expect(exportHtml("a", "/notes/a.html")).resolves.toBe(true);

      const write = invokeMock.mock.calls.find(
        ([command]) => command === "write_file_bytes",
      );
      expect(write).toBeDefined();
      const html = new TextDecoder().decode(write?.[1]);
      const exported = new DOMParser().parseFromString(html, "text/html");
      const paragraph = exported.querySelector(".markdown-body p");
      expect(paragraph?.textContent).toBe(content);
      expect(exported.querySelectorAll("a")).toHaveLength(0);
    } finally {
      body.remove();
    }
  });

  it("retains a link's fragment in the exported target", async () => {
    const content = "See [setup](https://example.com/guide#setup) first.\n";
    const rendered =
      '<p>See <a href="https://example.com/guide#setup">setup</a> first.</p>';
    useDocumentStore.setState({ content });
    const body = document.createElement("div");
    body.className = "markdown-body";
    body.innerHTML = rendered;
    document.body.appendChild(body);
    invokeMock.mockResolvedValueOnce("html").mockResolvedValue(undefined);

    try {
      await applyLinkExport("/notes/a.md");
      expect(useUiStore.getState().exportOpen).toBe(true);

      await expect(exportHtml("a", "/notes/a.html")).resolves.toBe(true);
      const write = invokeMock.mock.calls.find(
        ([command]) => command === "write_file_bytes",
      );
      expect(write).toBeDefined();
      const html = new TextDecoder().decode(write?.[1]);
      expect(html).toContain('href="https://example.com/guide#setup"');
    } finally {
      body.remove();
    }
  });

  it("keeps a fragment on the path the link asked to export", async () => {
    useDocumentStore.setState({ path: "/notes/a.md#intro" });
    invokeMock.mockResolvedValue("pdf");
    await applyLinkExport("/notes/a.md#intro");
    expect(invokeMock).toHaveBeenCalledWith("take_link_export", {
      path: "/notes/a.md#intro",
    });
    expect(useUiStore.getState().exportOpen).toBe(true);
    expect(useUiStore.getState().exportFormat).toBe("pdf");
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

  it("returns an empty result for empty input without throwing", async () => {
    // Empty path, and the backend has no pending export for it.
    useDocumentStore.setState({ path: "" });
    invokeMock.mockResolvedValue(null);
    await expect(applyLinkExport("")).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("take_link_export", { path: "" });
    expect(useUiStore.getState().exportOpen).toBe(false);

    // Empty format string is not a format, even for the matching path.
    invokeMock.mockResolvedValue("");
    await expect(applyLinkExport("")).resolves.toBeUndefined();
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
