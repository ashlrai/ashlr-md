import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────
// Replace all external I/O so the store runs in happy-dom without Tauri/FS.

vi.mock("../lib/activity", () => ({
  listMarkdownFiles: vi.fn(),
  ACTIVITY_EVENT: "activity://file",
}));

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

vi.mock("./settingsStore", () => ({
  useSettingsStore: { getState: () => ({ notificationsEnabled: false }) },
}));

vi.mock("./uiStore", () => ({
  useUiStore: { getState: () => ({ activityOpen: false, openActivity: vi.fn() }) },
}));

import { listMarkdownFiles } from "../lib/activity";
import type { ActivityEvent, MdFileInfo } from "../lib/activity";
import { useActivityStore } from "./activityStore";

const listMock = listMarkdownFiles as ReturnType<typeof vi.fn>;

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
    const existing = Array.from({ length: 200 }, (_, i) =>
      makeFile(`file-${i}.md`, i),
    );
    useActivityStore.setState({ files: existing });
    useActivityStore.getState().applyEvent(makeEvent("new.md", "created"));
    expect(useActivityStore.getState().files).toHaveLength(200);
    expect(useActivityStore.getState().files[0].name).toBe("new.md");
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
});
