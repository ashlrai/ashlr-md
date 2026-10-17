/**
 * reviewStore.ts — the human side of the agent review loop.
 *
 * When an agent calls the `request_review` MCP tool, the Rust IPC server emits
 * `mcp://review`; the bridge registers it here and the ReviewPanel appears. The
 * human's Approve / Request-changes / Dismiss verdict is recorded via the
 * `set_review_verdict` command, which the agent's polling MCP tool picks up.
 * When the countdown runs out with no decision, `expire` records `timeout`.
 */

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export type ReviewVerdict = "approved" | "changes_requested" | "dismissed";

export interface PendingReview {
  reviewId: string;
  path: string | null;
  content: string | null;
  timeoutMs: number;
  /** Date.now() when the review was registered (for the countdown). */
  registeredAt: number;
}

interface ReviewState {
  pending: PendingReview | null;
  draftComment: string;
  /** True while a verdict is being recorded; the panel disables its buttons. */
  submitting: boolean;
  /**
   * Why the last verdict was not recorded. The panel stays open showing it,
   * with the comment kept, so the human can retry.
   */
  submitError: string | null;
  registerReview: (review: PendingReview) => void;
  setDraftComment: (text: string) => void;
  submitVerdict: (verdict: ReviewVerdict) => Promise<void>;
  /**
   * Dismiss the pending review. Pass the `reviewId` it's meant to dismiss (e.g.
   * from an expiring countdown) so a late firing can't dismiss a *newer* review
   * that has since replaced it.
   */
  dismiss: (reviewId?: string) => void;
  /**
   * The review window closed with no decision: record `timeout` (not
   * `dismissed`, which means the human closed the panel) and hide the panel.
   * Ignored unless `reviewId` is still the pending review.
   */
  expire: (reviewId: string) => void;
}

export const useReviewStore = create<ReviewState>((set, get) => ({
  pending: null,
  draftComment: "",
  submitting: false,
  submitError: null,

  registerReview: (review) =>
    set({ pending: review, draftComment: "", submitting: false, submitError: null }),
  setDraftComment: (draftComment) => set({ draftComment }),

  submitVerdict: async (verdict) => {
    const { pending, draftComment, submitting } = get();
    if (!pending || submitting) return;
    set({ submitting: true, submitError: null });
    let error: string | null = null;
    try {
      await invoke("set_review_verdict", {
        reviewId: pending.reviewId,
        verdict,
        comments: draftComment.trim() || null,
      });
    } catch (e) {
      error = `Your verdict was not recorded (${String(e)}). Try again, or dismiss the review.`;
    }
    // A newer review may have replaced this one while the verdict was in
    // flight; leave that one alone.
    if (get().pending?.reviewId !== pending.reviewId) return;
    if (error === null) {
      set({ pending: null, draftComment: "", submitting: false, submitError: null });
    } else {
      // Keep the panel (and the comment) so the human can retry.
      set({ submitting: false, submitError: error });
    }
  },

  dismiss: (reviewId?: string) => close(reviewId, "dismissed"),
  expire: (reviewId: string) => close(reviewId, "timeout"),
}));

/**
 * Record `verdict` for the pending review without a comment and hide the
 * panel, so the agent's poll exits promptly.
 */
function close(reviewId: string | undefined, verdict: "dismissed" | "timeout") {
  const { pending } = useReviewStore.getState();
  if (!pending) return;
  // Only act if the caller's target is still the pending review — guards a
  // stale countdown from closing a review the human hasn't seen yet.
  if (reviewId && reviewId !== pending.reviewId) return;
  void invoke("set_review_verdict", {
    reviewId: pending.reviewId,
    verdict,
    comments: null,
  }).catch(() => {});
  useReviewStore.setState({
    pending: null,
    draftComment: "",
    submitting: false,
    submitError: null,
  });
}
