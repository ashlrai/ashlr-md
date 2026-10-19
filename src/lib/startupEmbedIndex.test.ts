// The startup re-index honors `autoEmbedIndex` (#136): off means it does not
// even probe for an embedding model; on runs one full reindex.

import { beforeEach, describe, expect, it, vi } from "vitest";

let autoEmbedIndex = false;
vi.mock("../store/settingsStore", () => ({
  useSettingsStore: { getState: () => ({ autoEmbedIndex }) },
}));
vi.mock("../store/recentStore", () => ({
  useRecentStore: { getState: () => ({ recents: [{ path: "/r/recent.md" }] }) },
}));
const loadFiles = vi.fn(async () => {});
vi.mock("../store/activityStore", () => ({
  useActivityStore: {
    getState: () => ({
      loadFiles,
      files: [{ path: "/w/watched.md" }, { path: "/r/recent.md" }],
    }),
  },
}));
vi.mock("./embedSearch", () => ({
  embedAvailable: vi.fn(async (): Promise<string | null> => "nomic-embed-text"),
  embedIndex: vi.fn(async () => ({})),
}));

import { embedAvailable, embedIndex } from "./embedSearch";
import { runStartupEmbedIndex } from "./startupEmbedIndex";

describe("startup re-index", () => {
  beforeEach(() => {
    vi.mocked(embedAvailable).mockClear().mockResolvedValue("nomic-embed-text");
    vi.mocked(embedIndex).mockClear();
    loadFiles.mockClear();
    autoEmbedIndex = false;
  });

  it("does nothing when autoEmbedIndex is off (the new-install default)", async () => {
    await runStartupEmbedIndex();
    expect(embedAvailable).not.toHaveBeenCalled();
    expect(loadFiles).not.toHaveBeenCalled();
    expect(embedIndex).not.toHaveBeenCalled();
  });

  it("runs one full reindex of recents and watched files when on", async () => {
    autoEmbedIndex = true;
    await runStartupEmbedIndex();
    expect(loadFiles).toHaveBeenCalledOnce();
    expect(embedIndex).toHaveBeenCalledOnce();
    const [paths, full] = vi.mocked(embedIndex).mock.calls[0];
    expect([...paths].sort()).toEqual(["/r/recent.md", "/w/watched.md"]);
    expect(full).toBe(true);
  });

  it("does nothing when on but no embedding model is installed", async () => {
    autoEmbedIndex = true;
    vi.mocked(embedAvailable).mockResolvedValue(null);
    await runStartupEmbedIndex();
    expect(embedIndex).not.toHaveBeenCalled();
  });
});
