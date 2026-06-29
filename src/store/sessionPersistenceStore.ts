/**
 * sessionPersistenceStore.ts — hybrid sessionStorage + IndexedDB persistence.
 *
 * Two-tier storage:
 *   Tier 1 — sessionStorage: lightweight per-document session metadata
 *     (cursor position, scroll offset, view mode, zoom level).
 *     Key pattern: `mdopener-session-${docHash}` where docHash is a
 *     deterministic hex hash of the document path.
 *     Saved on every edit, debounced 300 ms.
 *
 *   Tier 2 — IndexedDB (`mdopener-cache` DB, `docs` object store): full
 *     markdown document body cache for offline access and fast reopens.
 *     Eviction: LRU, max 50 MB total. Each entry records `accessedAt`
 *     for the eviction ordering.
 *
 * Recovery flow (called from App startup):
 *   recoverSession(path) → reads IndexedDB for content + sessionStorage
 *   for metadata, returning a RecoveredSession or null when nothing is
 *   cached.
 *
 * Bridge integration:
 *   syncDocToSession(path, content) — called on every doc change; persists
 *   content to IDB and bumps the LRU timestamp.
 *
 * All public functions are pure-async and never throw; failures are
 * swallowed with a console.warn so the app continues running offline.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionSnapshot {
  /** Absolute document path. */
  path: string;
  /** Cursor character offset (0-based). */
  cursorOffset: number;
  /** Scroll position in pixels from the top of the scrollable container. */
  scrollTop: number;
  /** Active view mode at time of snapshot. */
  viewMode: "read" | "edit" | "source" | "split";
  /** Zoom level (1.0 = 100 %). */
  zoom: number;
  /** Unix ms timestamp of the snapshot. */
  savedAt: number;
}

export interface DocCacheEntry {
  /** Absolute document path (IDB key). */
  path: string;
  /** Full markdown content body. */
  content: string;
  /** Content byte length (UTF-16 chars × 2, approx). */
  sizeBytes: number;
  /** Unix ms of last access (used for LRU eviction). */
  accessedAt: number;
}

export interface RecoveredSession {
  /** Cached document content (from IDB). Null if not cached. */
  content: string | null;
  /** Session metadata (from sessionStorage). Null if not saved. */
  snapshot: SessionSnapshot | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SS_KEY_PREFIX = "mdopener-session-";
const IDB_DB_NAME = "mdopener-cache";
const IDB_STORE_NAME = "docs";
const IDB_VERSION = 1;
/** Maximum aggregate content size stored in IDB (50 MB, UTF-16 char estimate). */
const MAX_CACHE_BYTES = 50 * 1024 * 1024;

// ── Utility: deterministic path hash ─────────────────────────────────────────

/**
 * Simple djb2-style hash of a string → 8-char hex, collision-resistant
 * enough for key namespacing (not cryptographic).
 */
export function hashPath(path: string): string {
  let h = 5381;
  for (let i = 0; i < path.length; i++) {
    h = ((h << 5) + h + path.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function sessionStorageKey(path: string): string {
  return `${SS_KEY_PREFIX}${hashPath(path)}`;
}

// ── sessionStorage helpers ────────────────────────────────────────────────────

/**
 * Save a SessionSnapshot to sessionStorage.
 * Non-fatal: swallows quota / security errors.
 */
export function saveSnapshot(snapshot: SessionSnapshot): void {
  try {
    const key = sessionStorageKey(snapshot.path);
    sessionStorage.setItem(key, JSON.stringify(snapshot));
  } catch (e) {
    console.warn("[sessionPersistenceStore] saveSnapshot failed:", e);
  }
}

/**
 * Load a SessionSnapshot from sessionStorage for `path`.
 * Returns null if absent or corrupt.
 */
export function loadSnapshot(path: string): SessionSnapshot | null {
  try {
    const key = sessionStorageKey(path);
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionSnapshot;
    // Minimal validation — must have path and savedAt.
    if (typeof parsed.path !== "string" || typeof parsed.savedAt !== "number") {
      return null;
    }
    return parsed;
  } catch (e) {
    console.warn("[sessionPersistenceStore] loadSnapshot failed:", e);
    return null;
  }
}

/**
 * Remove the sessionStorage snapshot for `path`.
 */
export function clearSnapshot(path: string): void {
  try {
    sessionStorage.removeItem(sessionStorageKey(path));
  } catch {
    // non-fatal
  }
}

/**
 * Remove ALL mdopener-session-* entries from sessionStorage.
 */
export function clearAllSnapshots(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(SS_KEY_PREFIX)) keysToRemove.push(k);
    }
    for (const k of keysToRemove) sessionStorage.removeItem(k);
  } catch {
    // non-fatal
  }
}

// ── Debounce helper ───────────────────────────────────────────────────────────

/**
 * Returns a debounced wrapper around `fn` with `wait` ms delay.
 * Exported so tests can spy on / verify debounce behaviour.
 */
export function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

/** Debounced (300 ms) version of saveSnapshot. */
export const saveSnapshotDebounced = debounce(saveSnapshot, 300);

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

/**
 * Open (or create) the mdopener-cache IndexedDB.
 * Returns a promise for the IDBDatabase; rejects on error (caller should catch).
 */
export function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = (_event) => {
      // Use req.result (already set by the time onupgradeneeded fires in all
      // spec-compliant implementations and our test mock).
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        const store = db.createObjectStore(IDB_STORE_NAME, { keyPath: "path" });
        store.createIndex("accessedAt", "accessedAt", { unique: false });
      }
    };
    req.onsuccess = (_event) => resolve(req.result);
    req.onerror = (_event) => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

/**
 * Persist a document to the IDB cache, then enforce the 50 MB LRU cap.
 * Non-fatal: swallows all IDB errors.
 */
export async function cacheDocument(path: string, content: string): Promise<void> {
  try {
    const db = await openCacheDb();
    const sizeBytes = content.length * 2; // UTF-16 approximation
    const entry: DocCacheEntry = {
      path,
      content,
      sizeBytes,
      accessedAt: Date.now(),
    };
    await idbPut(db, entry);
    await evictLru(db);
  } catch (e) {
    console.warn("[sessionPersistenceStore] cacheDocument failed:", e);
  }
}

/**
 * Load a document from the IDB cache. Updates `accessedAt` to now (LRU touch).
 * Returns null if not cached or on any error.
 */
export async function loadCachedDocument(path: string): Promise<string | null> {
  try {
    const db = await openCacheDb();
    const entry = await idbGet(db, path);
    if (!entry) return null;
    // Touch LRU timestamp.
    const updated: DocCacheEntry = { ...entry, accessedAt: Date.now() };
    await idbPut(db, updated);
    return entry.content;
  } catch (e) {
    console.warn("[sessionPersistenceStore] loadCachedDocument failed:", e);
    return null;
  }
}

/**
 * Remove a single document from the IDB cache.
 */
export async function removeCachedDocument(path: string): Promise<void> {
  try {
    const db = await openCacheDb();
    await idbDelete(db, path);
  } catch (e) {
    console.warn("[sessionPersistenceStore] removeCachedDocument failed:", e);
  }
}

/**
 * Clear the entire IDB cache.
 */
export async function clearDocumentCache(): Promise<void> {
  try {
    const db = await openCacheDb();
    await idbClear(db);
  } catch (e) {
    console.warn("[sessionPersistenceStore] clearDocumentCache failed:", e);
  }
}

/**
 * Evict least-recently-used entries until total cache size ≤ MAX_CACHE_BYTES.
 */
async function evictLru(db: IDBDatabase): Promise<void> {
  const all = await idbGetAll(db);
  const totalBytes = all.reduce((sum, e) => sum + e.sizeBytes, 0);
  if (totalBytes <= MAX_CACHE_BYTES) return;

  // Sort ascending by accessedAt — oldest first.
  all.sort((a, b) => a.accessedAt - b.accessedAt);

  let remaining = totalBytes;
  for (const entry of all) {
    if (remaining <= MAX_CACHE_BYTES) break;
    await idbDelete(db, entry.path);
    remaining -= entry.sizeBytes;
  }
}

// ── IDB primitive wrappers ────────────────────────────────────────────────────

// Internal alias used for the IDB put cast below.
type IDBRecord = Record<string, unknown>;

function idbPut(db: IDBDatabase, entry: DocCacheEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, "readwrite");
    const store = tx.objectStore(IDB_STORE_NAME);
    // Cast needed because our test mock returns MockIDBRequest, not IDBRequest.
    const req = store.put(entry as unknown as IDBRecord) as unknown as IDBRequest;
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("idbPut failed"));
  });
}

function idbGet(db: IDBDatabase, path: string): Promise<DocCacheEntry | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, "readonly");
    const store = tx.objectStore(IDB_STORE_NAME);
    const req = store.get(path) as unknown as IDBRequest;
    req.onsuccess = () => resolve((req.result as DocCacheEntry) ?? null);
    req.onerror = () => reject(req.error ?? new Error("idbGet failed"));
  });
}

function idbDelete(db: IDBDatabase, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, "readwrite");
    const store = tx.objectStore(IDB_STORE_NAME);
    const req = store.delete(path) as unknown as IDBRequest;
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("idbDelete failed"));
  });
}

function idbClear(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, "readwrite");
    const store = tx.objectStore(IDB_STORE_NAME);
    const req = store.clear() as unknown as IDBRequest;
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("idbClear failed"));
  });
}

function idbGetAll(db: IDBDatabase): Promise<DocCacheEntry[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, "readonly");
    const store = tx.objectStore(IDB_STORE_NAME);
    const req = store.getAll() as unknown as IDBRequest;
    req.onsuccess = () => resolve((req.result as DocCacheEntry[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("idbGetAll failed"));
  });
}

/** Return total bytes currently in the cache (for tests / diagnostics). */
export async function getCacheSizeBytes(): Promise<number> {
  try {
    const db = await openCacheDb();
    const all = await idbGetAll(db);
    return all.reduce((sum, e) => sum + e.sizeBytes, 0);
  } catch {
    return 0;
  }
}

/** Return all cached paths (for tests / diagnostics). */
export async function listCachedPaths(): Promise<string[]> {
  try {
    const db = await openCacheDb();
    const all = await idbGetAll(db);
    return all.map((e) => e.path);
  } catch {
    return [];
  }
}

// ── Recovery flow ─────────────────────────────────────────────────────────────

/**
 * Called on app startup for each path that was open in the previous session.
 *
 * Returns:
 *   { content, snapshot } — both may be null independently.
 *
 * The caller overlays the returned snapshot (cursor, scroll, viewMode, zoom)
 * on top of a freshly-loaded document, or uses `content` as the initial body
 * if the file is temporarily unavailable (offline).
 */
export async function recoverSession(path: string): Promise<RecoveredSession> {
  const [content, snapshot] = await Promise.all([
    loadCachedDocument(path),
    Promise.resolve(loadSnapshot(path)),
  ]);
  return { content, snapshot };
}

// ── Bridge sync helper ────────────────────────────────────────────────────────

/**
 * Called from the MCP bridge (or documentStore subscriber) whenever the
 * active document changes. Persists the new content to IDB so it's available
 * for offline recovery.
 *
 * Non-fatal — always resolves, never throws.
 */
export async function syncDocToSession(path: string, content: string): Promise<void> {
  await cacheDocument(path, content);
}

// ── Offline detection helper ──────────────────────────────────────────────────

/**
 * Returns true when the browser / app is believed to be offline.
 * In a Tauri context `navigator.onLine` reflects the OS network state.
 */
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && !navigator.onLine;
}

// ── Cross-tab snapshot sync ───────────────────────────────────────────────────

/**
 * Broadcast a snapshot update to all same-origin tabs / windows via the
 * `storage` event (fires on OTHER tabs when sessionStorage is written from
 * a different document context; within a single tab the event does NOT fire).
 *
 * For cross-tab cursor/scroll sync, call broadcastSnapshot() after saving.
 * Other tabs listen via `window.addEventListener("storage", handler)` and
 * call `loadSnapshot(path)` when they see a key matching SS_KEY_PREFIX.
 */
export function broadcastSnapshot(snapshot: SessionSnapshot): void {
  // saveSnapshot writes to sessionStorage, which the `storage` event propagates
  // to sibling tabs. No extra work needed — the write IS the broadcast.
  saveSnapshot(snapshot);
}

/**
 * Register a listener for cross-tab snapshot updates.
 * Returns an unsubscribe function.
 *
 * The `handler` receives the updated snapshot (or null if the key was removed).
 */
export function onCrossTabSnapshot(
  handler: (snapshot: SessionSnapshot | null) => void,
): () => void {
  const listener = (event: StorageEvent) => {
    if (!event.key?.startsWith(SS_KEY_PREFIX)) return;
    if (event.newValue === null) {
      handler(null);
      return;
    }
    try {
      const snapshot = JSON.parse(event.newValue) as SessionSnapshot;
      handler(snapshot);
    } catch {
      handler(null);
    }
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
