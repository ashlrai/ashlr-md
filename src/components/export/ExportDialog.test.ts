/**
 * The active export flow owns its progress in the dialog: pending exports
 * block duplicate submissions, cancellation and failure allow a retry, and
 * only a completed export reports success and schedules the dialog to close.
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
    vi.useFakeTimers();
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
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const status = () => host.querySelector(".export-status")?.textContent ?? "";

  async function clickHtml() {
    await act(async () => root.render(createElement(ExportDialog)));
    const button = host.querySelector<HTMLButtonElement>('[data-format="html"]');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
  }

  it("says nothing was exported when the save dialog is cancelled", async () => {
    exportHtml.mockResolvedValue(false);
    await clickHtml();
    expect(exportHtml).toHaveBeenCalledWith("notes");
    expect(status()).not.toContain("exported");
    act(() => vi.advanceTimersByTime(1200));
    expect(useUiStore.getState().exportOpen).toBe(true);

    exportHtml.mockResolvedValue(true);
    await clickHtml();
    expect(exportHtml).toHaveBeenCalledTimes(2);
    expect(status()).toContain("HTML exported.");
  });

  it("reports completion and closes only after the success pause", async () => {
    exportHtml.mockResolvedValue(true);
    await clickHtml();
    expect(status()).toContain("HTML exported.");
    act(() => vi.advanceTimersByTime(1199));
    expect(useUiStore.getState().exportOpen).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(useUiStore.getState().exportOpen).toBe(false);
  });

  it("disables every format while an export is pending and ignores repeat clicks", async () => {
    let finishExport!: (written: boolean) => void;
    exportHtml.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishExport = resolve;
      }),
    );
    await clickHtml();

    const buttons = host.querySelectorAll<HTMLButtonElement>(".export-format-btn");
    expect(buttons.length).toBeGreaterThan(1);
    expect([...buttons].every((button) => button.disabled)).toBe(true);
    expect(status()).toContain("Exporting HTML");
    act(() => vi.advanceTimersByTime(5000));
    expect(useUiStore.getState().exportOpen).toBe(true);
    await clickHtml();
    expect(exportHtml).toHaveBeenCalledTimes(1);

    await act(async () => finishExport(true));
    expect([...buttons].every((button) => !button.disabled)).toBe(true);
    expect(status()).toContain("HTML exported.");
  });

  it.each([
    new Error("Disk full"),
    "Permission denied",
  ])("keeps a failed export open and allows a successful retry (%s)", async (error) => {
    exportHtml.mockRejectedValueOnce(error).mockResolvedValueOnce(true);
    await clickHtml();
    expect(status()).toContain(typeof error === "string" ? error : error.message);
    expect(status()).not.toContain("exported");
    act(() => vi.advanceTimersByTime(1200));
    expect(useUiStore.getState().exportOpen).toBe(true);

    await clickHtml();
    expect(exportHtml).toHaveBeenCalledTimes(2);
    expect(status()).toContain("HTML exported.");
    act(() => vi.advanceTimersByTime(1200));
    expect(useUiStore.getState().exportOpen).toBe(false);
  });
});
