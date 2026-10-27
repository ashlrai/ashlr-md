import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const recentAdd = vi.fn();
vi.mock("../store/recentStore", () => ({
  isMissingFileError: (e: unknown) => /\(os error 2\)/.test(String(e)),
  useRecentStore: { getState: () => ({ add: recentAdd, remove: vi.fn() }) },
}));

import { useDocumentStore } from "../store/documentStore";
import { useSessionStore } from "../store/sessionStore";
import {
  capRestoredTabs,
  MAX_RESTORED_TABS,
  openAtLaunch,
  restoreSession,
  sessionRestoreMessage,
} from "./session";

/** A disk of readable `files`; `unreadable` exist but fail to read. */
function disk(files: Record<string, string>, unreadable: string[] = []) {
  invokeMock.mockImplementation(
    (cmd: string, args?: { path?: string; paths?: string[] }) => {
      if (cmd === "filter_existing") {
        return Promise.resolve(
          (args?.paths ?? []).filter((p) => p in files || unreadable.includes(p)),
        );
      }
      if (cmd === "read_markdown_file") {
        const p = args?.path ?? "";
        if (!(p in files))
          return Promise.reject("Could not read: not valid UTF-8 text");
        return Promise.resolve({
          path: p,
          file_name: p.split("/").pop(),
          content: files[p],
          size: files[p].length,
          version: "v",
          canonical_path: p,
        });
      }
      return Promise.resolve();
    },
  );
}

describe("restoreSession", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    recentAdd.mockReset();
    useDocumentStore.setState({ tabs: [], activeId: null, path: null, error: null });
    useSessionStore.getState().clear();
  });

  it("skips a file it cannot open, without changing another tab", async () => {
    // The failed file's view mode was applied to the tab active before it,
    // it counted as reopened, and its error covered the restored document.
    disk({ "/v/a.md": "A" }, ["/v/bad.md"]);
    useSessionStore.getState().save(
      [
        { path: "/v/a.md", viewMode: "source" },
        { path: "/v/bad.md", viewMode: "edit" },
      ],
      "/v/a.md",
    );
    expect((await restoreSession()).opened).toBe(1);
    const s = useDocumentStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(["/v/a.md"]);
    expect(s.viewMode).toBe("source");
    expect(s.tabs[0].viewMode).toBe("source");
    expect(s.error).toBeNull();
  });

  it("reads a damaged session safely: bad entries dropped, unknown view modes read", async () => {
    disk({ "/v/a.md": "A", "/v/b.md": "B" });
    useSessionStore.setState({
      savedTabs: [
        { path: "/v/a.md", viewMode: "split" },
        null,
        { path: 7 },
        { path: "/v/a.md", viewMode: "edit" },
        { path: "/v/b.md", viewMode: "edit" },
      ] as never,
      activePath: 3 as never,
    });
    expect((await restoreSession()).opened).toBe(2);
    const s = useDocumentStore.getState();
    expect(s.tabs.map((t) => [t.path, t.viewMode])).toEqual([
      ["/v/a.md", "read"],
      ["/v/b.md", "edit"],
    ]);

    useSessionStore.setState({ savedTabs: { not: "a list" } as never });
    expect((await restoreSession()).opened).toBe(0);
  });

  it("reopens at most MAX_RESTORED_TABS, the active tab among them", async () => {
    const files: Record<string, string> = {};
    const saved = [];
    for (let i = 0; i < 30; i++) {
      files[`/v/${i}.md`] = String(i);
      saved.push({ path: `/v/${i}.md`, viewMode: "read" as const });
    }
    disk(files);
    useSessionStore.getState().save(saved, "/v/27.md");
    const r = await restoreSession();
    expect(r.opened).toBe(MAX_RESTORED_TABS);
    expect(r.capped).toBe(30 - MAX_RESTORED_TABS);
    const s = useDocumentStore.getState();
    expect(s.tabs).toHaveLength(MAX_RESTORED_TABS);
    expect(s.path).toBe("/v/27.md");
    expect(s.tabs[0].path).toBe("/v/0.md");
  });

  it("does not reorder Recents", async () => {
    disk({ "/v/a.md": "A", "/v/b.md": "B" });
    useSessionStore.getState().save(
      [
        { path: "/v/a.md", viewMode: "read" },
        { path: "/v/b.md", viewMode: "read" },
      ],
      "/v/a.md",
    );
    await restoreSession();
    expect(recentAdd).not.toHaveBeenCalled();
    // Opening a file as usual still puts it at the top.
    disk({ "/v/a.md": "A", "/v/b.md": "B", "/v/c.md": "C" });
    await useDocumentStore.getState().openPath("/v/c.md");
    expect(recentAdd).toHaveBeenCalledOnce();
  });

  it("names the files moved or deleted since", async () => {
    disk({ "/v/a.md": "A" });
    useSessionStore.getState().save(
      [
        { path: "/v/a.md", viewMode: "read" },
        { path: "/v/old/gone.md", viewMode: "read" },
      ],
      "/v/a.md",
    );
    const r = await restoreSession();
    expect(r).toEqual({ opened: 1, gone: ["gone.md"], capped: 0 });
    expect(sessionRestoreMessage(r)).toBe(
      'Reopened 1 document from your last session. "gone.md" was moved or deleted since, so it was not reopened.',
    );
  });

  it("keeps the session when the existence check fails", async () => {
    invokeMock.mockRejectedValue(new Error("ipc down"));
    useSessionStore.getState().save([{ path: "/v/a.md", viewMode: "read" }], "/v/a.md");
    expect(await restoreSession()).toEqual({ opened: 0, gone: [], capped: 0 });
    expect(useSessionStore.getState().savedTabs).toHaveLength(1);
  });
});

describe("openAtLaunch", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useDocumentStore.setState({ tabs: [], activeId: null, path: null, error: null });
    useSessionStore.getState().clear();
  });

  const openAll = async (paths: string[]) => {
    for (const p of paths) await useDocumentStore.getState().openPath(p);
  };

  it("reopens the saved tabs when the app is opened with a file, which stays active", async () => {
    // A launch with a file skipped the restore, and the first save then
    // replaced the saved tabs with that file alone.
    disk({ "/v/a.md": "A", "/v/b.md": "B", "/v/c.md": "C" });
    useSessionStore.getState().save(
      [
        { path: "/v/a.md", viewMode: "read" },
        { path: "/v/b.md", viewMode: "edit" },
      ],
      "/v/a.md",
    );
    const r = await openAtLaunch(["/v/c.md"], openAll);
    expect(r.opened).toBe(2);
    const s = useDocumentStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(["/v/a.md", "/v/b.md", "/v/c.md"]);
    expect(s.path).toBe("/v/c.md");
    expect(s.tabs[1].viewMode).toBe("edit");
  });

  it("does not open a launch file twice when it was in the session", async () => {
    disk({ "/v/a.md": "A", "/v/b.md": "B" });
    useSessionStore.getState().save(
      [
        { path: "/v/a.md", viewMode: "read" },
        { path: "/v/b.md", viewMode: "read" },
      ],
      "/v/b.md",
    );
    await openAtLaunch(["/v/a.md"], openAll);
    const s = useDocumentStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(["/v/a.md", "/v/b.md"]);
    expect(s.path).toBe("/v/a.md");
  });

  it("runs afterRestore between the saved tabs and the launch files", async () => {
    disk({ "/v/a.md": "A", "/v/c.md": "C" });
    useSessionStore.getState().save([{ path: "/v/a.md", viewMode: "read" }], "/v/a.md");
    const order: string[] = [];
    await openAtLaunch(
      ["/v/c.md"],
      async (paths) => {
        order.push(`open ${paths.join(",")}`);
        await openAll(paths);
      },
      async () => {
        order.push(`after restore: ${useDocumentStore.getState().path}`);
      },
    );
    expect(order).toEqual(["after restore: /v/a.md", "open /v/c.md"]);
    expect(useDocumentStore.getState().path).toBe("/v/c.md");
  });

  it("restores the session as before when the app is opened without a file", async () => {
    disk({ "/v/a.md": "A", "/v/b.md": "B" });
    useSessionStore.getState().save(
      [
        { path: "/v/a.md", viewMode: "read" },
        { path: "/v/b.md", viewMode: "read" },
      ],
      "/v/a.md",
    );
    const openFiles = vi.fn(openAll);
    await openAtLaunch([], openFiles);
    expect(openFiles).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().path).toBe("/v/a.md");
  });
});

describe("capRestoredTabs / sessionRestoreMessage", () => {
  const tabs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ path: `/${i}`, viewMode: "read" as const }));

  it("keeps the first tabs, swapping in the active one last", () => {
    expect(capRestoredTabs(tabs(3), "/2", 5)).toHaveLength(3);
    expect(capRestoredTabs(tabs(6), "/1", 3).map((t) => t.path)).toEqual([
      "/0",
      "/1",
      "/2",
    ]);
    expect(capRestoredTabs(tabs(6), "/5", 3).map((t) => t.path)).toEqual([
      "/0",
      "/1",
      "/5",
    ]);
  });

  it("says nothing for an empty restore, and lists at most three names", () => {
    expect(sessionRestoreMessage({ opened: 0, gone: [], capped: 0 })).toBeNull();
    const m = sessionRestoreMessage({
      opened: 2,
      gone: ["a", "b", "c", "d"],
      capped: 1,
    });
    expect(m).toContain("Reopened 2 documents");
    expect(m).toContain("1 more tab was left closed");
    expect(m).toContain('"a", "b", "c" and 1 more were moved or deleted since');
  });
});
