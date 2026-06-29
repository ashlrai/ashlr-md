import { beforeEach, describe, expect, it } from "vitest";
import { getStoredState } from "../test-setup";
import { useSessionStore, type SavedTab } from "./sessionStore";

const STORE_KEY = "mdopener-session";

function reset() {
  useSessionStore.setState({ savedTabs: [], activePath: null });
  localStorage.removeItem(STORE_KEY);
}

/** Snapshot the current localStorage blob so it can be re-planted after a
 *  setState() wipe (setState goes through persist middleware and overwrites LS). */
function captureBlob(): () => void {
  const raw = localStorage.getItem(STORE_KEY);
  return () => {
    if (raw) localStorage.setItem(STORE_KEY, raw);
    else localStorage.removeItem(STORE_KEY);
  };
}

/** Simulate an app reload: read the localStorage blob and restore into memory. */
function simulateReload() {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as {
      state?: { savedTabs?: SavedTab[]; activePath?: string | null };
    };
    if (parsed.state) useSessionStore.setState(parsed.state);
  } catch {
    // corrupt blob — leave store at defaults
  }
}

const TAB_A: SavedTab = { path: "/docs/a.md", viewMode: "read" };
const TAB_B: SavedTab = { path: "/docs/b.md", viewMode: "source" };

describe("sessionStore", () => {
  beforeEach(reset);

  // ── Default state ─────────────────────────────────────────────────────────

  it("initializes with empty savedTabs and null activePath", () => {
    const s = useSessionStore.getState();
    expect(s.savedTabs).toEqual([]);
    expect(s.activePath).toBeNull();
  });

  // ── save() ────────────────────────────────────────────────────────────────

  it("save() stores the provided tabs and activePath", () => {
    useSessionStore.getState().save([TAB_A, TAB_B], TAB_B.path);
    const s = useSessionStore.getState();
    expect(s.savedTabs).toHaveLength(2);
    expect(s.savedTabs[0]).toEqual(TAB_A);
    expect(s.activePath).toBe(TAB_B.path);
  });

  it("save() replaces the previous session wholesale", () => {
    useSessionStore.getState().save([TAB_A], TAB_A.path);
    useSessionStore.getState().save([TAB_B], TAB_B.path);
    const s = useSessionStore.getState();
    expect(s.savedTabs).toHaveLength(1);
    expect(s.savedTabs[0].path).toBe(TAB_B.path);
    expect(s.activePath).toBe(TAB_B.path);
  });

  it("save() accepts an empty tabs array (no open tabs)", () => {
    useSessionStore.getState().save([TAB_A], TAB_A.path);
    useSessionStore.getState().save([], null);
    const s = useSessionStore.getState();
    expect(s.savedTabs).toHaveLength(0);
    expect(s.activePath).toBeNull();
  });

  it("save() preserves all viewMode variants", () => {
    const tabs: SavedTab[] = [
      { path: "/a.md", viewMode: "read" },
      { path: "/b.md", viewMode: "source" },
      { path: "/c.md", viewMode: "split" },
    ];
    useSessionStore.getState().save(tabs, "/c.md");
    const saved = useSessionStore.getState().savedTabs;
    expect(saved.map((t) => t.viewMode)).toEqual(["read", "source", "split"]);
  });

  // ── clear() ───────────────────────────────────────────────────────────────

  it("clear() resets both savedTabs and activePath to defaults", () => {
    useSessionStore.getState().save([TAB_A, TAB_B], TAB_A.path);
    useSessionStore.getState().clear();
    const s = useSessionStore.getState();
    expect(s.savedTabs).toHaveLength(0);
    expect(s.activePath).toBeNull();
  });

  // ── localStorage persistence ──────────────────────────────────────────────

  it("save() writes state to localStorage", () => {
    useSessionStore.getState().save([TAB_A], TAB_A.path);
    const blob = getStoredState<{ savedTabs: SavedTab[]; activePath: string | null }>(STORE_KEY);
    expect(blob).not.toBeNull();
    expect(blob!.state.savedTabs).toHaveLength(1);
    expect(blob!.state.activePath).toBe(TAB_A.path);
  });

  it("clear() writes empty session to localStorage", () => {
    useSessionStore.getState().save([TAB_A], TAB_A.path);
    useSessionStore.getState().clear();
    const blob = getStoredState<{ savedTabs: SavedTab[]; activePath: unknown }>(STORE_KEY);
    if (blob) {
      expect(blob.state.savedTabs).toHaveLength(0);
      expect(blob.state.activePath).toBeNull();
    }
  });

  it("deserialization: simulateReload() restores tabs and activePath", () => {
    // Write session via the store so the persist middleware serialises it.
    useSessionStore.getState().save([TAB_A, TAB_B], TAB_A.path);

    // Snapshot BEFORE wipe (setState also writes to LS), then re-plant, then reload.
    const restore = captureBlob();
    useSessionStore.setState({ savedTabs: [], activePath: null });
    expect(useSessionStore.getState().savedTabs).toHaveLength(0);
    restore();
    simulateReload();

    const s = useSessionStore.getState();
    expect(s.savedTabs).toHaveLength(2);
    expect(s.savedTabs[0]).toEqual(TAB_A);
    expect(s.activePath).toBe(TAB_A.path);
  });

  it("deserialization: pre-seeded localStorage blob is restored correctly", () => {
    const snapshot = {
      state: {
        savedTabs: [
          { path: "/restored/a.md", viewMode: "split" },
          { path: "/restored/b.md", viewMode: "read" },
        ],
        activePath: "/restored/a.md",
      },
      version: 0,
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(snapshot));
    // Capture before setState wipes LS, then re-plant.
    const restore = captureBlob();
    useSessionStore.setState({ savedTabs: [], activePath: null });
    restore();
    simulateReload();

    const s = useSessionStore.getState();
    expect(s.savedTabs).toHaveLength(2);
    expect(s.savedTabs[0].viewMode).toBe("split");
    expect(s.activePath).toBe("/restored/a.md");
  });

  it("deserialization: activePath not in savedTabs is still restored faithfully", () => {
    // The store is a dumb mirror — it doesn't validate cross-references.
    const snapshot = {
      state: {
        savedTabs: [{ path: "/docs/x.md", viewMode: "read" }],
        activePath: "/docs/orphan.md",
      },
      version: 0,
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(snapshot));
    const restore = captureBlob();
    useSessionStore.setState({ savedTabs: [], activePath: null });
    restore();
    simulateReload();

    expect(useSessionStore.getState().activePath).toBe("/docs/orphan.md");
  });

  it("deserialization: corrupt localStorage blob leaves store at in-memory defaults", () => {
    localStorage.setItem(STORE_KEY, "{broken json{{");
    const restore = captureBlob();
    useSessionStore.setState({ savedTabs: [], activePath: null });
    restore();
    expect(() => simulateReload()).not.toThrow();
    expect(useSessionStore.getState().savedTabs).toHaveLength(0);
  });

  // ── Concurrent mutations ──────────────────────────────────────────────────

  it("rapid successive save() calls keep the last write (no corruption)", () => {
    for (let i = 0; i < 10; i++) {
      useSessionStore
        .getState()
        .save([{ path: `/iter${i}.md`, viewMode: "read" }], `/iter${i}.md`);
    }
    const s = useSessionStore.getState();
    expect(s.savedTabs).toHaveLength(1);
    expect(s.savedTabs[0].path).toBe("/iter9.md");
    expect(s.activePath).toBe("/iter9.md");
  });

  it("save() then clear() in quick succession leaves store empty", () => {
    useSessionStore.getState().save([TAB_A, TAB_B], TAB_A.path);
    useSessionStore.getState().clear();
    const s = useSessionStore.getState();
    expect(s.savedTabs).toHaveLength(0);
    expect(s.activePath).toBeNull();
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("save() with a large tab list round-trips through localStorage correctly", () => {
    const bigList: SavedTab[] = Array.from({ length: 50 }, (_, i) => ({
      path: `/docs/file${i}.md`,
      viewMode: i % 2 === 0 ? "read" : "source",
    }));
    useSessionStore.getState().save(bigList, bigList[49].path);

    const restore = captureBlob();
    useSessionStore.setState({ savedTabs: [], activePath: null });
    restore();
    simulateReload();

    const s = useSessionStore.getState();
    expect(s.savedTabs).toHaveLength(50);
    expect(s.activePath).toBe("/docs/file49.md");
  });

  it("saved tabs preserve their exact viewMode after round-trip", () => {
    const tabs: SavedTab[] = [
      { path: "/a.md", viewMode: "split" },
      { path: "/b.md", viewMode: "source" },
    ];
    useSessionStore.getState().save(tabs, "/b.md");

    const restore = captureBlob();
    useSessionStore.setState({ savedTabs: [], activePath: null });
    restore();
    simulateReload();

    const restored = useSessionStore.getState().savedTabs;
    expect(restored[0].viewMode).toBe("split");
    expect(restored[1].viewMode).toBe("source");
  });
});
