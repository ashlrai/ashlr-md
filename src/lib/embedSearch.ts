/**
 * embedSearch.ts — typed wrappers around the Rust semantic-embedding commands.
 *
 * All functions degrade gracefully (return null / [] on any error) so callers
 * can always fall back to keyword search.
 */

import { invoke } from "@tauri-apps/api/core";

export interface SemanticMatch {
  path: string;
  fileName: string;
  snippet: string;
  score: number;
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  removed: number;
  total: number;
  busy: boolean;
  /** Library files that could not be read, so are not in the index. Absent
   *  from an older app. */
  unread?: { path: string; reason: string }[];
}

export interface EmbedStatus {
  available: boolean;
  model: string | null;
  chunkCount: number;
  fileCount: number;
  lastIndexedMs: number;
}

// Cache availability briefly — it's a GET /api/tags round-trip, and library
// chat + related-notes would otherwise fire it on every send / doc-open.
let availCache: { value: string | null; ts: number } | null = null;
const AVAIL_TTL_MS = 60_000;

/** Invalidate the availability cache (e.g. after pulling a model + reindex). */
export function invalidateEmbedAvailable(): void {
  availCache = null;
}

/** The embed-model name if available locally, else null (cached ~60s). */
export async function embedAvailable(): Promise<string | null> {
  const now = Date.now();
  if (availCache && now - availCache.ts < AVAIL_TTL_MS) return availCache.value;
  try {
    const value = await invoke<string | null>("embed_available");
    availCache = { value, ts: now };
    return value;
  } catch {
    return null;
  }
}

/** Top-k semantically similar chunks. Empty when no index / model. */
export async function embedSearch(query: string, k = 8): Promise<SemanticMatch[]> {
  try {
    return await invoke<SemanticMatch[]>("embed_search", { query, k });
  } catch {
    return [];
  }
}

/**
 * (Re)index the given paths (incremental by mtime).
 * @param prune true only for a FULL-library reindex (drops files no longer in
 *   `paths`); false for incremental per-file updates so the rest of the index
 *   is never touched.
 */
export async function embedIndex(
  paths: string[],
  prune = false,
): Promise<IndexResult | null> {
  try {
    return await invoke<IndexResult>("embed_index", { paths, prune });
  } catch {
    return null;
  }
}

export async function embedStatus(): Promise<EmbedStatus | null> {
  try {
    return await invoke<EmbedStatus>("embed_status");
  } catch {
    return null;
  }
}

/** How many unread files {@link indexUnreadNotice} names; the rest are counted. */
const UNREAD_NAMED = 3;

/**
 * Says which library files a reindex could not read (not UTF-8, larger than
 * 16 MiB, not a regular file), so the "My library" chat is not trusted to
 * know them: they used to be left out of the index in silence. Null when
 * every file was read, or the result predates `unread`.
 */
export function indexUnreadNotice(result: IndexResult | null): string | null {
  const unread = result?.unread ?? [];
  if (unread.length === 0) return null;
  const named = unread
    .slice(0, UNREAD_NAMED)
    .map(({ path, reason }) => {
      // The reason's first sentence, without its leading "it is".
      const why = (reason.split(". ")[0] ?? reason).replace(/^it is /, "");
      return `${path} (${why})`;
    })
    .join("; ");
  const rest = unread.length - Math.min(unread.length, UNREAD_NAMED);
  const more = rest > 0 ? `; and ${rest} more` : "";
  const count = unread.length === 1 ? "1 file was" : `${unread.length} files were`;
  const fix = unread.some((u) => u.reason.includes("UTF-8"))
    ? " Convert a file that is not UTF-8 to UTF-8 to index it."
    : "";
  return `${count} not indexed because ${unread.length === 1 ? "it" : "they"} could not be read: ${named}${more}.${fix}`;
}
