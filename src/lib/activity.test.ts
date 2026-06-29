/**
 * activity.test.ts — unit tests for the Tauri activity-watcher bridge.
 *
 * Covers:
 *   (1) watchDirectory() invokes the correct Tauri command
 *   (2) unwatchDirectory() invokes the correct Tauri command and clears watches
 *   (3) listMarkdownFiles() returns sorted MdFileInfo[] with correct shape
 *   (4) onActivityFile() / ACTIVITY_EVENT listener parses payloads and
 *       distinguishes created vs. modified events
 *   (5) Error handling when the watched directory is deleted or inaccessible
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock @tauri-apps/api/core (invoke) ────────────────────────────────────────
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// ── Mock @tauri-apps/api/event (listen) ───────────────────────────────────────
// listenMock captures (eventName, handler) pairs; simulateEvent drives handlers.
type Handler = (e: { payload: unknown }) => void;
const registeredHandlers: Map<string, Handler[]> = new Map();
const listenMock = vi.fn(
  (eventName: string, handler: Handler): Promise<() => void> => {
    if (!registeredHandlers.has(eventName)) {
      registeredHandlers.set(eventName, []);
    }
    registeredHandlers.get(eventName)!.push(handler);
    // Return an unlisten function that removes only this handler.
    return Promise.resolve(() => {
      const list = registeredHandlers.get(eventName) ?? [];
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
    });
  },
);

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: Parameters<typeof listenMock>) => listenMock(...args),
}));

/** Fire all registered handlers for `eventName` with the given payload. */
function simulateEvent(eventName: string, payload: unknown): void {
  const handlers = registeredHandlers.get(eventName) ?? [];
  for (const h of handlers) h({ payload });
}

// Import module under test AFTER mocks are registered.
import {
  ACTIVITY_EVENT,
  listMarkdownFiles,
  onActivityFile,
  unwatchDirectory,
  watchDirectory,
} from "./activity";
import type { ActivityEvent, MdFileInfo } from "./activity";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(
  name: string,
  overrides: Partial<MdFileInfo> = {},
): MdFileInfo {
  return {
    path: `/vault/${name}`,
    name,
    dir: "/vault",
    mtimeMs: Date.now(),
    size: 512,
    ...overrides,
  };
}

function makeActivityEvent(
  name: string,
  kind: ActivityEvent["kind"] = "modified",
  overrides: Partial<MdFileInfo> = {},
): ActivityEvent {
  return { ...makeFile(name, overrides), kind };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  registeredHandlers.clear();
  // Re-install the default listen implementation after mockReset clears it.
  listenMock.mockImplementation(
    (eventName: string, handler: Handler): Promise<() => void> => {
      if (!registeredHandlers.has(eventName)) {
        registeredHandlers.set(eventName, []);
      }
      registeredHandlers.get(eventName)!.push(handler);
      return Promise.resolve(() => {
        const list = registeredHandlers.get(eventName) ?? [];
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      });
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
  registeredHandlers.clear();
});

// ── (1) watchDirectory ────────────────────────────────────────────────────────

describe("watchDirectory", () => {
  it("invokes the 'watch_directory' Tauri command with the given path", async () => {
    invokeMock.mockResolvedValue(undefined);
    await watchDirectory("/home/user/notes");
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("watch_directory", {
      path: "/home/user/notes",
    });
  });

  it("passes the path verbatim (no normalisation)", async () => {
    invokeMock.mockResolvedValue(undefined);
    await watchDirectory("/vault/projects/2024 Q1");
    expect(invokeMock).toHaveBeenCalledWith("watch_directory", {
      path: "/vault/projects/2024 Q1",
    });
  });

  it("returns void (the resolved value is ignored)", async () => {
    invokeMock.mockResolvedValue(undefined);
    const result = await watchDirectory("/notes");
    expect(result).toBeUndefined();
  });

  it("propagates rejection from invoke to the caller", async () => {
    invokeMock.mockRejectedValue(new Error("permission denied"));
    await expect(watchDirectory("/protected")).rejects.toThrow(
      "permission denied",
    );
  });

  it("each call uses the latest path (replaces prior watch on the backend)", async () => {
    invokeMock.mockResolvedValue(undefined);
    await watchDirectory("/old/path");
    await watchDirectory("/new/path");
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[1][1]).toEqual({ path: "/new/path" });
  });
});

// ── (2) unwatchDirectory ─────────────────────────────────────────────────────

describe("unwatchDirectory", () => {
  it("invokes the 'unwatch_directory' Tauri command with no arguments", async () => {
    invokeMock.mockResolvedValue(undefined);
    await unwatchDirectory();
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("unwatch_directory");
  });

  it("returns void", async () => {
    invokeMock.mockResolvedValue(undefined);
    const result = await unwatchDirectory();
    expect(result).toBeUndefined();
  });

  it("does not pass any extra arguments to the backend command", async () => {
    invokeMock.mockResolvedValue(undefined);
    await unwatchDirectory();
    // Ensure only the command name is in the call — no second argument.
    expect(invokeMock.mock.calls[0]).toHaveLength(1);
  });

  it("watch then unwatch — separate commands in the correct order", async () => {
    invokeMock.mockResolvedValue(undefined);
    await watchDirectory("/vault");
    await unwatchDirectory();
    expect(invokeMock.mock.calls[0][0]).toBe("watch_directory");
    expect(invokeMock.mock.calls[1][0]).toBe("unwatch_directory");
  });

  it("propagates rejection from invoke to the caller", async () => {
    invokeMock.mockRejectedValue(new Error("no active watch"));
    await expect(unwatchDirectory()).rejects.toThrow("no active watch");
  });
});

// ── (3) listMarkdownFiles ─────────────────────────────────────────────────────

describe("listMarkdownFiles", () => {
  it("invokes 'list_markdown_files' with the given path and no limit", async () => {
    invokeMock.mockResolvedValue([]);
    await listMarkdownFiles("/vault");
    expect(invokeMock).toHaveBeenCalledWith("list_markdown_files", {
      path: "/vault",
      limit: undefined,
    });
  });

  it("invokes 'list_markdown_files' with the given path and limit", async () => {
    invokeMock.mockResolvedValue([]);
    await listMarkdownFiles("/vault", 50);
    expect(invokeMock).toHaveBeenCalledWith("list_markdown_files", {
      path: "/vault",
      limit: 50,
    });
  });

  it("returns the MdFileInfo[] from the backend unchanged", async () => {
    const files: MdFileInfo[] = [
      makeFile("PLAN.md", { mtimeMs: 3000 }),
      makeFile("SPEC.md", { mtimeMs: 2000 }),
      makeFile("README.md", { mtimeMs: 1000 }),
    ];
    invokeMock.mockResolvedValue(files);
    const result = await listMarkdownFiles("/vault");
    expect(result).toEqual(files);
  });

  it("each returned item has the required MdFileInfo shape fields", async () => {
    const file: MdFileInfo = {
      path: "/vault/notes.md",
      name: "notes.md",
      dir: "/vault",
      mtimeMs: 1_700_000_000_000,
      size: 1024,
    };
    invokeMock.mockResolvedValue([file]);
    const [item] = await listMarkdownFiles("/vault");
    expect(item).toHaveProperty("path", "/vault/notes.md");
    expect(item).toHaveProperty("name", "notes.md");
    expect(item).toHaveProperty("dir", "/vault");
    expect(item).toHaveProperty("mtimeMs", 1_700_000_000_000);
    expect(item).toHaveProperty("size", 1024);
  });

  it("returns an empty array when the directory has no markdown files", async () => {
    invokeMock.mockResolvedValue([]);
    const result = await listMarkdownFiles("/empty/dir");
    expect(result).toEqual([]);
  });

  it("backend returns files newest-first — the bridge preserves that order", async () => {
    // Backend is responsible for sorting; bridge must not reorder.
    const files: MdFileInfo[] = [
      makeFile("newest.md", { mtimeMs: 3000 }),
      makeFile("middle.md", { mtimeMs: 2000 }),
      makeFile("oldest.md", { mtimeMs: 1000 }),
    ];
    invokeMock.mockResolvedValue(files);
    const result = await listMarkdownFiles("/vault");
    expect(result.map((f) => f.name)).toEqual([
      "newest.md",
      "middle.md",
      "oldest.md",
    ]);
  });

  it("path and dir fields are absolute strings", async () => {
    const file = makeFile("doc.md", {
      path: "/absolute/path/doc.md",
      dir: "/absolute/path",
    });
    invokeMock.mockResolvedValue([file]);
    const [item] = await listMarkdownFiles("/absolute/path");
    expect(item.path).toMatch(/^\//);
    expect(item.dir).toMatch(/^\//);
  });

  it("size is a non-negative number", async () => {
    const file = makeFile("empty.md", { size: 0 });
    invokeMock.mockResolvedValue([file]);
    const [item] = await listMarkdownFiles("/vault");
    expect(item.size).toBeGreaterThanOrEqual(0);
  });

  it("mtimeMs is a positive epoch timestamp (> year 2000)", async () => {
    const file = makeFile("recent.md", { mtimeMs: 1_000_000_000_000 });
    invokeMock.mockResolvedValue([file]);
    const [item] = await listMarkdownFiles("/vault");
    // 2001-09-09 in epoch ms
    expect(item.mtimeMs).toBeGreaterThan(1_000_000_000_000 - 1);
  });

  it("propagates rejection from invoke to the caller", async () => {
    invokeMock.mockRejectedValue(new Error("directory not found"));
    await expect(listMarkdownFiles("/nonexistent")).rejects.toThrow(
      "directory not found",
    );
  });
});

// ── (4) onActivityFile / ACTIVITY_EVENT ──────────────────────────────────────

describe("ACTIVITY_EVENT constant", () => {
  it("is the string 'activity://file'", () => {
    expect(ACTIVITY_EVENT).toBe("activity://file");
  });
});

describe("onActivityFile", () => {
  it("calls listen with ACTIVITY_EVENT as the event name", async () => {
    await onActivityFile(() => {});
    expect(listenMock).toHaveBeenCalledOnce();
    expect(listenMock.mock.calls[0][0]).toBe(ACTIVITY_EVENT);
  });

  it("returns an unlisten function (callable without throwing)", async () => {
    const unlisten = await onActivityFile(() => {});
    expect(typeof unlisten).toBe("function");
    expect(() => unlisten()).not.toThrow();
  });

  it("invokes the callback with the event payload when an event fires", async () => {
    const received: ActivityEvent[] = [];
    await onActivityFile((ev) => received.push(ev));

    const payload = makeActivityEvent("PLAN.md", "created");
    simulateEvent(ACTIVITY_EVENT, payload);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);
  });

  it("distinguishes 'created' kind from 'modified' kind", async () => {
    const received: ActivityEvent[] = [];
    await onActivityFile((ev) => received.push(ev));

    simulateEvent(ACTIVITY_EVENT, makeActivityEvent("new.md", "created"));
    simulateEvent(ACTIVITY_EVENT, makeActivityEvent("existing.md", "modified"));

    expect(received[0].kind).toBe("created");
    expect(received[1].kind).toBe("modified");
  });

  it("a 'created' event carries name, path, dir, mtimeMs, size", async () => {
    const received: ActivityEvent[] = [];
    await onActivityFile((ev) => received.push(ev));

    const payload: ActivityEvent = {
      path: "/vault/agent/RESULT.md",
      name: "RESULT.md",
      dir: "/vault/agent",
      mtimeMs: 1_700_000_000_123,
      size: 2048,
      kind: "created",
    };
    simulateEvent(ACTIVITY_EVENT, payload);

    expect(received[0]).toMatchObject({
      path: "/vault/agent/RESULT.md",
      name: "RESULT.md",
      dir: "/vault/agent",
      mtimeMs: 1_700_000_000_123,
      size: 2048,
      kind: "created",
    });
  });

  it("a 'modified' event carries name, path, dir, mtimeMs, size", async () => {
    const received: ActivityEvent[] = [];
    await onActivityFile((ev) => received.push(ev));

    const payload: ActivityEvent = {
      path: "/vault/PLAN.md",
      name: "PLAN.md",
      dir: "/vault",
      mtimeMs: 1_700_000_001_000,
      size: 512,
      kind: "modified",
    };
    simulateEvent(ACTIVITY_EVENT, payload);

    expect(received[0].kind).toBe("modified");
    expect(received[0].name).toBe("PLAN.md");
  });

  it("multiple simultaneous subscribers each receive the event", async () => {
    const a: ActivityEvent[] = [];
    const b: ActivityEvent[] = [];
    await onActivityFile((ev) => a.push(ev));
    await onActivityFile((ev) => b.push(ev));

    simulateEvent(ACTIVITY_EVENT, makeActivityEvent("shared.md", "created"));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("calling unlisten removes only that subscriber", async () => {
    const a: ActivityEvent[] = [];
    const b: ActivityEvent[] = [];
    const unlistenA = await onActivityFile((ev) => a.push(ev));
    await onActivityFile((ev) => b.push(ev));

    unlistenA();
    simulateEvent(ACTIVITY_EVENT, makeActivityEvent("after-unlisten.md", "modified"));

    expect(a).toHaveLength(0); // unlistened
    expect(b).toHaveLength(1); // still active
  });

  it("rapid successive events are all delivered to the callback", async () => {
    const received: ActivityEvent[] = [];
    await onActivityFile((ev) => received.push(ev));

    for (let i = 0; i < 10; i++) {
      simulateEvent(ACTIVITY_EVENT, makeActivityEvent(`file-${i}.md`, "created"));
    }

    expect(received).toHaveLength(10);
  });

  it("new .md files written by an agent appear as 'created' events", async () => {
    const agentFiles: string[] = [];
    await onActivityFile((ev) => {
      if (ev.kind === "created") agentFiles.push(ev.name);
    });

    // Simulate an agent writing three new files in quick succession.
    simulateEvent(ACTIVITY_EVENT, makeActivityEvent("PLAN.md", "created"));
    simulateEvent(ACTIVITY_EVENT, makeActivityEvent("SPEC.md", "created"));
    simulateEvent(ACTIVITY_EVENT, makeActivityEvent("RESULT.md", "created"));

    expect(agentFiles).toEqual(["PLAN.md", "SPEC.md", "RESULT.md"]);
  });
});

// ── (5) Error handling — deleted / inaccessible directory ────────────────────

describe("error handling — deleted or inaccessible directory", () => {
  it("watchDirectory rejects when the path does not exist", async () => {
    invokeMock.mockRejectedValue(new Error("No such file or directory"));
    await expect(watchDirectory("/nonexistent/path")).rejects.toThrow(
      "No such file or directory",
    );
  });

  it("watchDirectory rejects with a permission error on a protected path", async () => {
    invokeMock.mockRejectedValue(new Error("Operation not permitted"));
    await expect(watchDirectory("/root/secrets")).rejects.toThrow(
      "Operation not permitted",
    );
  });

  it("listMarkdownFiles rejects when the directory is deleted mid-watch", async () => {
    // First call succeeds; second call fails (directory was deleted).
    invokeMock
      .mockResolvedValueOnce([makeFile("a.md")])
      .mockRejectedValueOnce(new Error("directory was removed"));

    const first = await listMarkdownFiles("/vault");
    expect(first).toHaveLength(1);

    await expect(listMarkdownFiles("/vault")).rejects.toThrow(
      "directory was removed",
    );
  });

  it("listMarkdownFiles rejects when the path becomes inaccessible (EPERM)", async () => {
    invokeMock.mockRejectedValue(new Error("EPERM: operation not permitted"));
    await expect(listMarkdownFiles("/protected/dir")).rejects.toThrow("EPERM");
  });

  it("unwatchDirectory rejects when there is no active watch to clear", async () => {
    invokeMock.mockRejectedValue(new Error("no active watcher"));
    await expect(unwatchDirectory()).rejects.toThrow("no active watcher");
  });

  it("errors from invoke do not leave stale listeners behind", async () => {
    // Arrange: a subscriber is active.
    const received: ActivityEvent[] = [];
    const unlisten = await onActivityFile((ev) => received.push(ev));

    // A watch error occurs on the backend.
    invokeMock.mockRejectedValue(new Error("watcher crashed"));
    await expect(watchDirectory("/vault")).rejects.toThrow("watcher crashed");

    // The listener is still registered and can be cleaned up explicitly.
    unlisten();

    // No events after unlisten.
    simulateEvent(ACTIVITY_EVENT, makeActivityEvent("ghost.md", "created"));
    expect(received).toHaveLength(0);
  });

  it("listMarkdownFiles rejects when the backend returns an I/O error string", async () => {
    invokeMock.mockRejectedValue("IO error: broken pipe");
    await expect(listMarkdownFiles("/vault")).rejects.toBe(
      "IO error: broken pipe",
    );
  });

  it("watchDirectory called after an error can succeed on retry", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce(undefined);

    await expect(watchDirectory("/vault")).rejects.toThrow("ENOENT");
    await expect(watchDirectory("/vault")).resolves.toBeUndefined();
  });
});
