/**
 * The Export dialog's status line: it said "exported" (and closed) when the
 * save dialog was cancelled and nothing was written.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const exportHtml = vi.fn();
vi.mock("../../lib/export", () => ({
  exportDocx: vi.fn(),
  exportEpub: vi.fn(),
  exportHtml: (...args: unknown[]) => exportHtml(...args),
  exportPdf: vi.fn(),
  exportWithProfile: vi.fn(),
}));

import { useDocumentStore } from "../../store/documentStore";
import { useUiStore } from "../../store/uiStore";
import { ExportDialog } from "./ExportDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ExportDialog", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    exportHtml.mockReset();
    useDocumentStore.setState({ fileName: "notes.md" });
    useUiStore.setState({ exportOpen: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const status = () => host.querySelector(".export-status")?.textContent ?? "";

  async function clickHtml() {
    await act(async () => root.render(createElement(ExportDialog)));
    const button = host.querySelector<HTMLButtonElement>('[data-format="html"]');
    await act(async () => button?.click());
  }

  it("says nothing was exported when the save dialog is cancelled", async () => {
    exportHtml.mockResolvedValue(false);
    await clickHtml();
    expect(exportHtml).toHaveBeenCalledWith("notes");
    expect(status()).not.toContain("exported");
    expect(useUiStore.getState().exportOpen).toBe(true);
  });

  it("says the export is done once it is written", async () => {
    exportHtml.mockResolvedValue(true);
    await clickHtml();
    expect(status()).toContain("HTML exported.");
  });
});
