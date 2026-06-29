/**
 * MCP review handler — registers human review requests from agents.
 *
 * Exported function registers a single `listen()` call and returns the
 * resulting Promise<UnlistenFn> so the bridge can collect them for cleanup.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useReviewStore } from "../../store/reviewStore";
import type { ReviewPayload } from "./types";

// ── mcp://review ──────────────────────────────────────────────────────────────

export function handleRequestReview(): Promise<UnlistenFn> {
  return listen<ReviewPayload>("mcp://review", (e) => {
    const { reviewId, path, content, timeoutMs } = e.payload;
    useReviewStore.getState().registerReview({
      reviewId,
      path,
      content,
      timeoutMs,
      registeredAt: Date.now(),
    });
  });
}
