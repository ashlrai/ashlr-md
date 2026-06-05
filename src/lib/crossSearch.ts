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

export async function searchFiles(
  paths: string[],
  query: string,
  limit?: number,
): Promise<FileSearchResult[]> {
  if (!query.trim() || paths.length === 0) return [];
  try {
    return await invoke<FileSearchResult[]>("search_files", { paths, query, limit });
  } catch {
    return [];
  }
}
