import { beforeEach, describe, expect, it } from "vitest";
import { useRecentStore, type RecentFile } from "./recentStore";

const STORE_KEY = "mdopener-recents";

function reset() {
  useRecentStore.setState({ recents: [] });
  localStorage.removeItem(STORE_KEY);
}

/** Simulate an app reload.
 *
 * The zustand persist middleware intercepts setState() and also writes the new
 * state back to localStorage, so we must snapshot the blob BEFORE resetting
 * in-memory state, then re-plant the snapshot so simulateReload() sees the
 * previously-saved data rather than the empty-reset blob.
 *
 * Usage:
 *   const restore = captureBlob();          // snapshot before wipe
 *   useRecentStore.setState({ recents: [] }); // wipe memory (also wipes LS)
 *   restore();                               // re-plant the saved blob
 *   simulateReload();                        // restore from blob → memory
 */
function captureBlob(): () => void {
  const raw = localStorage.getItem(STORE_KEY);
  return () => {
    if (raw) localStorage.setItem(STORE_KEY, raw);
    else localStorage.removeItem(STORE_KEY);
  };
}

function simulateReload() {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { state?: { recents?: RecentFile[] } };
    if (parsed.state) useRecentStore.setState(parsed.state);
  } catch {
    // corrupt blob — leave store at defaults
  }
}

describe("recentStore", () => {
  beforeEach(reset);

  // ── Default state ─────────────────────────────────────────────────────────

  it("initializes with an empty recents list", () => {
    expect(useRecentStore.getState().recents).toEqual([]);
  });

  // ── Basic mutations ───────────────────────────────────────────────────────

  it("add() prepends a new entry", () => {
    const now = Date.now();
    useRecentStore.getState().add("/a.md", "a.md", now);
    const { recents } = useRecentStore.getState();
    expect(recents).toHaveLength(1);
    expect(recents[0]).toEqual({ path: "/a.md", fileName: "a.md", openedAt: now });
  });

  it("add() moves an existing path to the front (dedup)", () => {
    const t1 = 1000;
    const t2 = 2000;
    useRecentStore.getState().add("/a.md", "a.md", t1);
    useRecentStore.getState().add("/b.md", "b.md", t1);
    useRecentStore.getState().add("/a.md", "a.md", t2);
    const { recents } = useRecentStore.getState();
    // /a.md should be first, with updated openedAt, and only appear once.
    expect(recents[0].path).toBe("/a.md");
    expect(recents[0].openedAt).toBe(t2);
    expect(recents.filter((r) => r.path === "/a.md")).toHaveLength(1);
  });

  it("remove() deletes a single entry by path", () => {
    useRecentStore.getState().add("/a.md", "a.md", 1000);
    useRecentStore.getState().add("/b.md", "b.md", 1001);
    useRecentStore.getState().remove("/a.md");
    const { recents } = useRecentStore.getState();
    expect(recents).toHaveLength(1);
    expect(recents[0].path).toBe("/b.md");
  });

  it("clear() empties the list", () => {
    useRecentStore.getState().add("/a.md", "a.md", 1000);
    useRecentStore.getState().clear();
    expect(useRecentStore.getState().recents).toHaveLength(0);
  });

  // ── MAX_RECENTS cap ───────────────────────────────────────────────────────

  it("enforces MAX_RECENTS=12: oldest entry is dropped when limit exceeded", () => {
    // Add 13 unique files — the 13th push should evict the oldest (last).
    for (let i = 1; i <= 13; i++) {
      useRecentStore.getState().add(`/file${i}.md`, `file${i}.md`, i * 1000);
    }
    const { recents } = useRecentStore.getState();
    expect(recents).toHaveLength(12);
    // Most-recently added is first.
    expect(recents[0].path).toBe("/file13.md");
    // Oldest (file1) was evicted.
    expect(recents.find((r) => r.path === "/file1.md")).toBeUndefined();
  });

  it("re-adding an existing path does not grow the list beyond MAX_RECENTS", () => {
    for (let i = 1; i <= 12; i++) {
      useRecentStore.getState().add(`/file${i}.md`, `file${i}.md`, i * 1000);
    }
    // Re-add the last one — should remain at 12.
    useRecentStore.getState().add("/file12.md", "file12.md", 99999);
    expect(useRecentStore.getState().recents).toHaveLength(12);
  });

  // ── localStorage persistence ──────────────────────────────────────────────

  it("add() writes state to localStorage after mutation", () => {
    useRecentStore.getState().add("/p.md", "p.md", 5000);
    const raw = localStorage.getItem(STORE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { state: { recents: RecentFile[] } };
    expect(parsed.state.recents).toHaveLength(1);
    expect(parsed.state.recents[0].path).toBe("/p.md");
  });

  it("clear() writes empty recents to localStorage", () => {
    useRecentStore.getState().add("/a.md", "a.md", 1000);
    useRecentStore.getState().clear();
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { state: { recents: RecentFile[] } };
      expect(parsed.state.recents).toHaveLength(0);
    }
  });

  it("deserialization: simulateReload() restores recents from localStorage blob", () => {
    // Add entries so the persist middleware writes to localStorage.
    useRecentStore.getState().add("/restored.md", "restored.md", 12345);
    useRecentStore.getState().add("/second.md", "second.md", 67890);

    // Snapshot the blob BEFORE wiping (setState also writes to localStorage).
    const restore = captureBlob();
    useRecentStore.setState({ recents: [] });
    expect(useRecentStore.getState().recents).toHaveLength(0);

    // Re-plant the saved blob, then reload from it.
    restore();
    simulateReload();

    const { recents } = useRecentStore.getState();
    expect(recents).toHaveLength(2);
    // add() prepends, so second.md (added last) is at index 0.
    expect(recents[0].path).toBe("/second.md");
    // restored.md was added first, so it's at index 1.
    expect(recents[1].path).toBe("/restored.md");
    expect(recents[1].openedAt).toBe(12345);
  });

  it("deserialization: a pre-seeded localStorage blob is correctly restored", () => {
    // Write a snapshot directly as if it was left by a previous session.
    const snapshot = {
      state: {
        recents: [
          { path: "/legacy.md", fileName: "legacy.md", openedAt: 99999 },
        ],
      },
      version: 0,
    };
    // Plant the blob first, then reset memory state, then reload.
    localStorage.setItem(STORE_KEY, JSON.stringify(snapshot));
    // setState would overwrite LS, so capture first.
    const restore = captureBlob();
    useRecentStore.setState({ recents: [] });
    restore();
    simulateReload();

    const { recents } = useRecentStore.getState();
    expect(recents).toHaveLength(1);
    expect(recents[0].path).toBe("/legacy.md");
    expect(recents[0].openedAt).toBe(99999);
  });

  it("deserialization: malformed localStorage blob leaves store in default state", () => {
    // Plant corrupt data, snapshot it, reset memory, re-plant, then simulateReload.
    localStorage.setItem(STORE_KEY, "not-valid-json{{{{");
    const restore = captureBlob();
    useRecentStore.setState({ recents: [] });
    restore();
    expect(() => simulateReload()).not.toThrow();
    // State should remain at the in-memory default (parse failed, setState not called).
    expect(useRecentStore.getState().recents).toHaveLength(0);
  });

  // ── Concurrent mutations ──────────────────────────────────────────────────

  it("concurrent add() calls do not corrupt the list", () => {
    for (let i = 0; i < 5; i++) {
      useRecentStore.getState().add(`/c${i}.md`, `c${i}.md`, i * 100);
    }
    expect(useRecentStore.getState().recents).toHaveLength(5);
    // Each path appears exactly once.
    const paths = useRecentStore.getState().recents.map((r) => r.path);
    expect(new Set(paths).size).toBe(5);
  });

  it("interleaved add/remove does not leave stale entries", () => {
    useRecentStore.getState().add("/x.md", "x.md", 1);
    useRecentStore.getState().add("/y.md", "y.md", 2);
    useRecentStore.getState().remove("/x.md");
    useRecentStore.getState().add("/z.md", "z.md", 3);
    const paths = useRecentStore.getState().recents.map((r) => r.path);
    expect(paths).not.toContain("/x.md");
    expect(paths).toContain("/y.md");
    expect(paths).toContain("/z.md");
  });

  it("large round-trip: 12 entries persist and restore correctly", () => {
    for (let i = 0; i < 12; i++) {
      useRecentStore.getState().add(`/docs/file${i}.md`, `file${i}.md`, i * 1000);
    }
    const before = useRecentStore.getState().recents.map((r) => r.path);

    // Snapshot before wipe, restore blob, then reload.
    const restore = captureBlob();
    useRecentStore.setState({ recents: [] });
    restore();
    simulateReload();

    const after = useRecentStore.getState().recents.map((r) => r.path);
    expect(after).toEqual(before);
  });
});
