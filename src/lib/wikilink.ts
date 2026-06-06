/**
 * wikilink.ts — resolve a wikilink target to an absolute file path.
 *
 * Resolution runs in Rust (`resolve_wikilink`), scoped to the effective vault
 * root (Obsidian-faithful: vault-wide, closest-to-current-doc wins) and falling
 * back to the current document's directory. Results are memoized per
 * (vaultRoot, baseDir, target) for the session so hover/render don't spam IPC.
 */

import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "../store/documentStore";
import { effectiveVaultRoot } from "./vault";

const cache = new Map<string, string | null>();

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
  if (cached !== undefined) return cached;
  try {
    const resolved = await invoke<string | null>("resolve_wikilink", {
      baseDir: dir,
      target,
      vaultRoot,
    });
    // Cache the real answer (incl. a genuine "broken link" null).
    cache.set(key, resolved ?? null);
    return resolved ?? null;
  } catch {
    // Don't cache transient IPC failures (e.g. cold start) — a permanent null
    // would render a valid link as broken for the rest of the session.
    return null;
  }
}
