import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri bridge so the store runs in plain Node/happy-dom.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useReviewStore, type PendingReview } from "./reviewStore";

function makePending(overrides?: Partial<PendingReview>): PendingReview {
  return {
    reviewId: "rev-001",
    path: "/project/plan.md",
    content: "## Draft plan",
    timeoutMs: 30_000,
    registeredAt: Date.now(),
    ...overrides,
  };
}

function reset() {
  useReviewStore.setState({ pending: null, draftComment: "" });
}

describe("reviewStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    reset();
  });

  // ── Register ────────────────────────────────────────────────────────────

  it("registerReview stores the review and clears any draft comment", () => {
    useReviewStore.setState({ draftComment: "leftover" });
    useReviewStore.getState().registerReview(makePending());
    const s = useReviewStore.getState();
    expect(s.pending?.reviewId).toBe("rev-001");
    expect(s.draftComment).toBe("");
  });

  it("registerReview replaces a previously registered review", () => {
    useReviewStore.getState().registerReview(makePending({ reviewId: "old" }));
    useReviewStore.getState().registerReview(makePending({ reviewId: "new" }));
    expect(useReviewStore.getState().pending?.reviewId).toBe("new");
  });

  // ── Draft comment ────────────────────────────────────────────────────────

  it("setDraftComment updates draftComment", () => {
    useReviewStore.getState().setDraftComment("looks good");
    expect(useReviewStore.getState().draftComment).toBe("looks good");
  });

  // ── Submit verdict ───────────────────────────────────────────────────────

  it("submitVerdict clears pending + draft and invokes set_review_verdict", async () => {
    invokeMock.mockResolvedValue(undefined);
    useReviewStore.getState().registerReview(makePending());
    useReviewStore.getState().setDraftComment("minor nits");
    await useReviewStore.getState().submitVerdict("approved");
    expect(useReviewStore.getState().pending).toBeNull();
    expect(useReviewStore.getState().draftComment).toBe("");
    expect(invokeMock).toHaveBeenCalledWith("set_review_verdict", {
      reviewId: "rev-001",
      verdict: "approved",
      comments: "minor nits",
    });
  });

  it("submitVerdict passes null comments when draft is empty", async () => {
    invokeMock.mockResolvedValue(undefined);
    useReviewStore.getState().registerReview(makePending());
    await useReviewStore.getState().submitVerdict("changes_requested");
    expect(invokeMock).toHaveBeenCalledWith("set_review_verdict", {
      reviewId: "rev-001",
      verdict: "changes_requested",
      comments: null,
    });
  });

  it("submitVerdict is a no-op when there is no pending review", async () => {
    await useReviewStore.getState().submitVerdict("approved");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  // ── Dismiss ──────────────────────────────────────────────────────────────

  it("dismiss(reviewId) clears pending and records a dismissed verdict", () => {
    invokeMock.mockResolvedValue(undefined);
    useReviewStore.getState().registerReview(makePending());
    useReviewStore.getState().dismiss("rev-001");
    expect(useReviewStore.getState().pending).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("set_review_verdict", {
      reviewId: "rev-001",
      verdict: "dismissed",
      comments: null,
    });
  });

  it("dismiss with stale reviewId does NOT dismiss the current review", () => {
    invokeMock.mockResolvedValue(undefined);
    useReviewStore.getState().registerReview(makePending({ reviewId: "current" }));
    useReviewStore.getState().dismiss("old-id");
    expect(useReviewStore.getState().pending?.reviewId).toBe("current");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("dismiss with no reviewId dismisses unconditionally", () => {
    invokeMock.mockResolvedValue(undefined);
    useReviewStore.getState().registerReview(makePending());
    useReviewStore.getState().dismiss();
    expect(useReviewStore.getState().pending).toBeNull();
  });

  it("dismiss is a no-op when there is no pending review", () => {
    useReviewStore.getState().dismiss("nonexistent");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
