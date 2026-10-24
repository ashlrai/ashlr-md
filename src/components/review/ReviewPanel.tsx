/**
 * ReviewPanel.tsx — the human-in-the-loop review surface.
 *
 * Appears as a bottom bar when an agent requests review (via the request_review
 * MCP tool). The human reads the opened doc (or, for a review of inline
 * `content`, the text shown in the panel), optionally comments, and clicks
 * Approve / Request changes — the verdict flows back to the agent. A live
 * countdown shows the agent's timeout; on expiry the panel records `timeout`
 * and closes.
 */

import { useEffect, useRef, useState } from "react";
import { isDismissEscape } from "../../lib/keymap";
import { useReturnFocus } from "../../lib/useReturnFocus";
import { useReviewStore } from "../../store/reviewStore";
import "../../styles/review.css";

function fileNameOf(path: string | null): string {
  if (!path) return "inline content";
  const sep = path.includes("\\") ? "\\" : "/";
  return path.slice(path.lastIndexOf(sep) + 1) || path;
}

export function ReviewPanel() {
  const pending = useReviewStore((s) => s.pending);
  const draftComment = useReviewStore((s) => s.draftComment);
  const setDraftComment = useReviewStore((s) => s.setDraftComment);
  const submitVerdict = useReviewStore((s) => s.submitVerdict);
  const submitting = useReviewStore((s) => s.submitting);
  const submitError = useReviewStore((s) => s.submitError);
  const dismiss = useReviewStore((s) => s.dismiss);
  const expire = useReviewStore((s) => s.expire);

  const panelRef = useRef<HTMLDivElement>(null);
  // Move focus to the panel when a review appears (keyed on reviewId so a new
  // review while one is showing re-focuses) so keyboard/AT users are taken to it.
  const reviewId = pending?.reviewId;
  // Once decided (or timed out), the panel is gone: focus goes back to what
  // had it before the review took it, instead of falling to the page.
  useReturnFocus(reviewId !== undefined, panelRef);
  useEffect(() => {
    if (reviewId) panelRef.current?.focus();
  }, [reviewId]);

  if (!pending) return null;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="review-panel"
      role="alertdialog"
      aria-label={`An agent is requesting your review of ${fileNameOf(pending.path)}`}
      onKeyDown={(e) => {
        // Escape that ends an IME composition (or cancels a candidate) in the
        // comment box is the input method's, not a dismissal: it used to
        // record `dismissed` for the agent and drop the comment being typed.
        if (isDismissEscape(e)) {
          e.stopPropagation();
          dismiss();
        }
      }}
    >
      <div className="review-panel__head">
        <span className="review-panel__title">
          <span className="review-panel__spark" aria-hidden="true">
            ⚑
          </span>
          An agent is requesting your review of{" "}
          <strong>{fileNameOf(pending.path)}</strong>
        </span>
        <ReviewCountdown
          reviewId={pending.reviewId}
          registeredAt={pending.registeredAt}
          timeoutMs={pending.timeoutMs}
          onExpire={expire}
        />
        <button
          type="button"
          className="review-panel__close"
          onClick={() => dismiss()}
          aria-label="Dismiss review"
        >
          ✕
        </button>
      </div>

      {/* Inline content has no file to open, so the panel shows it: it used
          to say "review of inline content" without showing the text, and the
          human approved what they never saw (or the unrelated open doc). */}
      {!pending.path && pending.content !== null && (
        <section aria-label="Content to review">
          <pre className="review-panel__content">{pending.content || "(empty)"}</pre>
        </section>
      )}

      <textarea
        className="review-panel__comment"
        placeholder="Comments for the agent (optional)…"
        value={draftComment}
        onChange={(e) => setDraftComment(e.target.value)}
        rows={2}
        aria-label="Review comments"
      />

      {submitError && (
        <p className="review-panel__error" role="alert">
          {submitError}
        </p>
      )}

      <div className="review-panel__actions">
        <button
          type="button"
          className="review-panel__btn review-panel__btn--changes"
          disabled={submitting}
          onClick={() => void submitVerdict("changes_requested")}
        >
          Request changes
        </button>
        <button
          type="button"
          className="review-panel__btn review-panel__btn--approve"
          disabled={submitting}
          onClick={() => void submitVerdict("approved")}
        >
          Approve
        </button>
      </div>
    </div>
  );
}

function ReviewCountdown({
  reviewId,
  registeredAt,
  timeoutMs,
  onExpire,
}: {
  reviewId: string;
  registeredAt: number;
  timeoutMs: number;
  onExpire: (reviewId: string) => void;
}) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, timeoutMs - (Date.now() - registeredAt)),
  );

  useEffect(() => {
    let alive = true;
    // Reset the displayed value immediately when a new review replaces the
    // pending one (the useState initializer only runs on first mount).
    setRemaining(Math.max(0, timeoutMs - (Date.now() - registeredAt)));
    const tick = setInterval(() => {
      if (!alive) return;
      const r = Math.max(0, timeoutMs - (Date.now() - registeredAt));
      setRemaining(r);
      if (r === 0) {
        clearInterval(tick);
        onExpire(reviewId);
      }
    }, 1000);
    return () => {
      alive = false;
      clearInterval(tick);
    };
  }, [reviewId, registeredAt, timeoutMs, onExpire]);

  const m = Math.floor(remaining / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  // A screen reader used to read the bare "4:59". The label says what it is,
  // in words; `timer` keeps it out of live announcements (it would otherwise
  // speak every second), so it is read when the user reaches it.
  return (
    <span
      className="review-panel__countdown"
      role="timer"
      aria-live="off"
      aria-label={countdownLabel(remaining)}
    >
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

/** "Time left to review: 4 minutes 59 seconds" for the countdown's label. */
export function countdownLabel(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (m > 0) parts.push(unit(m, "minute"));
  if (s > 0 || m === 0) parts.push(unit(s, "second"));
  return `Time left to review: ${parts.join(" ")}`;
}
