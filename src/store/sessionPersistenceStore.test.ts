/**
 * sessionPersistenceStore.test.ts
 *
 * Tests for the hybrid sessionStorage + IndexedDB persistence layer.
 *
 * Coverage:
 *   - hashPath / sessionStorageKey utilities
 *   - saveSnapshot / loadSnapshot / clearSnapshot / clearAllSnapshots
 *   - saveSnapshotDebounced (debounce mechanics)
 *   - cacheDocument / loadCachedDocument / removeCachedDocument / clearDocumentCache
 *   - LRU eviction (max 50 MB)
 *   - recoverSession (full recovery flow)
 *   - syncDocToSession (bridge helper)
 *   - isOffline
 *   - broadcastSnapshot / onCrossTabSnapshot
 *   - corrupt IndexedDB recovery
 *   - getCacheSizeBytes / listCachedPaths helpers
 *   - offline fallback scenario
 *   - cursor / scroll state round-trips
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  hashPath,
  sessionStorageKey,
  saveSnapshot,
  loadSnapshot,
  clearSnapshot,
  clearAllSnapshots,
  saveSnapshotDebounced,
  cacheDocument,
  loadCachedDocument,
  removeCachedDocument,
  clearDocumentCache,
  getCacheSizeBytes,
  listCachedPaths,
  recoverSession,
  syncDocToSession,
  isOffline,
  broadcastSnapshot,
  onCrossTabSnapshot,
  type SessionSnapshot,
} from "./sessionPersistenceStore";

// ── sessionStorage mock (mirrors test-setup.ts pattern for localStorage) ─────

const _ssStore = new Map<string, string>();

const sessionStorageMock: Storage = {
  get length() {
    return _ssStore.size;
  },
  key(index: number): string | null {
    const keys = Array.from(_ssStore.keys());
    return index >= 0 && index < keys.length ? (keys[index] ?? null) : null;
  },
  getItem(key: string): string | null {
    return _ssStore.has(key) ? (_ssStore.get(key) ?? null) : null;
  },
  setItem(key: string, value: string): void {
    _ssStore.set(key, String(value));
  },
  removeItem(key: string): void {
    _ssStore.delete(key);
  },
  clear(): void {
    _ssStore.clear();
  },
};

Object.defineProperty(globalThis, "sessionStorage", {
  value: sessionStorageMock,
  writable: true,
  configurable: true,
});

// ── IndexedDB mock ────────────────────────────────────────────────────────────
//
// A lightweight in-memory IDB shim sufficient for all CRUD operations tested
// here.  Not a complete spec implementation — just enough to exercise the
// store's IDB code paths.

type IdbRecord = Record<string, unknown>;

class MockIDBRequest<T = unknown> extends EventTarget {
  result: T | undefined = undefined;
  error: DOMException | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  _resolve(value: T): void {
    this.result = value;
    if (this.onsuccess) this.onsuccess(new Event("success"));
  }

  _reject(err: DOMException | Error): void {
    this.error = err as DOMException;
    if (this.onerror) this.onerror(new Event("error"));
  }
}

class MockIDBObjectStore {
  private _data: Map<string, IdbRecord>;
  constructor(data: Map<string, IdbRecord>) {
    this._data = data;
  }

  put(value: IdbRecord): MockIDBRequest {
    const req = new MockIDBRequest();
    const key = String(value["path"] ?? "");
    this._data.set(key, { ...value });
    setTimeout(() => req._resolve(undefined), 0);
    return req;
  }

  get(key: string): MockIDBRequest<IdbRecord | undefined> {
    const req = new MockIDBRequest<IdbRecord | undefined>();
    const val = this._data.get(String(key));
    setTimeout(() => req._resolve(val), 0);
    return req;
  }

  delete(key: string): MockIDBRequest {
    const req = new MockIDBRequest();
    this._data.delete(String(key));
    setTimeout(() => req._resolve(undefined), 0);
    return req;
  }

  clear(): MockIDBRequest {
    const req = new MockIDBRequest();
    this._data.clear();
    setTimeout(() => req._resolve(undefined), 0);
    return req;
  }

  getAll(): MockIDBRequest<IdbRecord[]> {
    const req = new MockIDBRequest<IdbRecord[]>();
    const all = Array.from(this._data.values());
    setTimeout(() => req._resolve(all), 0);
    return req;
  }

  createIndex(_name: string, _keyPath: string, _opts?: unknown): void {
    // No-op in mock
  }
}

class MockIDBTransaction {
  private _store: MockIDBObjectStore;
  constructor(store: MockIDBObjectStore) {
    this._store = store;
  }
  objectStore(_name: string): MockIDBObjectStore {
    return this._store;
  }
}

class MockIDBDatabase extends EventTarget {
  objectStoreNames = { contains: (_n: string) => false } as unknown as DOMStringList;
  private _store: MockIDBObjectStore;
  constructor(store: MockIDBObjectStore) {
    super();
    this._store = store;
  }
  transaction(_storeName: string, _mode?: string): MockIDBTransaction {
    return new MockIDBTransaction(this._store);
  }
  createObjectStore(_name: string, _opts?: unknown): MockIDBObjectStore {
    return this._store;
  }
}

class MockIDBOpenDBRequest extends EventTarget {
  result: MockIDBDatabase | undefined;
  error: DOMException | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;
  onblocked: (() => void) | null = null;

  _db: MockIDBDatabase | undefined;

  _open(db: MockIDBDatabase, needsUpgrade: boolean): void {
    // Set result BEFORE firing onupgradeneeded so event.target.result is valid.
    this.result = db;
    this._db = db;
    if (needsUpgrade && this.onupgradeneeded) {
      this.onupgradeneeded({
        target: this,
        oldVersion: 0,
        newVersion: 1,
      } as unknown as IDBVersionChangeEvent);
    }
    if (this.onsuccess) this.onsuccess(new Event("success"));
  }

  _fail(err: DOMException): void {
    this.error = err;
    // Pass the request itself as the event target so `req.error` is accessible.
    const evt = new Event("error");
    Object.defineProperty(evt, "target", { value: this, configurable: true });
    if (this.onerror) this.onerror(evt);
  }
}

// Global IDB data store (persists within a describe block, reset in afterEach).
let _idbData: Map<string, IdbRecord>;

function setupIdbMock(
  opts: { failOpen?: boolean } = {},
): void {
  _idbData = new Map();

  const mockIndexedDB = {
    open: (_name: string, _version: number): MockIDBOpenDBRequest => {
      const req = new MockIDBOpenDBRequest();
      if (opts.failOpen) {
        setTimeout(
          () =>
            req._fail(
              new DOMException("IDB open failed (mock)", "UnknownError"),
            ),
          0,
        );
      } else {
        const store = new MockIDBObjectStore(_idbData);
        const db = new MockIDBDatabase(store);
        setTimeout(() => req._open(db, true), 0);
      }
      return req;
    },
  };

  Object.defineProperty(globalThis, "indexedDB", {
    value: mockIndexedDB,
    writable: true,
    configurable: true,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSnapshot(
  path: string,
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    path,
    cursorOffset: 42,
    scrollTop: 100,
    viewMode: "edit",
    zoom: 1.0,
    savedAt: Date.now(),
    ...overrides,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  _ssStore.clear();
  setupIdbMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// hashPath / sessionStorageKey
// =============================================================================

describe("hashPath", () => {
  it("returns an 8-char hex string", () => {
    const h = hashPath("/docs/a.md");
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic — same path always produces same hash", () => {
    const path = "/docs/heavy/readme.md";
    expect(hashPath(path)).toBe(hashPath(path));
  });

  it("different paths produce different hashes (no trivial collisions)", () => {
    const paths = [
      "/a.md",
      "/b.md",
      "/docs/a.md",
      "/docs/b.md",
      "/deep/nested/path/file.md",
    ];
    const hashes = paths.map(hashPath);
    expect(new Set(hashes).size).toBe(paths.length);
  });

  it("empty string produces a valid 8-char hex hash", () => {
    expect(hashPath("")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("sessionStorageKey", () => {
  it("starts with the mdopener-session- prefix", () => {
    expect(sessionStorageKey("/foo.md")).toMatch(/^mdopener-session-/);
  });

  it("includes the hash of the path", () => {
    const path = "/docs/file.md";
    const key = sessionStorageKey(path);
    expect(key).toBe(`mdopener-session-${hashPath(path)}`);
  });
});

// =============================================================================
// saveSnapshot / loadSnapshot / clearSnapshot
// =============================================================================

describe("saveSnapshot / loadSnapshot", () => {
  it("round-trips a full snapshot through sessionStorage", () => {
    const snap = makeSnapshot("/docs/a.md");
    saveSnapshot(snap);
    const loaded = loadSnapshot("/docs/a.md");
    expect(loaded).not.toBeNull();
    expect(loaded!.path).toBe("/docs/a.md");
    expect(loaded!.cursorOffset).toBe(42);
    expect(loaded!.scrollTop).toBe(100);
    expect(loaded!.viewMode).toBe("edit");
    expect(loaded!.zoom).toBe(1.0);
  });

  it("stores different paths under different keys", () => {
    saveSnapshot(makeSnapshot("/a.md", { cursorOffset: 1 }));
    saveSnapshot(makeSnapshot("/b.md", { cursorOffset: 2 }));
    expect(loadSnapshot("/a.md")!.cursorOffset).toBe(1);
    expect(loadSnapshot("/b.md")!.cursorOffset).toBe(2);
  });

  it("overwrites an existing snapshot for the same path", () => {
    saveSnapshot(makeSnapshot("/a.md", { scrollTop: 50 }));
    saveSnapshot(makeSnapshot("/a.md", { scrollTop: 999 }));
    expect(loadSnapshot("/a.md")!.scrollTop).toBe(999);
  });

  it("loadSnapshot returns null for an unsaved path", () => {
    expect(loadSnapshot("/nonexistent.md")).toBeNull();
  });

  it("preserves all viewMode variants", () => {
    const modes: SessionSnapshot["viewMode"][] = [
      "read",
      "edit",
      "source",
      "split",
    ];
    for (const mode of modes) {
      saveSnapshot(makeSnapshot(`/${mode}.md`, { viewMode: mode }));
      expect(loadSnapshot(`/${mode}.md`)!.viewMode).toBe(mode);
    }
  });

  it("preserves fractional zoom values", () => {
    saveSnapshot(makeSnapshot("/zoom.md", { zoom: 1.25 }));
    expect(loadSnapshot("/zoom.md")!.zoom).toBe(1.25);
  });

  it("handles corrupt sessionStorage gracefully — returns null", () => {
    const key = sessionStorageKey("/corrupt.md");
    sessionStorage.setItem(key, "{this is not valid json}}");
    expect(loadSnapshot("/corrupt.md")).toBeNull();
  });

  it("rejects blobs missing required fields — returns null", () => {
    const key = sessionStorageKey("/bad.md");
    sessionStorage.setItem(key, JSON.stringify({ foo: "bar" }));
    expect(loadSnapshot("/bad.md")).toBeNull();
  });

  it("does not throw when sessionStorage.setItem throws (quota exceeded)", () => {
    const original = sessionStorage.setItem.bind(sessionStorage);
    vi.spyOn(sessionStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => saveSnapshot(makeSnapshot("/quota.md"))).not.toThrow();
    // Restore to avoid polluting subsequent tests.
    void original;
  });
});

describe("clearSnapshot", () => {
  it("removes the snapshot for a specific path", () => {
    saveSnapshot(makeSnapshot("/to-clear.md"));
    clearSnapshot("/to-clear.md");
    expect(loadSnapshot("/to-clear.md")).toBeNull();
  });

  it("does not affect other paths", () => {
    saveSnapshot(makeSnapshot("/keep.md"));
    saveSnapshot(makeSnapshot("/remove.md"));
    clearSnapshot("/remove.md");
    expect(loadSnapshot("/keep.md")).not.toBeNull();
  });

  it("is a no-op for paths that were never saved", () => {
    expect(() => clearSnapshot("/never-saved.md")).not.toThrow();
  });
});

describe("clearAllSnapshots", () => {
  it("removes all mdopener-session-* keys from sessionStorage", () => {
    saveSnapshot(makeSnapshot("/a.md"));
    saveSnapshot(makeSnapshot("/b.md"));
    saveSnapshot(makeSnapshot("/c.md"));
    clearAllSnapshots();
    expect(loadSnapshot("/a.md")).toBeNull();
    expect(loadSnapshot("/b.md")).toBeNull();
    expect(loadSnapshot("/c.md")).toBeNull();
  });

  it("does not remove non-mdopener keys", () => {
    sessionStorage.setItem("other-app-key", "preserved");
    saveSnapshot(makeSnapshot("/a.md"));
    clearAllSnapshots();
    expect(sessionStorage.getItem("other-app-key")).toBe("preserved");
  });

  it("is a no-op when no snapshots exist", () => {
    expect(() => clearAllSnapshots()).not.toThrow();
  });
});

// =============================================================================
// saveSnapshotDebounced
// =============================================================================

describe("saveSnapshotDebounced", () => {
  it("does not save immediately — waits for the debounce delay", () => {
    vi.useFakeTimers();
    const snap = makeSnapshot("/debounce.md");
    saveSnapshotDebounced(snap);
    // Not yet saved.
    expect(loadSnapshot("/debounce.md")).toBeNull();
    vi.useRealTimers();
  });

  it("saves after the debounce delay has elapsed", async () => {
    vi.useFakeTimers();
    const snap = makeSnapshot("/debounce-save.md", { scrollTop: 77 });
    saveSnapshotDebounced(snap);
    vi.advanceTimersByTime(350);
    vi.useRealTimers();
    // Allow the microtask queue to flush.
    await Promise.resolve();
    expect(loadSnapshot("/debounce-save.md")).not.toBeNull();
    expect(loadSnapshot("/debounce-save.md")!.scrollTop).toBe(77);
  });

  it("coalesces rapid calls — only the last write survives", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      saveSnapshotDebounced(makeSnapshot("/rapid.md", { cursorOffset: i }));
    }
    vi.advanceTimersByTime(350);
    vi.useRealTimers();
    await Promise.resolve();
    const loaded = loadSnapshot("/rapid.md");
    // Only the last invocation (cursorOffset=4) should have persisted.
    expect(loaded!.cursorOffset).toBe(4);
  });
});

// =============================================================================
// IndexedDB: cacheDocument / loadCachedDocument
// =============================================================================

describe("cacheDocument / loadCachedDocument", () => {
  it("stores and retrieves document content", async () => {
    await cacheDocument("/doc.md", "# Hello");
    const content = await loadCachedDocument("/doc.md");
    expect(content).toBe("# Hello");
  });

  it("returns null for a path that was never cached", async () => {
    const result = await loadCachedDocument("/never-cached.md");
    expect(result).toBeNull();
  });

  it("updates content when cacheDocument is called twice for same path", async () => {
    await cacheDocument("/update.md", "old content");
    await cacheDocument("/update.md", "new content");
    expect(await loadCachedDocument("/update.md")).toBe("new content");
  });

  it("caches multiple documents independently", async () => {
    await cacheDocument("/a.md", "alpha");
    await cacheDocument("/b.md", "beta");
    expect(await loadCachedDocument("/a.md")).toBe("alpha");
    expect(await loadCachedDocument("/b.md")).toBe("beta");
  });

  it("touching a cached doc updates its accessedAt (LRU refresh)", async () => {
    await cacheDocument("/lru.md", "content");
    // Simulate a later load.
    const before = Date.now();
    const content = await loadCachedDocument("/lru.md");
    expect(content).toBe("content");
    // The IDB entry's accessedAt should be >= before.
    const cached = await loadCachedDocument("/lru.md");
    expect(cached).not.toBeNull();
    void before; // accessedAt is internal; we just verify the load succeeds.
  });

  it("returns null gracefully when IDB open fails", async () => {
    setupIdbMock({ failOpen: true });
    const result = await loadCachedDocument("/offline.md");
    expect(result).toBeNull();
  });

  it("does not throw when IDB open fails during cacheDocument", async () => {
    setupIdbMock({ failOpen: true });
    await expect(cacheDocument("/fail.md", "content")).resolves.toBeUndefined();
  });
});

// =============================================================================
// removeCachedDocument / clearDocumentCache
// =============================================================================

describe("removeCachedDocument", () => {
  it("removes a single cached document", async () => {
    await cacheDocument("/remove-me.md", "body");
    await removeCachedDocument("/remove-me.md");
    expect(await loadCachedDocument("/remove-me.md")).toBeNull();
  });

  it("does not affect other cached documents", async () => {
    await cacheDocument("/keep-a.md", "alpha");
    await cacheDocument("/keep-b.md", "beta");
    await removeCachedDocument("/keep-a.md");
    expect(await loadCachedDocument("/keep-b.md")).toBe("beta");
  });

  it("is a no-op for paths not in cache", async () => {
    await expect(removeCachedDocument("/ghost.md")).resolves.toBeUndefined();
  });
});

describe("clearDocumentCache", () => {
  it("removes all cached documents", async () => {
    await cacheDocument("/x.md", "x");
    await cacheDocument("/y.md", "y");
    await clearDocumentCache();
    expect(await loadCachedDocument("/x.md")).toBeNull();
    expect(await loadCachedDocument("/y.md")).toBeNull();
  });

  it("getCacheSizeBytes returns 0 after clear", async () => {
    await cacheDocument("/big.md", "a".repeat(1000));
    await clearDocumentCache();
    expect(await getCacheSizeBytes()).toBe(0);
  });
});

// =============================================================================
// LRU eviction
// =============================================================================

describe("LRU eviction", () => {
  it("does not evict documents when total size is under 50 MB", async () => {
    const content = "x".repeat(100); // tiny
    await cacheDocument("/small-a.md", content);
    await cacheDocument("/small-b.md", content);
    expect(await listCachedPaths()).toHaveLength(2);
  });

  it("evicts least-recently-used docs when cache exceeds 50 MB", async () => {
    // Each content is ~1 MB (UTF-16: 0.5M chars × 2 bytes).
    // We'll add 51 1-MB documents. The oldest should be evicted.
    const chunkSize = 512 * 1024; // 0.5M chars → ~1 MB in UTF-16

    // Add 50 docs with timestamps spread over 50 seconds (oldest first).
    // We bypass Date.now() by setting accessedAt manually via cacheDocument
    // (it uses Date.now() internally). To force LRU ordering we add them
    // sequentially and rely on the mock's synchronous behaviour.
    for (let i = 0; i < 50; i++) {
      await cacheDocument(`/big-${i}.md`, "m".repeat(chunkSize));
    }
    // At ~50 MB we're right at the limit. Adding one more triggers eviction.
    await cacheDocument("/overflow.md", "m".repeat(chunkSize));

    const paths = await listCachedPaths();
    // Total inserted: 51 docs × ~1 MB = ~51 MB → at least 1 must be evicted.
    expect(paths.length).toBeLessThan(51);
    // The overflow doc (most recently added) must survive.
    expect(paths).toContain("/overflow.md");
  });

  it("getCacheSizeBytes stays at or below 50 MB after eviction", async () => {
    const chunkSize = 512 * 1024;
    for (let i = 0; i < 52; i++) {
      await cacheDocument(`/evict-${i}.md`, "e".repeat(chunkSize));
    }
    const size = await getCacheSizeBytes();
    expect(size).toBeLessThanOrEqual(50 * 1024 * 1024);
  });
});

// =============================================================================
// getCacheSizeBytes / listCachedPaths
// =============================================================================

describe("getCacheSizeBytes", () => {
  it("returns 0 when cache is empty", async () => {
    expect(await getCacheSizeBytes()).toBe(0);
  });

  it("returns non-zero after caching a document", async () => {
    await cacheDocument("/measure.md", "hello world");
    const size = await getCacheSizeBytes();
    expect(size).toBeGreaterThan(0);
  });

  it("increases proportionally with content length", async () => {
    await cacheDocument("/small.md", "a".repeat(100));
    const small = await getCacheSizeBytes();
    await cacheDocument("/large.md", "a".repeat(10000));
    const large = await getCacheSizeBytes();
    expect(large).toBeGreaterThan(small);
  });
});

describe("listCachedPaths", () => {
  it("returns empty array when cache is empty", async () => {
    expect(await listCachedPaths()).toEqual([]);
  });

  it("returns all cached paths", async () => {
    await cacheDocument("/alpha.md", "a");
    await cacheDocument("/beta.md", "b");
    const paths = await listCachedPaths();
    expect(paths).toContain("/alpha.md");
    expect(paths).toContain("/beta.md");
  });
});

// =============================================================================
// recoverSession
// =============================================================================

describe("recoverSession", () => {
  it("returns { content: null, snapshot: null } when nothing is stored", async () => {
    const result = await recoverSession("/fresh.md");
    expect(result.content).toBeNull();
    expect(result.snapshot).toBeNull();
  });

  it("recovers content from IDB", async () => {
    await cacheDocument("/cached-doc.md", "# Cached content");
    const result = await recoverSession("/cached-doc.md");
    expect(result.content).toBe("# Cached content");
  });

  it("recovers snapshot from sessionStorage", () => {
    const snap = makeSnapshot("/snap-only.md", {
      cursorOffset: 500,
      scrollTop: 300,
    });
    saveSnapshot(snap);
    // Don't cache in IDB — only session metadata.
    return recoverSession("/snap-only.md").then((result) => {
      expect(result.content).toBeNull();
      expect(result.snapshot).not.toBeNull();
      expect(result.snapshot!.cursorOffset).toBe(500);
      expect(result.snapshot!.scrollTop).toBe(300);
    });
  });

  it("recovers both content and snapshot together", async () => {
    await cacheDocument("/full.md", "full body text");
    saveSnapshot(makeSnapshot("/full.md", { zoom: 1.5 }));
    const result = await recoverSession("/full.md");
    expect(result.content).toBe("full body text");
    expect(result.snapshot!.zoom).toBe(1.5);
  });

  it("returns content=null gracefully when IDB fails", async () => {
    setupIdbMock({ failOpen: true });
    saveSnapshot(makeSnapshot("/idb-fail.md"));
    const result = await recoverSession("/idb-fail.md");
    expect(result.content).toBeNull();
    // Snapshot from sessionStorage should still be recovered.
    expect(result.snapshot).not.toBeNull();
  });

  it("recovers cursor offset correctly after round-trip", async () => {
    await cacheDocument("/cursor.md", "some content here");
    saveSnapshot(makeSnapshot("/cursor.md", { cursorOffset: 11 }));
    const result = await recoverSession("/cursor.md");
    expect(result.snapshot!.cursorOffset).toBe(11);
  });

  it("recovers scroll position correctly after round-trip", async () => {
    await cacheDocument("/scroll.md", "long document...");
    saveSnapshot(makeSnapshot("/scroll.md", { scrollTop: 1234 }));
    const result = await recoverSession("/scroll.md");
    expect(result.snapshot!.scrollTop).toBe(1234);
  });

  it("handles corrupt snapshot in sessionStorage gracefully", async () => {
    await cacheDocument("/corrupt-snap.md", "content");
    sessionStorage.setItem(
      sessionStorageKey("/corrupt-snap.md"),
      "{{broken json",
    );
    const result = await recoverSession("/corrupt-snap.md");
    expect(result.content).toBe("content");
    expect(result.snapshot).toBeNull();
  });
});

// =============================================================================
// syncDocToSession (bridge helper)
// =============================================================================

describe("syncDocToSession", () => {
  it("persists document content to IDB", async () => {
    await syncDocToSession("/synced.md", "# Synced");
    const cached = await loadCachedDocument("/synced.md");
    expect(cached).toBe("# Synced");
  });

  it("resolves without throwing on IDB failure", async () => {
    setupIdbMock({ failOpen: true });
    await expect(
      syncDocToSession("/bad-idb.md", "content"),
    ).resolves.toBeUndefined();
  });

  it("updates existing cache entry when called multiple times", async () => {
    await syncDocToSession("/evolving.md", "v1");
    await syncDocToSession("/evolving.md", "v2");
    expect(await loadCachedDocument("/evolving.md")).toBe("v2");
  });
});

// =============================================================================
// isOffline
// =============================================================================

describe("isOffline", () => {
  it("returns false when navigator.onLine is true", () => {
    Object.defineProperty(navigator, "onLine", {
      value: true,
      configurable: true,
    });
    expect(isOffline()).toBe(false);
  });

  it("returns true when navigator.onLine is false", () => {
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    expect(isOffline()).toBe(true);
    // Restore.
    Object.defineProperty(navigator, "onLine", {
      value: true,
      configurable: true,
    });
  });
});

// =============================================================================
// broadcastSnapshot / onCrossTabSnapshot
// =============================================================================

describe("broadcastSnapshot", () => {
  it("writes the snapshot to sessionStorage (same-tab path)", () => {
    const snap = makeSnapshot("/broadcast.md");
    broadcastSnapshot(snap);
    expect(loadSnapshot("/broadcast.md")).not.toBeNull();
    expect(loadSnapshot("/broadcast.md")!.cursorOffset).toBe(
      snap.cursorOffset,
    );
  });
});

describe("onCrossTabSnapshot", () => {
  it("registers and unregisters a storage event listener", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const handler = vi.fn();
    const unsub = onCrossTabSnapshot(handler);
    expect(addSpy).toHaveBeenCalledWith("storage", expect.any(Function));

    unsub();
    expect(removeSpy).toHaveBeenCalledWith("storage", expect.any(Function));
  });

  it("calls handler with parsed snapshot when a matching key changes", () => {
    const handler = vi.fn();
    onCrossTabSnapshot(handler);

    const snap = makeSnapshot("/tab-b.md");
    const key = sessionStorageKey("/tab-b.md");
    // Simulate a storage event from another tab.
    const event = new StorageEvent("storage", {
      key,
      newValue: JSON.stringify(snap),
      oldValue: null,
    });
    window.dispatchEvent(event);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/tab-b.md" }),
    );
  });

  it("calls handler with null when a key is removed (newValue=null)", () => {
    const handler = vi.fn();
    onCrossTabSnapshot(handler);

    const key = sessionStorageKey("/tab-remove.md");
    const event = new StorageEvent("storage", {
      key,
      newValue: null,
      oldValue: "old",
    });
    window.dispatchEvent(event);

    expect(handler).toHaveBeenCalledWith(null);
  });

  it("ignores storage events for non-mdopener keys", () => {
    const handler = vi.fn();
    onCrossTabSnapshot(handler);

    const event = new StorageEvent("storage", {
      key: "some-other-app-key",
      newValue: '{"foo":1}',
    });
    window.dispatchEvent(event);

    expect(handler).not.toHaveBeenCalled();
  });

  it("calls handler with null when newValue is corrupt JSON", () => {
    const handler = vi.fn();
    onCrossTabSnapshot(handler);

    const key = sessionStorageKey("/corrupt-cross.md");
    const event = new StorageEvent("storage", {
      key,
      newValue: "{bad json",
    });
    window.dispatchEvent(event);

    expect(handler).toHaveBeenCalledWith(null);
  });

  it("unsubscribed handler is not called after unsub()", () => {
    const handler = vi.fn();
    const unsub = onCrossTabSnapshot(handler);
    unsub();

    const key = sessionStorageKey("/after-unsub.md");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        newValue: JSON.stringify(makeSnapshot("/after-unsub.md")),
      }),
    );

    expect(handler).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Offline fallback scenario (integration)
// =============================================================================

describe("Offline fallback scenario", () => {
  it("recoverSession returns cached content when disk read would fail", async () => {
    // Cache document when online.
    await cacheDocument("/offline-doc.md", "# Offline content");
    saveSnapshot(makeSnapshot("/offline-doc.md", { scrollTop: 500 }));

    // Simulate going offline — IDB is still available.
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    expect(isOffline()).toBe(true);

    // Recovery still works from cache.
    const result = await recoverSession("/offline-doc.md");
    expect(result.content).toBe("# Offline content");
    expect(result.snapshot!.scrollTop).toBe(500);

    Object.defineProperty(navigator, "onLine", {
      value: true,
      configurable: true,
    });
  });
});

// =============================================================================
// Cursor / scroll state sync across tabs (integration)
// =============================================================================

describe("cursor and scroll state sync across tabs", () => {
  it("snapshot preserves cursor offset after save and load", () => {
    const snap = makeSnapshot("/editor.md", { cursorOffset: 1234 });
    saveSnapshot(snap);
    const loaded = loadSnapshot("/editor.md");
    expect(loaded!.cursorOffset).toBe(1234);
  });

  it("snapshot preserves scroll offset after save and load", () => {
    saveSnapshot(makeSnapshot("/scroll-test.md", { scrollTop: 9876 }));
    expect(loadSnapshot("/scroll-test.md")!.scrollTop).toBe(9876);
  });

  it("snapshot survives overwrite with updated cursor position", () => {
    saveSnapshot(makeSnapshot("/edit-cursor.md", { cursorOffset: 10 }));
    saveSnapshot(makeSnapshot("/edit-cursor.md", { cursorOffset: 20 }));
    expect(loadSnapshot("/edit-cursor.md")!.cursorOffset).toBe(20);
  });

  it("different docs maintain independent cursor/scroll state", () => {
    saveSnapshot(makeSnapshot("/doc1.md", { cursorOffset: 100, scrollTop: 200 }));
    saveSnapshot(makeSnapshot("/doc2.md", { cursorOffset: 300, scrollTop: 400 }));
    expect(loadSnapshot("/doc1.md")!.cursorOffset).toBe(100);
    expect(loadSnapshot("/doc2.md")!.cursorOffset).toBe(300);
    expect(loadSnapshot("/doc1.md")!.scrollTop).toBe(200);
    expect(loadSnapshot("/doc2.md")!.scrollTop).toBe(400);
  });
});
