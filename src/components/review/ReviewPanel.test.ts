import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useReviewStore } from "../../store/reviewStore";
import { countdownLabel, ReviewPanel } from "./ReviewPanel";

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

  // Escape pressed to end an IME composition in the comment box bubbled to
  // the panel and dismissed the review, dropping the comment.
  it("does not dismiss on an Escape that ends an IME composition", () => {
    useReviewStore.getState().registerReview({
      reviewId: "rev-5",
      path: "/notes/plan.md",
      content: null,
      timeoutMs: 60_000,
      registeredAt: Date.now(),
    });
    act(() => root.render(createElement(ReviewPanel)));
    act(() => useReviewStore.getState().setDraftComment("\u5909\u63db"));
    const comment = host.querySelector("textarea");
    expect(comment).not.toBeNull();
    act(() => {
      comment!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          isComposing: true,
          bubbles: true,
        }),
      );
    });
    expect(useReviewStore.getState().pending?.reviewId).toBe("rev-5");
    expect(useReviewStore.getState().draftComment).toBe("\u5909\u63db");
    expect(invokeMock).not.toHaveBeenCalled();

    act(() => {
      comment!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(invokeMock).toHaveBeenCalledWith("set_review_verdict", {
      reviewId: "rev-5",
      verdict: "dismissed",
      comments: null,
    });
    expect(useReviewStore.getState().pending).toBeNull();
  });

  // The countdown was read as a bare "4:59", with nothing saying what it
  // counts. It now has a label in words, and stays out of live announcements.
  it("labels the countdown in words without announcing every tick", () => {
    useReviewStore.getState().registerReview({
      reviewId: "rev-6",
      path: "/notes/plan.md",
      content: null,
      timeoutMs: 300_000,
      registeredAt: Date.now(),
    });
    act(() => root.render(createElement(ReviewPanel)));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    const timer = host.querySelector('[role="timer"]');
    expect(timer).not.toBeNull();
    expect(timer!.textContent).toBe("4:59");
    expect(timer!.getAttribute("aria-label")).toBe(
      "Time left to review: 4 minutes 59 seconds",
    );
    expect(timer!.getAttribute("aria-live")).toBe("off");
  });
});

describe("countdownLabel", () => {
  it("says the time left in words, singular where it is one", () => {
    expect(countdownLabel(300_000)).toBe("Time left to review: 5 minutes");
    expect(countdownLabel(61_000)).toBe("Time left to review: 1 minute 1 second");
    expect(countdownLabel(59_999)).toBe("Time left to review: 59 seconds");
    expect(countdownLabel(0)).toBe("Time left to review: 0 seconds");
    expect(countdownLabel(-5)).toBe("Time left to review: 0 seconds");
  });
});

describe("ReviewPanel focus", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    useReviewStore.setState({ pending: null, draftComment: "" });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("gives focus back to what had it once the review is decided", async () => {
    // The panel takes focus when a review arrives, and unmounted with it:
    // focus fell to the page.
    const editor = document.createElement("textarea");
    document.body.appendChild(editor);
    editor.focus();
    act(() => root.render(createElement(ReviewPanel)));
    act(() => {
      useReviewStore.getState().registerReview({
        reviewId: "rev-f",
        path: "/notes/plan.md",
        content: null,
        timeoutMs: 60_000,
        registeredAt: Date.now(),
      });
    });
    const panel = host.querySelector<HTMLElement>(".review-panel");
    expect(document.activeElement).toBe(panel);
    const approve = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Approve",
    );
    await act(async () => {
      approve?.click();
    });
    expect(useReviewStore.getState().pending).toBeNull();
    expect(document.activeElement).toBe(editor);
  });
});
