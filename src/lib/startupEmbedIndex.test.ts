// The startup re-index honors `autoEmbedIndex` (#136): off means it does not
// even probe for an embedding model; on runs one full reindex.

import { beforeEach, describe, expect, it, vi } from "vitest";

let autoEmbedIndex = false;
let recents = [{ path: "/r/recent.md" }];
let files = [{ path: "/w/watched.md" }, { path: "/r/recent.md" }];
vi.mock("../store/settingsStore", () => ({
  useSettingsStore: { getState: () => ({ autoEmbedIndex }) },
}));
vi.mock("../store/recentStore", () => ({
  useRecentStore: { getState: () => ({ recents }) },
}));
const loadFiles = vi.fn(async () => {});
vi.mock("../store/activityStore", () => ({
  useActivityStore: {
    getState: () => ({
      loadFiles,
      files,
    }),
  },
}));
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
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
    invokeMock.mockReset();
    autoEmbedIndex = false;
    recents = [{ path: "/r/recent.md" }];
    files = [{ path: "/w/watched.md" }, { path: "/r/recent.md" }];
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

  it("returns no matches when the startup library and index are empty", async () => {
    autoEmbedIndex = true;
    recents = [];
    files = [];
    await runStartupEmbedIndex();
    expect(loadFiles).toHaveBeenCalledOnce();
    expect(embedIndex).not.toHaveBeenCalled();

    // Exercise the real lookup wrapper with the empty result from the backend.
    invokeMock.mockResolvedValue([]);
    const { embedSearch } =
      await vi.importActual<typeof import("./embedSearch")>("./embedSearch");
    await expect(embedSearch("anything")).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("embed_search", {
      query: "anything",
      k: 8,
    });
  });
});
