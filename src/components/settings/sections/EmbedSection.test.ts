// Settings > Semantic search: the `autoEmbedIndex` switch (#136) and the manual
// "Reindex library" button, which works whatever the switch says.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../../lib/embedSearch", () => ({
  embedStatus: vi.fn(async () => ({
    available: true,
    model: "nomic-embed-text",
    chunkCount: 2,
    fileCount: 1,
    lastIndexedMs: 0,
  })),
  embedIndex: vi.fn(async () => ({})),
  indexUnreadNotice: vi.fn(() => null),
  invalidateEmbedAvailable: vi.fn(),
}));

import { embedIndex } from "../../../lib/embedSearch";
import { useRecentStore } from "../../../store/recentStore";
import { useSettingsStore } from "../../../store/settingsStore";
import { EmbedSection } from "./EmbedSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Settings: semantic search", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.mocked(embedIndex).mockClear();
    useSettingsStore.setState({ autoEmbedIndex: false });
    useRecentStore.setState({ recents: [{ path: "/r/a.md" }] } as never);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(EmbedSection)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function toggle(): HTMLButtonElement {
    const t = host.querySelector('[role="switch"]');
    expect(t).not.toBeNull();
    return t as HTMLButtonElement;
  }

  it("shows the switch off by default and flips the setting", async () => {
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle().click());
    expect(useSettingsStore.getState().autoEmbedIndex).toBe(true);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle().click());
    expect(useSettingsStore.getState().autoEmbedIndex).toBe(false);
  });

  it("Reindex library still runs a full reindex when the switch is off", async () => {
    const btn = [...host.querySelectorAll("button")].find((b) =>
      /reindex/i.test(b.textContent ?? ""),
    );
    expect(btn).toBeDefined();
    await act(async () => btn?.click());
    expect(embedIndex).toHaveBeenCalledOnce();
    expect(vi.mocked(embedIndex).mock.calls[0][1]).toBe(true);
  });
});
