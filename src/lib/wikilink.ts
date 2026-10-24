/**
 * wikilink.ts — resolve a wikilink target to an absolute file path.
 *
 * Resolution runs in Rust (`resolve_wikilink`), scoped to the effective vault
 * root (Obsidian-faithful: vault-wide, closest-to-current-doc wins) and falling
 * back to the current document's directory. Results are memoized per
 * (vaultRoot, baseDir, target) so hover/render don't spam IPC.
 *
 * A RESOLVED path is cached until a file changes, appears or is renamed on
 * disk ({@link watchWikilinkChanges}): it was cached for the session, so a
 * link to a note deleted or renamed since still showed as a working link. A
 * BROKEN (null) result is cached only briefly, so creating the missing note then
 * re-rendering picks it up instead of showing "broken" forever.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { useDocumentStore } from "../store/documentStore";
import { effectiveVaultRoot } from "./vault";

/** How long a "broken link" (null) result stays cached before we re-resolve. */
const NULL_TTL_MS = 5000;

interface CacheEntry {
  value: string | null;
  at: number;
}
const cache = new Map<string, CacheEntry>();

/** Bumped when the cache is dropped, so rendered links resolve again. */
let version = 0;
const listeners = new Set<() => void>();

/** Drop every cached resolution, and have rendered links resolve again. */
export function invalidateWikilinkCache(): void {
  cache.clear();
  version++;
  for (const l of listeners) l();
}

/**
 * A number that changes whenever the cache is dropped: a link that keys
 * its resolution on it shows a note deleted or renamed since as broken.
 */
export function useWikilinkCacheVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

/** How long a burst of file events is gathered before links resolve again. */
const CHANGE_SETTLE_MS = 250;

/**
 * Drop the cache when a file changes, appears or is renamed on disk: the
 * open file's watcher (`file-changed`, also sent when it is deleted, and
 * `file-renamed`) and the watched folder's (`activity://file`, a note
 * created, deleted or renamed in it). A burst of events drops it once. Returns a
 * function that stops listening.
 */
export async function watchWikilinkChanges(): Promise<() => void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      invalidateWikilinkCache();
    }, CHANGE_SETTLE_MS);
  };
  const stops = await Promise.all(
    ["file-changed", "file-renamed", "activity://file"].map((e) => listen(e, changed)),
  );
  return () => {
    if (timer !== null) clearTimeout(timer);
    for (const stop of stops) stop();
  };
}

function baseDirOf(path: string | null): string | null {
  if (!path) return null;
  const sep = path.includes("\\") ? "\\" : "/";
  const i = path.lastIndexOf(sep);
  if (i < 0) return null;
  // A root-level file (e.g. "/note.md") lives in the root dir, not nowhere.
  return i === 0 ? sep : path.slice(0, i);
}

/**
 * Resolve `target` to an absolute path, or `null` if it can't be found.
 * It is resolved from the document at `fromPath` (an embedded note's own
 * file), or from the open document when `fromPath` is not given.
 */
export async function resolveWikilink(
  target: string,
  fromPath?: string | null,
): Promise<string | null> {
  const path = fromPath === undefined ? useDocumentStore.getState().path : fromPath;
  const dir = baseDirOf(path);
  if (!dir) return null;
  const vaultRoot = await effectiveVaultRoot(path);
  const key = `${vaultRoot ?? ""}|${dir}|${target}`;
  const cached = cache.get(key);
  // Use a cached hit; for a cached miss (null) only within the TTL, else re-ask.
  if (cached && (cached.value !== null || Date.now() - cached.at < NULL_TTL_MS)) {
    return cached.value;
  }
  try {
    const resolved = await invoke<string | null>("resolve_wikilink", {
      baseDir: dir,
      target,
      vaultRoot,
    });
    cache.set(key, { value: resolved ?? null, at: Date.now() });
    return resolved ?? null;
  } catch {
    // Don't cache transient IPC failures (e.g. cold start) — a permanent null
    // would render a valid link as broken for the rest of the session.
    return null;
  }
}
