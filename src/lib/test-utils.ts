/**
 * test-utils.ts — reusable mock factories for the vitest harness.
 *
 * Exported factories let individual test files create isolated mock instances
 * of browser storage/IDB APIs without duplicating boilerplate.
 *
 * Usage:
 *   import { createMockLocalStorage, createMockIDB } from "../lib/test-utils";
 *
 *   const ls = createMockLocalStorage();
 *   Object.defineProperty(globalThis, "localStorage", { value: ls, ... });
 *
 *   const idb = createMockIDB();
 *   Object.defineProperty(globalThis, "indexedDB", { value: idb, ... });
 */

// ---------------------------------------------------------------------------
// createMockLocalStorage / createMockSessionStorage
// ---------------------------------------------------------------------------

/**
 * Creates a Map-backed Storage object that fully satisfies the Storage
 * interface.  The internal Map is exposed as `_store` so tests can inspect
 * or clear it directly without going through the Web API surface.
 */
export function createMockLocalStorage(): Storage & { _store: Map<string, string> } {
  const _store = new Map<string, string>();

  const mock: Storage & { _store: Map<string, string> } = {
    _store,
    get length() {
      return _store.size;
    },
    key(index: number): string | null {
      const keys = Array.from(_store.keys());
      return index >= 0 && index < keys.length ? (keys[index] ?? null) : null;
    },
    getItem(key: string): string | null {
      return _store.has(key) ? (_store.get(key) ?? null) : null;
    },
    setItem(key: string, value: string): void {
      _store.set(key, String(value));
    },
    removeItem(key: string): void {
      _store.delete(key);
    },
    clear(): void {
      _store.clear();
    },
  };

  return mock;
}

// Alias — sessionStorage has the same interface.
export const createMockSessionStorage = createMockLocalStorage;

// ---------------------------------------------------------------------------
// IDB mock types
// ---------------------------------------------------------------------------

/** Record stored in the mock IDB object store. */
export type IdbRecord = Record<string, unknown>;

/** Options controlling how the mock IDB factory behaves. */
export interface MockIDBOptions {
  /** When true, every `indexedDB.open()` call fails with an UnknownError. */
  failOpen?: boolean;
}

// ---------------------------------------------------------------------------
// createMockIDB
// ---------------------------------------------------------------------------

/**
 * Creates a lightweight in-memory IndexedDB shim sufficient for all CRUD
 * operations tested in this repo.  Not a full spec implementation — just
 * enough to exercise `openCacheDb`, `cacheDocument`, `loadCachedDocument`,
 * `removeCachedDocument`, `clearDocumentCache`, `getAll`, and the upgrade
 * needed path.
 *
 * The returned object is intended to be assigned to `globalThis.indexedDB`:
 *
 *   const idb = createMockIDB();
 *   Object.defineProperty(globalThis, "indexedDB", {
 *     value: idb, writable: true, configurable: true,
 *   });
 */
export function createMockIDB(opts: MockIDBOptions = {}): Pick<IDBFactory, "open"> {
  // Shared data map — all stores within one IDB instance share this for
  // simplicity; the single-store usage in sessionPersistenceStore is fine.
  const _data = new Map<string, IdbRecord>();

  // ── MockIDBRequest ─────────────────────────────────────────────────────────

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

  // ── MockIDBObjectStore ─────────────────────────────────────────────────────

  class MockIDBObjectStore {
    put(value: IdbRecord): MockIDBRequest {
      const req = new MockIDBRequest();
      const key = String(value["path"] ?? "");
      _data.set(key, { ...value });
      setTimeout(() => req._resolve(undefined), 0);
      return req;
    }

    get(key: string): MockIDBRequest<IdbRecord | undefined> {
      const req = new MockIDBRequest<IdbRecord | undefined>();
      const val = _data.get(String(key));
      setTimeout(() => req._resolve(val), 0);
      return req;
    }

    delete(key: string): MockIDBRequest {
      const req = new MockIDBRequest();
      _data.delete(String(key));
      setTimeout(() => req._resolve(undefined), 0);
      return req;
    }

    clear(): MockIDBRequest {
      const req = new MockIDBRequest();
      _data.clear();
      setTimeout(() => req._resolve(undefined), 0);
      return req;
    }

    getAll(): MockIDBRequest<IdbRecord[]> {
      const req = new MockIDBRequest<IdbRecord[]>();
      const all = Array.from(_data.values());
      setTimeout(() => req._resolve(all), 0);
      return req;
    }

    createIndex(_name: string, _keyPath: string, _opts?: unknown): void {
      // No-op in mock.
    }
  }

  // ── MockIDBTransaction ─────────────────────────────────────────────────────

  const _store = new MockIDBObjectStore();

  class MockIDBTransaction {
    objectStore(_name: string): MockIDBObjectStore {
      return _store;
    }
  }

  // ── MockIDBDatabase ────────────────────────────────────────────────────────

  class MockIDBDatabase extends EventTarget {
    objectStoreNames = {
      contains: (_n: string) => false,
    } as unknown as DOMStringList;

    transaction(_storeName: string, _mode?: string): MockIDBTransaction {
      return new MockIDBTransaction();
    }

    createObjectStore(_name: string, _opts?: unknown): MockIDBObjectStore {
      return _store;
    }
  }

  // ── MockIDBOpenDBRequest ───────────────────────────────────────────────────

  class MockIDBOpenDBRequest extends EventTarget {
    result: MockIDBDatabase | undefined;
    error: DOMException | null = null;
    onsuccess: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;
    onblocked: (() => void) | null = null;

    _open(db: MockIDBDatabase, needsUpgrade: boolean): void {
      this.result = db;
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
      const evt = new Event("error");
      Object.defineProperty(evt, "target", { value: this, configurable: true });
      if (this.onerror) this.onerror(evt);
    }
  }

  // ── Factory open() ─────────────────────────────────────────────────────────

  return {
    open(_name: string, _version?: number): IDBOpenDBRequest {
      const req = new MockIDBOpenDBRequest();
      if (opts.failOpen) {
        setTimeout(
          () => req._fail(new DOMException("IDB open failed (mock)", "UnknownError")),
          0,
        );
      } else {
        const db = new MockIDBDatabase();
        setTimeout(() => req._open(db, true), 0);
      }
      return req as unknown as IDBOpenDBRequest;
    },
  };
}
