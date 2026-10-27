import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────
// Replace all external I/O so the store runs in happy-dom without Tauri/FS.

vi.mock("../lib/activity", () => {
  const listMarkdownFiles = vi.fn();
  return {
    listMarkdownFiles,
    // The store scans; by default a scan is the listing with no cut.
    scanMarkdownFiles: vi.fn(async (path: string, limit?: number) => ({
      files: await listMarkdownFiles(path, limit),
      scanCut: false,
    })),
    ACTIVITY_EVENT: "activity://file",
  };
});

vi.mock("../lib/notify", () => ({
  notifyAgentActivity: vi.fn(),
}));

vi.mock("../lib/embedSearch", () => ({
  embedIndex: vi.fn(),
}));

const toastInfoMock = vi.fn();
vi.mock("./toastStore", () => ({
  toast: { info: (...args: unknown[]) => toastInfoMock(...args) },
}));

vi.mock("./activationStore", () => ({
  useActivationStore: { getState: () => ({ markActivated: vi.fn() }) },
}));

vi.mock("./documentStore", () => ({
  useDocumentStore: { getState: () => ({ openPath: vi.fn() }) },
}));

let autoEmbedIndex = false;
vi.mock("./settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ notificationsEnabled: false, autoEmbedIndex }),
  },
}));

vi.mock("./uiStore", () => ({
  useUiStore: { getState: () => ({ activityOpen: false, openActivity: vi.fn() }) },
}));

import type { ActivityEvent, MdFileInfo } from "../lib/activity";
import { listMarkdownFiles, scanMarkdownFiles } from "../lib/activity";
import { embedIndex } from "../lib/embedSearch";
import { MAX_FILES, useActivityStore } from "./activityStore";

const listMock = listMarkdownFiles as ReturnType<typeof vi.fn>;
const scanMock = scanMarkdownFiles as ReturnType<typeof vi.fn>;

function makeFile(name: string, mtimeMs = Date.now()): MdFileInfo {
  return { path: `/watch/${name}`, name, dir: "/watch", mtimeMs, size: 100 };
}

function makeEvent(
  name: string,
  kind: ActivityEvent["kind"] = "modified",
  mtimeMs = Date.now(),
): ActivityEvent {
  return { path: `/watch/${name}`, name, dir: "/watch", mtimeMs, size: 100, kind };
}

function reset() {
  useActivityStore.setState({
    watchedDir: null,
    files: [],
    unseen: [],
    lastError: null,
    truncated: false,
    scanCut: false,
    depthCut: false,
  });
  toastInfoMock.mockClear();
  listMock.mockReset();
}

describe("activityStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reset();
  });

  afterEach(() => {
    // Flush any pending debounce timers so module-level pendingNew[] is drained
    // before the next test installs a new fake-timer environment.
    vi.runAllTimers();
    vi.useRealTimers();
  });

  // ── Watched folder persistence ──────────────────────────────────────────

  it("setWatchedDir stores the directory and clears lastError", () => {
    useActivityStore.setState({ lastError: "old error" });
    useActivityStore.getState().setWatchedDir("/watch");
    const s = useActivityStore.getState();
    expect(s.watchedDir).toBe("/watch");
    expect(s.lastError).toBeNull();
  });

  it("setWatchedDir(null) clears the directory", () => {
    useActivityStore.setState({ watchedDir: "/watch" });
    useActivityStore.getState().setWatchedDir(null);
    expect(useActivityStore.getState().watchedDir).toBeNull();
  });

  // ── File list loading ───────────────────────────────────────────────────

  it("loadFiles populates the file list from listMarkdownFiles", async () => {
    const files = [makeFile("a.md"), makeFile("b.md")];
    listMock.mockResolvedValue(files);
    useActivityStore.setState({ watchedDir: "/watch" });
    await useActivityStore.getState().loadFiles();
    expect(useActivityStore.getState().files).toEqual(files);
    expect(useActivityStore.getState().lastError).toBeNull();
  });

  it("loadFiles clears files and skips the call when watchedDir is null", async () => {
    useActivityStore.setState({ files: [makeFile("stale.md")] });
    await useActivityStore.getState().loadFiles();
    expect(listMock).not.toHaveBeenCalled();
    expect(useActivityStore.getState().files).toHaveLength(0);
  });

  it("loadFiles records lastError on failure", async () => {
    listMock.mockRejectedValue(new Error("EPERM"));
    useActivityStore.setState({ watchedDir: "/watch" });
    await useActivityStore.getState().loadFiles();
    expect(useActivityStore.getState().lastError).toBe("EPERM");
  });

  // ── applyEvent / file list sorting and cap ─────────────────────────────

  it("applyEvent upserts the file to the front of the list", () => {
    const a = makeFile("a.md", 1000);
    const b = makeFile("b.md", 2000);
    useActivityStore.setState({ files: [b, a] });
    useActivityStore.getState().applyEvent(makeEvent("a.md", "modified", 3000));
    const names = useActivityStore.getState().files.map((f) => f.name);
    expect(names[0]).toBe("a.md"); // moved to front
    expect(names).toHaveLength(2); // no duplicate
  });

  it("applyEvent caps the file list at MAX_FILES (200)", () => {
    const existing = Array.from({ length: 200 }, (_, i) => makeFile(`file-${i}.md`, i));
    useActivityStore.setState({ files: existing });
    useActivityStore.getState().applyEvent(makeEvent("new.md", "created"));
    expect(useActivityStore.getState().files).toHaveLength(200);
    expect(useActivityStore.getState().files[0].name).toBe("new.md");
    // The oldest file left the list, so it no longer holds every file.
    expect(useActivityStore.getState().truncated).toBe(true);
  });

  it("a removed event drops the file and its badge, without a toast or re-index", () => {
    autoEmbedIndex = true;
    vi.mocked(embedIndex).mockClear();
    try {
      const a = makeFile("a.md", 1000);
      const b = makeFile("b.md", 2000);
      useActivityStore.setState({ files: [b, a], unseen: ["/watch/a.md"] });
      useActivityStore.getState().applyEvent(makeEvent("a.md", "removed", 0));
      const s = useActivityStore.getState();
      expect(s.files.map((f) => f.name)).toEqual(["b.md"]);
      expect(s.unseen).toEqual([]);
      vi.advanceTimersByTime(5000);
      expect(toastInfoMock).not.toHaveBeenCalled();
      expect(embedIndex).not.toHaveBeenCalled();
    } finally {
      autoEmbedIndex = false;
    }
  });

  it("a rename inside the folder replaces the old entry with the new one", () => {
    useActivityStore.setState({ files: [makeFile("old.md", 1000)] });
    useActivityStore.getState().applyEvent(makeEvent("new.md", "modified", 2000));
    useActivityStore.getState().applyEvent(makeEvent("old.md", "removed", 0));
    expect(useActivityStore.getState().files.map((f) => f.name)).toEqual(["new.md"]);
  });

  it("a removal from a list cut short lists the folder again", async () => {
    listMock.mockResolvedValue([makeFile("older.md", 1)]);
    useActivityStore.setState({
      watchedDir: "/watch",
      files: [makeFile("a.md", 2)],
      truncated: true,
    });
    useActivityStore.getState().applyEvent(makeEvent("a.md", "removed", 0));
    await vi.waitFor(() =>
      expect(useActivityStore.getState().files.map((f) => f.name)).toEqual([
        "older.md",
      ]),
    );
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("an older listing that finishes last does not overwrite a newer one", async () => {
    // The first listing still names a file a later removal dropped; a
    // refill started meanwhile lists the folder as it is now.
    let resolveOld: (f: MdFileInfo[]) => void = () => {};
    listMock.mockImplementationOnce(
      () =>
        new Promise<MdFileInfo[]>((r) => {
          resolveOld = r;
        }),
    );
    listMock.mockResolvedValueOnce([makeFile("b.md", 1)]);
    useActivityStore.setState({ watchedDir: "/watch" });
    const older = useActivityStore.getState().loadFiles();
    await useActivityStore.getState().loadFiles();
    resolveOld([makeFile("a.md", 2), makeFile("b.md", 1)]);
    await older;
    expect(useActivityStore.getState().files.map((f) => f.name)).toEqual(["b.md"]);
  });

  it("a listing keeps the files written and removed while it ran", async () => {
    // The walk saw old.md and missed fresh.md; both changed before it finished.
    let resolveScan: (f: MdFileInfo[]) => void = () => {};
    listMock.mockImplementationOnce(
      () =>
        new Promise<MdFileInfo[]>((r) => {
          resolveScan = r;
        }),
    );
    useActivityStore.setState({ watchedDir: "/watch" });
    const pending = useActivityStore.getState().loadFiles();
    useActivityStore.getState().applyEvent(makeEvent("fresh.md", "created", 3));
    useActivityStore.getState().applyEvent(makeEvent("old.md", "removed", 0));
    resolveScan([makeFile("old.md", 2), makeFile("kept.md", 1)]);
    await pending;
    expect(useActivityStore.getState().files.map((f) => f.name)).toEqual([
      "fresh.md",
      "kept.md",
    ]);
  });

  it("a removal heard during a listing cut short lists the folder again", async () => {
    let resolveScan: (f: MdFileInfo[]) => void = () => {};
    listMock.mockImplementationOnce(
      () =>
        new Promise<MdFileInfo[]>((r) => {
          resolveScan = r;
        }),
    );
    listMock.mockResolvedValueOnce([makeFile("older.md", 1)]);
    useActivityStore.setState({ watchedDir: "/watch" });
    const pending = useActivityStore.getState().loadFiles();
    useActivityStore.getState().applyEvent(makeEvent("gone.md", "removed", 0));
    // One more than the list keeps: the folder has more than it shows.
    resolveScan(
      Array.from({ length: MAX_FILES + 1 }, (_, i) =>
        i === 0 ? makeFile("gone.md", 9999) : makeFile(`n${i}.md`, 9000 - i),
      ),
    );
    await pending;
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it("a removal from a whole list does not list the folder again", () => {
    useActivityStore.setState({ watchedDir: "/watch", files: [makeFile("a.md", 2)] });
    useActivityStore.getState().applyEvent(makeEvent("a.md", "removed", 0));
    expect(listMock).not.toHaveBeenCalled();
  });

  it("a removed folder drops every file under it, and nothing beside it", () => {
    const under = (path: string, mtimeMs: number): MdFileInfo => ({
      path,
      name: path.split("/").pop() ?? "",
      dir: path.slice(0, path.lastIndexOf("/")),
      mtimeMs,
      size: 1,
    });
    useActivityStore.setState({
      files: [
        under("/watch/notes/a.md", 4),
        under("/watch/notes/deep/b.md", 3),
        under("/watch/notes-old/c.md", 2),
        under("/watch/d.md", 1),
      ],
      unseen: ["/watch/notes/a.md", "/watch/d.md"],
    });
    useActivityStore.getState().applyEvent({
      kind: "removed",
      path: "/watch/notes",
      name: "notes",
      dir: "/watch",
      mtimeMs: 0,
      size: 0,
    });
    const s = useActivityStore.getState();
    expect(s.files.map((f) => f.path)).toEqual([
      "/watch/notes-old/c.md",
      "/watch/d.md",
    ]);
    expect(s.unseen).toEqual(["/watch/d.md"]);
  });

  // ── Unseen badge ────────────────────────────────────────────────────────

  it("applyEvent adds path to unseen when the drawer is closed", () => {
    useActivityStore.getState().applyEvent(makeEvent("x.md", "modified"));
    expect(useActivityStore.getState().unseen).toContain("/watch/x.md");
  });

  it("markAllSeen clears the unseen list", () => {
    useActivityStore.setState({ unseen: ["/watch/a.md", "/watch/b.md"] });
    useActivityStore.getState().markAllSeen();
    expect(useActivityStore.getState().unseen).toHaveLength(0);
  });

  // ── Toast coalescing ────────────────────────────────────────────────────

  it("a single novel created event fires one toast after the debounce window", () => {
    useActivityStore.getState().applyEvent(makeEvent("plan.md", "created"));
    expect(toastInfoMock).not.toHaveBeenCalled(); // still debouncing
    vi.advanceTimersByTime(700);
    expect(toastInfoMock).toHaveBeenCalledOnce();
    expect(toastInfoMock.mock.calls[0][0]).toContain("plan.md");
  });

  // ── Opt-in semantic re-index ────────────────────────────────────────────

  describe("autoEmbedIndex", () => {
    beforeEach(() => {
      vi.mocked(embedIndex).mockClear();
    });
    afterEach(() => {
      autoEmbedIndex = false;
    });

    it("does nothing when the setting is off (the default)", async () => {
      useActivityStore.getState().applyEvent(makeEvent("a.md", "modified", 1));
      await vi.advanceTimersByTimeAsync(5000);
      expect(embedIndex).not.toHaveBeenCalled();
    });

    it("re-indexes incrementally (no prune) after the debounce when on", async () => {
      autoEmbedIndex = true;
      useActivityStore.getState().applyEvent(makeEvent("a.md", "modified", 1));
      expect(embedIndex).not.toHaveBeenCalled(); // still debouncing
      await vi.advanceTimersByTimeAsync(2500);
      expect(embedIndex).toHaveBeenCalledOnce();
      expect(embedIndex).toHaveBeenCalledWith(["/watch/a.md"], false);
    });

    it("coalesces a burst into one call", async () => {
      autoEmbedIndex = true;
      const a = useActivityStore.getState();
      a.applyEvent(makeEvent("a.md", "created", 1));
      a.applyEvent(makeEvent("b.md", "modified", 2));
      await vi.advanceTimersByTimeAsync(2500);
      expect(embedIndex).toHaveBeenCalledOnce();
      expect(vi.mocked(embedIndex).mock.calls[0][0].sort()).toEqual([
        "/watch/a.md",
        "/watch/b.md",
      ]);
    });

    it("drops a queued batch if the setting is turned off before it fires", async () => {
      autoEmbedIndex = true;
      useActivityStore.getState().applyEvent(makeEvent("a.md", "modified", 1));
      autoEmbedIndex = false;
      await vi.advanceTimersByTimeAsync(5000);
      expect(embedIndex).not.toHaveBeenCalled();
    });
  });

  it("multiple novel created events within the window coalesce into one toast", () => {
    useActivityStore.getState().applyEvent(makeEvent("a.md", "created", 1));
    useActivityStore.getState().applyEvent(makeEvent("b.md", "created", 2));
    useActivityStore.getState().applyEvent(makeEvent("c.md", "created", 3));
    vi.advanceTimersByTime(700);
    expect(toastInfoMock).toHaveBeenCalledOnce();
    expect(toastInfoMock.mock.calls[0][0]).toMatch(/3 new files/);
  });

  // ── clearWatch ──────────────────────────────────────────────────────────

  it("clearWatch resets all runtime state", () => {
    useActivityStore.setState({
      watchedDir: "/watch",
      files: [makeFile("a.md")],
      unseen: ["/watch/a.md"],
      lastError: "err",
    });
    useActivityStore.getState().clearWatch();
    const s = useActivityStore.getState();
    expect(s.watchedDir).toBeNull();
    expect(s.files).toHaveLength(0);
    expect(s.unseen).toHaveLength(0);
    expect(s.lastError).toBeNull();
  });

  // ── Folder switches (the vault list agents search) ──────────────────────

  it("loadFiles asks the backend for as many files as the store keeps", async () => {
    useActivityStore.setState({ watchedDir: "/watch" });
    listMock.mockResolvedValue([]);
    await useActivityStore.getState().loadFiles();
    expect(listMock).toHaveBeenCalledWith("/watch", 201);
  });

  it("loadFiles says when the folder has more files than the list keeps", async () => {
    useActivityStore.setState({ watchedDir: "/watch" });
    listMock.mockResolvedValue(
      Array.from({ length: 201 }, (_, i) => makeFile(`f${i}.md`, i)),
    );
    await useActivityStore.getState().loadFiles();
    expect(useActivityStore.getState().files).toHaveLength(200);
    expect(useActivityStore.getState().truncated).toBe(true);

    listMock.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => makeFile(`f${i}.md`, i)),
    );
    await useActivityStore.getState().loadFiles();
    expect(useActivityStore.getState().files).toHaveLength(200);
    expect(useActivityStore.getState().truncated).toBe(false);
  });

  it("loadFiles says when the folder was too large to walk in full", async () => {
    useActivityStore.setState({ watchedDir: "/watch" });
    // Fewer files than the cap, but the walk stopped before reading them all:
    // the list is not all of them, and not necessarily the newest.
    scanMock.mockResolvedValueOnce({ files: [makeFile("a.md")], scanCut: true });
    await useActivityStore.getState().loadFiles();
    expect(useActivityStore.getState().truncated).toBe(true);
    expect(useActivityStore.getState().scanCut).toBe(true);

    listMock.mockResolvedValue([makeFile("a.md")]);
    await useActivityStore.getState().loadFiles();
    expect(useActivityStore.getState().truncated).toBe(false);
    expect(useActivityStore.getState().scanCut).toBe(false);
  });

  it("loadFiles tells a walk cut by the depth limit from one cut by the entry budget", async () => {
    useActivityStore.setState({ watchedDir: "/watch" });
    scanMock.mockResolvedValueOnce({ files: [makeFile("a.md")], scanCut: true });
    await useActivityStore.getState().loadFiles();
    expect(useActivityStore.getState().scanCut).toBe(true);
    expect(useActivityStore.getState().depthCut).toBe(false);

    scanMock.mockResolvedValueOnce({
      files: [makeFile("a.md")],
      scanCut: true,
      depthCut: true,
    });
    await useActivityStore.getState().loadFiles();
    expect(useActivityStore.getState().truncated).toBe(true);
    expect(useActivityStore.getState().scanCut).toBe(true);
    expect(useActivityStore.getState().depthCut).toBe(true);

    // Switching folders forgets it.
    useActivityStore.getState().setWatchedDir("/other");
    expect(useActivityStore.getState().depthCut).toBe(false);
  });

  it("switching folders clears the old folder's files and badges", () => {
    useActivityStore.setState({
      watchedDir: "/old",
      files: [makeFile("a.md")],
      unseen: ["/watch/a.md"],
    });
    useActivityStore.getState().setWatchedDir("/new");
    const s = useActivityStore.getState();
    expect(s.files).toEqual([]);
    expect(s.unseen).toEqual([]);
    // Re-setting the same folder keeps its listing.
    useActivityStore.setState({ files: [makeFile("b.md")] });
    useActivityStore.getState().setWatchedDir("/new");
    expect(useActivityStore.getState().files).toHaveLength(1);
  });

  it("a listing that finishes after the folder changed is discarded", async () => {
    let resolveOld: (f: MdFileInfo[]) => void = () => {};
    listMock.mockImplementationOnce(
      () =>
        new Promise<MdFileInfo[]>((r) => {
          resolveOld = r;
        }),
    );
    useActivityStore.getState().setWatchedDir("/old");
    const pending = useActivityStore.getState().loadFiles();
    useActivityStore.getState().setWatchedDir("/new");
    resolveOld([makeFile("stale.md")]);
    await pending;
    expect(useActivityStore.getState().files).toEqual([]);

    // Nor does a failure of the old listing set an error on the new folder.
    listMock.mockRejectedValueOnce(new Error("gone"));
    useActivityStore.getState().setWatchedDir("/old2");
    const failing = useActivityStore.getState().loadFiles();
    useActivityStore.getState().setWatchedDir("/new2");
    await failing;
    expect(useActivityStore.getState().lastError).toBeNull();
  });
});
