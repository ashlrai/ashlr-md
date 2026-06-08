/**
 * wikilink.ts — resolve a wikilink target to an absolute file path.
 *
 * Resolution runs in Rust (`resolve_wikilink`), scoped to the effective vault
 * root (Obsidian-faithful: vault-wide, closest-to-current-doc wins) and falling
 * back to the current document's directory. Results are memoized per
 * (vaultRoot, baseDir, target) so hover/render don't spam IPC.
 *
 * A RESOLVED path is cached for the session (it won't spontaneously break). A
 * BROKEN (null) result is cached only briefly, so creating the missing note then
 * re-rendering picks it up instead of showing "broken" forever.
 */

import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "../store/documentStore";
import { effectiveVaultRoot } from "./vault";

/** How long a "broken link" (null) result stays cached before we re-resolve. */
const NULL_TTL_MS = 5000;

interface CacheEntry {
  value: string | null;
  at: number;
}
const cache = new Map<string, CacheEntry>();

/** Drop every cached resolution — call after bulk vault changes if needed. */
export function invalidateWikilinkCache(): void {
  cache.clear();
}

function baseDirOf(path: string | null): string | null {
  if (!path) return null;
  const sep = path.includes("\\") ? "\\" : "/";
  const i = path.lastIndexOf(sep);
  if (i < 0) return null;
  // A root-level file (e.g. "/note.md") lives in the root dir, not nowhere.
  return i === 0 ? sep : path.slice(0, i);
}

/** Resolve `target` to an absolute path, or `null` if it can't be found. */
export async function resolveWikilink(target: string): Promise<string | null> {
  const path = useDocumentStore.getState().path;
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
