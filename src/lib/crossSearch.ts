/**
 * crossSearch.ts — typed wrapper around the Rust `search_files` command.
 *
 * Searches recent documents (and the watched folder) for a query, returning
 * per-file line matches with snippets. The actual file reads happen in Rust.
 */

import { invoke } from "@tauri-apps/api/core";

export interface SearchMatch {
  lineNo: number;
  snippet: string;
}

export interface FileSearchResult {
  path: string;
  fileName: string;
  matches: SearchMatch[];
}

/**
 * Search `paths` for `query`. Rejects with the reason when the search
 * itself fails, so the file search can say so instead of showing "0
 * matches" (see {@link searchFiles} for the lenient form).
 */
export async function searchFilesOrThrow(
  paths: string[],
  query: string,
  limit?: number,
): Promise<FileSearchResult[]> {
  if (!query.trim() || paths.length === 0) return [];
  return await invoke<FileSearchResult[]>("search_files", { paths, query, limit });
}

/**
 * {@link searchFilesOrThrow}, with a failure taken as no matches: for
 * retrieval (AI library context) that degrades to no excerpts.
 */
export async function searchFiles(
  paths: string[],
  query: string,
  limit?: number,
): Promise<FileSearchResult[]> {
  try {
    return await searchFilesOrThrow(paths, query, limit);
  } catch {
    return [];
  }
}
