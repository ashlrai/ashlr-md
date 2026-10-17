import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri bridge so the store runs in plain Node/happy-dom.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { type PendingReview, useReviewStore } from "./reviewStore";

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
  useReviewStore.setState({
    pending: null,
    draftComment: "",
    submitting: false,
    submitError: null,
  });
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

  it("submitVerdict keeps the panel open with the error when recording fails", async () => {
    invokeMock.mockRejectedValueOnce("Review rev-001 not found");
    useReviewStore.getState().registerReview(makePending());
    useReviewStore.getState().setDraftComment("minor nits");
    await useReviewStore.getState().submitVerdict("approved");
    let s = useReviewStore.getState();
    expect(s.pending?.reviewId).toBe("rev-001");
    expect(s.draftComment).toBe("minor nits");
    expect(s.submitting).toBe(false);
    expect(s.submitError).toContain("not recorded");
    expect(s.submitError).toContain("Review rev-001 not found");

    // The human retries, and this time it is recorded.
    invokeMock.mockResolvedValueOnce(undefined);
    await useReviewStore.getState().submitVerdict("approved");
    s = useReviewStore.getState();
    expect(s.pending).toBeNull();
    expect(s.submitError).toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("submitVerdict leaves a review that replaced it while in flight alone", async () => {
    let fail: (e: unknown) => void = () => {};
    invokeMock.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    useReviewStore.getState().registerReview(makePending({ reviewId: "old" }));
    const submitted = useReviewStore.getState().submitVerdict("approved");
    expect(useReviewStore.getState().submitting).toBe(true);
    useReviewStore.getState().registerReview(makePending({ reviewId: "new" }));
    fail("gone");
    await submitted;
    const s = useReviewStore.getState();
    expect(s.pending?.reviewId).toBe("new");
    expect(s.submitError).toBeNull();
    expect(s.submitting).toBe(false);
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

  // ── Expire ───────────────────────────────────────────────────────────────

  it("expire(reviewId) clears pending and records a timeout verdict", () => {
    invokeMock.mockResolvedValue(undefined);
    useReviewStore.getState().registerReview(makePending());
    useReviewStore.getState().setDraftComment("half-typed");
    useReviewStore.getState().expire("rev-001");
    expect(useReviewStore.getState().pending).toBeNull();
    expect(useReviewStore.getState().draftComment).toBe("");
    expect(invokeMock).toHaveBeenCalledWith("set_review_verdict", {
      reviewId: "rev-001",
      verdict: "timeout",
      comments: null,
    });
  });

  it("expire with a stale reviewId leaves the newer review alone", () => {
    useReviewStore.getState().registerReview(makePending({ reviewId: "current" }));
    useReviewStore.getState().expire("old-id");
    expect(useReviewStore.getState().pending?.reviewId).toBe("current");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
