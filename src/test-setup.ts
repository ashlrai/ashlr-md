/**
 * test-setup.ts — vitest global harness
 *
 * Problems solved:
 *   1. happy-dom's localStorage stub does not back a real Map — reads after
 *      writes can return stale/undefined values in certain Zustand persist
 *      middleware codepaths, silently poisoning test state across suite runs.
 *   2. No built-in reset between tests meant Zustand-persisted stores could
 *      bleed state from one test into the next.
 *   3. happy-dom lacks indexedDB — sessionPersistenceStore and any module that
 *      transitively calls syncDocToSession (e.g. bridge.ts via Zustand
 *      subscription) throw "ReferenceError: indexedDB is not defined" and
 *      pollute stderr with repeated error logs.
 *   4. happy-dom's navigator.clipboard is absent — copyRichText and pasteImage
 *      tests that exercise error-fallback paths log spurious clipboard errors.
 *   5. DOMException is undefined in some happy-dom versions, breaking mocks
 *      that construct it directly.
 *
 * What this file does:
 *   - Installs a deterministic Map-backed localStorage mock on `globalThis`.
 *   - Installs a matching Map-backed sessionStorage mock on `globalThis`.
 *   - Installs a minimal in-memory IndexedDB shim so modules that call
 *     `indexedDB.open()` never throw "not defined" during tests that don't
 *     explicitly set up their own IDB mock.
 *   - Installs a navigator.clipboard stub (write + writeText both resolve) so
 *     clipboard error-path tests don't produce real clipboard errors.
 *   - Installs a ClipboardItem stub class for tests that construct items.
 *   - Ensures DOMException is available on globalThis.
 *   - Registers a `beforeEach` hook that clears localStorage and sessionStorage
 *     before every test so stores always start from a blank slate.
 *   - Exports `getStoredState(key)` — a typed helper tests can use to inspect
 *     persisted Zustand blobs without directly coupling to `localStorage`.
 */

import { beforeEach } from "vitest";
import { createMockLocalStorage, createMockSessionStorage, createMockIDB } from "./lib/test-utils";

// ---------------------------------------------------------------------------
// DOMException polyfill
// ---------------------------------------------------------------------------
// happy-dom exposes DOMException, but guard just in case.

if (typeof globalThis.DOMException === "undefined") {
  // Minimal polyfill — only name and message are needed by our mocks.
  class DOMExceptionPolyfill extends Error {
    name: string;
    constructor(message = "", name = "Error") {
      super(message);
      this.name = name;
    }
  }
  Object.defineProperty(globalThis, "DOMException", {
    value: DOMExceptionPolyfill,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Map-backed localStorage mock
// ---------------------------------------------------------------------------

const localStorageMock = createMockLocalStorage();

// Install on globalThis so both `window.localStorage` and bare `localStorage`
// references resolve to the same mock object.
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Map-backed sessionStorage mock
// ---------------------------------------------------------------------------

const sessionStorageMock = createMockSessionStorage();

Object.defineProperty(globalThis, "sessionStorage", {
  value: sessionStorageMock,
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// IndexedDB shim
// ---------------------------------------------------------------------------
// Provides a default no-op IDB so modules that call indexedDB.open() don't
// throw "ReferenceError: indexedDB is not defined".  Tests that need specific
// IDB behaviour (e.g. sessionPersistenceStore.test.ts) install their own mock
// via Object.defineProperty({ configurable: true }) which overrides this.

const defaultIdbMock = createMockIDB();

Object.defineProperty(globalThis, "indexedDB", {
  value: defaultIdbMock,
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Clipboard API stub
// ---------------------------------------------------------------------------
// Provides navigator.clipboard.write and .writeText stubs that resolve
// successfully by default.  Tests that want to exercise error paths install
// their own navigator mock (see copyRichText.test.ts / pasteImage.test.ts).
// We only install these if the current navigator doesn't already have them,
// so test-file-level mocks always win.

if (typeof globalThis.navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: {},
    writable: true,
    configurable: true,
  });
}

if (
  typeof (globalThis.navigator as Navigator & { clipboard?: unknown }).clipboard === "undefined"
) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: {
      write: () => Promise.resolve(),
      writeText: () => Promise.resolve(),
      read: () => Promise.resolve([]),
      readText: () => Promise.resolve(""),
    },
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// ClipboardItem stub
// ---------------------------------------------------------------------------
// Tests that construct ClipboardItem directly (e.g. copyRichText.test.ts)
// install their own class in beforeEach.  This default stub ensures the name
// is defined at module load time so conditional branches that check
// `typeof ClipboardItem !== "undefined"` behave consistently.

if (typeof globalThis.ClipboardItem === "undefined") {
  globalThis.ClipboardItem = class ClipboardItemStub {
    constructor(public readonly data: Record<string, Blob>) {}
  } as unknown as typeof ClipboardItem;
}

// ---------------------------------------------------------------------------
// Auto-clear before every test
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorageMock._store.clear();
  sessionStorageMock._store.clear();
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
