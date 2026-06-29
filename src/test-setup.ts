/**
 * test-setup.ts — vitest global harness
 *
 * Problems solved:
 *   1. happy-dom's localStorage stub does not back a real Map — reads after
 *      writes can return stale/undefined values in certain Zustand persist
 *      middleware codepaths, silently poisoning test state across suite runs.
 *   2. No built-in reset between tests meant Zustand-persisted stores could
 *      bleed state from one test into the next.
 *
 * What this file does:
 *   - Installs a deterministic Map-backed localStorage mock on `globalThis`
 *     before any test module is loaded.
 *   - Registers a `beforeEach` hook that clears localStorage before every
 *     test so stores always start from a blank slate.
 *   - Exports `getStoredState(key)` — a typed helper tests can use to inspect
 *     persisted Zustand blobs without directly coupling to `localStorage`.
 */

import { beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Map-backed localStorage mock
// ---------------------------------------------------------------------------

const _store = new Map<string, string>();

const localStorageMock: Storage = {
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

// Install on globalThis so both `window.localStorage` and bare `localStorage`
// references resolve to the same mock object.
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Auto-clear before every test
// ---------------------------------------------------------------------------

beforeEach(() => {
  _store.clear();
});

// ---------------------------------------------------------------------------
// Public helper: inspect persisted Zustand blobs
// ---------------------------------------------------------------------------

/**
 * Read and parse the Zustand persist blob stored under `key`.
 *
 * Returns `null` when the key is absent or the value is not valid JSON.
 *
 * Usage in a test:
 *   const blob = getStoredState<{ recents: RecentFile[] }>("mdopener-recents");
 *   expect(blob?.state.recents).toHaveLength(1);
 */
export function getStoredState<S>(key: string): { state: S; version?: number } | null {
  const raw = localStorageMock.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { state: S; version?: number };
  } catch {
    return null;
  }
}
