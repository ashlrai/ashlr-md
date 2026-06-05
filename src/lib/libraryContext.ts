/**
 * libraryContext.ts — "chat with your whole library" retrieval (RAG-lite).
 *
 * Grounds AI answers in the user's own Markdown corpus (recent + watched files)
 * by retrieving the most relevant excerpts and citing their source files. The
 * compounding data moat: every doc an agent drops in makes answers better.
 *
 * Retrieval runs in Rust (`search_files`) over keyword terms extracted from the
 * question — fully local, works for every provider. (Semantic embeddings are a
 * future enhancement; keyword retrieval is the dependency-free baseline.)
 */

import { useActivityStore } from "../store/activityStore";
import { useRecentStore } from "../store/recentStore";
import { searchFiles } from "./crossSearch";

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "was",
  "were",
  "what",
  "which",
  "who",
  "how",
  "why",
  "where",
  "when",
  "this",
  "that",
  "with",
  "from",
  "have",
  "has",
  "had",
  "you",
  "your",
  "can",
  "could",
  "would",
  "should",
  "about",
  "into",
  "over",
  "does",
  "did",
  "doing",
  "give",
  "tell",
  "show",
  "find",
  "please",
  "explain",
]);

export interface LibraryCitation {
  fileName: string;
  path: string;
}

export interface LibraryContext {
  block: string;
  citations: LibraryCitation[];
}

/** Extract up to 6 meaningful query terms (lowercased, stopwords removed). */
function keywords(query: string): string[] {
  const seen = new Set<string>();
  for (const w of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length > 2 && !STOPWORDS.has(w)) {
      seen.add(w);
      // Break only once 6 REAL terms are collected (not after 6 stopword tokens).
      if (seen.size >= 6) break;
    }
  }
  return Array.from(seen);
}

const MAX_CITED_FILES = 5;
const SNIPPETS_PER_FILE = 4;

/**
 * Retrieve the most relevant excerpts from the user's library for `query`.
 * Returns an empty context when there's nothing to search or no match.
 */
export async function retrieveLibraryContext(
  query: string,
  excludePaths: string[] = [],
): Promise<LibraryContext> {
  const exclude = new Set(excludePaths);
  const paths = new Set<string>();
  for (const r of useRecentStore.getState().recents) {
    if (!exclude.has(r.path)) paths.add(r.path);
  }
  for (const f of useActivityStore.getState().files) {
    if (!exclude.has(f.path)) paths.add(f.path);
  }
  const pathList = Array.from(paths);
  if (pathList.length === 0) return { block: "", citations: [] };

  const terms = keywords(query);
  if (terms.length === 0) return { block: "", citations: [] };

  // Search all terms concurrently (independent), then aggregate by file.
  const byFile = new Map<
    string,
    { fileName: string; snippets: string[]; score: number }
  >();
  const perTerm = await Promise.all(
    terms.map((term) => searchFiles(pathList, term, 50)),
  );
  for (const results of perTerm) {
    for (const r of results) {
      const entry = byFile.get(r.path) ?? {
        fileName: r.fileName,
        snippets: [],
        score: 0,
      };
      entry.score += r.matches.length;
      for (const m of r.matches.slice(0, 2)) entry.snippets.push(m.snippet);
      byFile.set(r.path, entry);
    }
  }

  const ranked = Array.from(byFile.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, MAX_CITED_FILES);
  if (ranked.length === 0) return { block: "", citations: [] };

  const block =
    "Relevant excerpts from the user's Markdown library:\n\n" +
    ranked
      .map(
        ([, e]) =>
          `### ${e.fileName}\n${e.snippets.slice(0, SNIPPETS_PER_FILE).join("\n")}`,
      )
      .join("\n\n");
  const citations = ranked.map(([path, e]) => ({ fileName: e.fileName, path }));
  return { block, citations };
}
