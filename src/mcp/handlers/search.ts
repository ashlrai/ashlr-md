/**
 * MCP search handlers — batch-read, batch-edit (disk), semantic-search,
 * and diff-docs.
 *
 * Each exported function registers a single `listen()` call and returns the
 * resulting Promise<UnlistenFn> so the bridge can collect them for cleanup.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { searchFiles } from "../../lib/crossSearch";
import { embedSearch, embedAvailable } from "../../lib/embedSearch";
import { useActivityStore } from "../../store/activityStore";
import type {
  BatchReadFileResult,
  BatchReadPayload,
  DiffDocsPayload,
  SemanticSearchPayload,
} from "./types";

// ── mcp://batch-read ──────────────────────────────────────────────────────────

export function handleBatchRead(): Promise<UnlistenFn> {
  return listen<BatchReadPayload>("mcp://batch-read", async (e) => {
    const { batchId, paths } = e.payload;
    try {
      const results = await invoke<BatchReadFileResult[]>("read_batch_files", { paths });
      await invoke("mcp_batch_read_result", {
        batchId,
        ok: true,
        results,
        error: null,
      }).catch(() => {/* non-fatal */});
    } catch (err) {
      const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
      await invoke("mcp_batch_read_result", {
        batchId,
        ok: false,
        results: [],
        error: errStr,
      }).catch(() => {/* non-fatal */});
    }
  });
}

// ── mcp://semantic-search ─────────────────────────────────────────────────────

export function handleSemanticSearch(): Promise<UnlistenFn> {
  return listen<SemanticSearchPayload>("mcp://semantic-search", async (e) => {
    const { searchId, query, k = 10, rerank = true } = e.payload;
    try {
      const modelAvailable = await embedAvailable();
      const { files } = useActivityStore.getState();
      const vaultPaths = files.map((f) => f.path);

      type SearchResultItem = {
        path: string;
        fileName: string;
        snippet: string;
        score: number;
        source: "semantic" | "keyword";
      };

      let results: SearchResultItem[] = [];

      if (modelAvailable) {
        const semanticHits = await embedSearch(query, k * 2);
        results = semanticHits.map((h) => ({
          path: h.path,
          fileName: h.fileName,
          snippet: h.snippet,
          score: h.score,
          source: "semantic" as const,
        }));

        if (rerank && vaultPaths.length > 0) {
          const keywordHits = await searchFiles(vaultPaths, query, k * 2);

          const semanticRank = new Map<string, number>();
          results.forEach((r, i) => semanticRank.set(r.path, i + 1));

          const keywordRank = new Map<string, number>();
          keywordHits.forEach((r, i) => keywordRank.set(r.path, i + 1));

          const RRF_K = 60;
          const rrfScore = (path: string): number => {
            const sr = semanticRank.get(path);
            const kr = keywordRank.get(path);
            return (sr ? 1 / (RRF_K + sr) : 0) + (kr ? 1 / (RRF_K + kr) : 0);
          };

          for (const kh of keywordHits) {
            if (!semanticRank.has(kh.path)) {
              results.push({
                path: kh.path,
                fileName: kh.fileName,
                snippet: kh.matches[0]?.snippet ?? "",
                score: 0,
                source: "keyword",
              });
            }
          }

          results.sort((a, b) => rrfScore(b.path) - rrfScore(a.path));
        }
      } else {
        const keywordHits = await searchFiles(vaultPaths, query, k);
        results = keywordHits.map((h, i) => ({
          path: h.path,
          fileName: h.fileName,
          snippet: h.matches[0]?.snippet ?? "",
          score: 1 / (i + 1),
          source: "keyword" as const,
        }));
      }

      const trimmed = results.slice(0, k);

      await invoke("mcp_semantic_search_result", {
        searchId,
        ok: true,
        results: trimmed,
        usedEmbeddings: !!modelAvailable,
        error: null,
      }).catch(() => {/* non-fatal */});
    } catch (err) {
      const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
      await invoke("mcp_semantic_search_result", {
        searchId,
        ok: false,
        results: [],
        usedEmbeddings: false,
        error: errStr,
      }).catch(() => {/* non-fatal */});
    }
  });
}

// ── mcp://diff-docs ───────────────────────────────────────────────────────────

export function handleDiffDocs(): Promise<UnlistenFn> {
  return listen<DiffDocsPayload>("mcp://diff-docs", async (e) => {
    const { diffId, pathA, pathB, contextLines = 3 } = e.payload;
    try {
      const result = await invoke<{
        diff: string;
        hunks: number;
        added: number;
        removed: number;
        path_a: string;
        path_b: string;
      }>("mcp_diff_docs", {
        pathA,
        pathB,
        contextLines,
      });
      await invoke("mcp_diff_docs_result", {
        diffId,
        ok: true,
        diff: result.diff,
        hunks: result.hunks,
        added: result.added,
        removed: result.removed,
        pathA: result.path_a,
        pathB: result.path_b,
        error: null,
      }).catch(() => {/* non-fatal */});
    } catch (err) {
      const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
      await invoke("mcp_diff_docs_result", {
        diffId,
        ok: false,
        diff: "",
        hunks: 0,
        added: 0,
        removed: 0,
        pathA,
        pathB,
        error: errStr,
      }).catch(() => {/* non-fatal */});
    }
  });
}
