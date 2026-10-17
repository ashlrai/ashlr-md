import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useReviewStore } from "../../store/reviewStore";
import { ReviewPanel } from "./ReviewPanel";

// React only flushes act() updates when this flag is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ReviewPanel countdown", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    useReviewStore.setState({ pending: null, draftComment: "" });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("records timeout, not dismissed, when the window runs out untouched", () => {
    useReviewStore.getState().registerReview({
      reviewId: "rev-1",
      path: "/notes/plan.md",
      content: null,
      timeoutMs: 3_000,
      registeredAt: Date.now(),
    });
    act(() => root.render(createElement(ReviewPanel)));
    expect(host.textContent).toContain("plan.md");

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(invokeMock).toHaveBeenCalledWith("set_review_verdict", {
      reviewId: "rev-1",
      verdict: "timeout",
      comments: null,
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "set_review_verdict",
      expect.objectContaining({ verdict: "dismissed" }),
    );
    expect(useReviewStore.getState().pending).toBeNull();
  });

  it("stays open and shows the error when the verdict is not recorded", async () => {
    invokeMock.mockRejectedValueOnce("Review rev-2 not found");
    useReviewStore.getState().registerReview({
      reviewId: "rev-2",
      path: "/notes/plan.md",
      content: null,
      timeoutMs: 60_000,
      registeredAt: Date.now(),
    });
    act(() => root.render(createElement(ReviewPanel)));
    const approve = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Approve",
    );
    expect(approve).toBeDefined();
    await act(async () => {
      approve!.click();
    });
    expect(useReviewStore.getState().pending?.reviewId).toBe("rev-2");
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("not recorded");
    expect(alert?.textContent).toContain("Review rev-2 not found");
    expect(approve!.disabled).toBe(false);
  });

  // A review of inline `content` has no file to open. The panel used to say
  // "review of inline content" without showing it, so the human approved
  // text they never saw.
  it("shows inline content under review, and nothing extra for a path", () => {
    useReviewStore.getState().registerReview({
      reviewId: "rev-3",
      path: null,
      content: "# Plan\n\n1. Drop the users table",
      timeoutMs: 60_000,
      registeredAt: Date.now(),
    });
    act(() => root.render(createElement(ReviewPanel)));
    const shown = host.querySelector('[aria-label="Content to review"]');
    expect(shown?.textContent).toBe("# Plan\n\n1. Drop the users table");
    expect(host.textContent).toContain("inline content");

    act(() =>
      useReviewStore.getState().registerReview({
        reviewId: "rev-4",
        path: "/notes/plan.md",
        content: null,
        timeoutMs: 60_000,
        registeredAt: Date.now(),
      }),
    );
    expect(host.querySelector('[aria-label="Content to review"]')).toBeNull();
  });
});
