/**
 * vault.ts — determine the effective Obsidian "vault root" for link resolution.
 *
 * Precedence:
 *   1. an explicit Settings override (`settingsStore.vaultRoot`), if set;
 *   2. else the auto-detected `.obsidian/` ancestor of the current document;
 *   3. else null — resolution falls back to the document's own directory.
 *
 * Detection results are memoized per starting path for the session, since the
 * vault root of a given file doesn't change while the app is open.
 */

import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../store/settingsStore";

const detectCache = new Map<string, string | null>();

async function detectVaultRoot(start: string): Promise<string | null> {
  const cached = detectCache.get(start);
  if (cached !== undefined) return cached;
  try {
    const root = await invoke<string | null>("detect_vault_root", { start });
    // Cache the real answer (including a genuine "not in a vault" null).
    detectCache.set(start, root ?? null);
    return root ?? null;
  } catch {
    // Don't cache transient IPC failures (e.g. during cold start) — a permanent
    // null here would disable vault resolution for this file all session.
    return null;
  }
}

/** The effective vault root for a document at `path` (see module doc). */
export async function effectiveVaultRoot(path: string | null): Promise<string | null> {
  const override = useSettingsStore.getState().vaultRoot;
  if (override) return override;
  if (!path) return null;
  return detectVaultRoot(path);
}
