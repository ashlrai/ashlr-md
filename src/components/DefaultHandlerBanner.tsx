/**
 * DefaultHandlerBanner.tsx
 *
 * A slim, dismissible top banner shown ONLY when Ashlr MD is *definitively* not
 * the default app for `.md` files and the user hasn't snoozed/dismissed it.
 *
 * Key correctness rule: detection is tri-state (`default` | `not-default` |
 * `unknown`).  The banner must NEVER show on `unknown` — that's the bug where
 * the prompt appeared even when the app already was the default but detection
 * couldn't run (e.g. helper binary missing, dev build).  It also re-checks on
 * window focus so it self-heals after the user confirms in System Settings.
 *
 * Mount in Shell.tsx immediately after <ExternalChangeBanner />.  Styling
 * reuses the existing `.change-banner` family defined in global.css.
 */

import { useCallback, useEffect, useState } from "react";
import {
  type DefaultHandlerStatus,
  defaultHandlerStatus,
  openDefaultAppsHelp,
  setDefaultMdHandler,
} from "../lib/defaultHandler";
import { isDefaultPromptSnoozed, useSettingsStore } from "../store/settingsStore";

// ---------------------------------------------------------------------------
// Status type for the async "Make Default" action
// ---------------------------------------------------------------------------

type ActionStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  // Windows / fallback: the registry write or help page opened, but the OS
  // requires the user to confirm in Settings before we become the default.
  | { kind: "pending-confirm" }
  | { kind: "success" }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Inline icons — no extra icon library dependency
// ---------------------------------------------------------------------------

function CheckCircleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4.5 7l2 2 3-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      className="dh-banner-spinner"
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="7"
        cy="7"
        r="5.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="18 16"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DefaultHandlerBanner() {
  const snoozedUntil = useSettingsStore((s) => s.defaultPromptSnoozedUntil);
  const snooze = useSettingsStore((s) => s.snoozeDefaultPrompt);
  const neverAsk = useSettingsStore((s) => s.neverAskDefault);

  const [status, setStatus] = useState<DefaultHandlerStatus | null>(null);
  const [action, setAction] = useState<ActionStatus>({ kind: "idle" });

  const snoozed = isDefaultPromptSnoozed(snoozedUntil);

  // Re-check on mount AND whenever the window regains focus / becomes visible.
  // This is what makes the banner self-heal after the user sets the default in
  // System Settings and tabs back to the app.
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      defaultHandlerStatus().then((s) => {
        if (cancelled) return;
        setStatus(s);
        // Only advance to the success confirmation if we were actively waiting
        // for the user to confirm (Windows). A passive re-check on an already-
        // default machine must NOT flash the banner on every window focus.
        setAction((prev) =>
          s.state === "default" && prev.kind === "pending-confirm"
            ? { kind: "success" }
            : prev,
        );
      });
    };
    check();
    const onFocus = () => check();
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // A confirmed success briefly shows "Set as default!" then the banner hides
  // (status is now `default`, so the base condition stops rendering it).
  useEffect(() => {
    if (action.kind !== "success") return;
    const t = setTimeout(() => setAction({ kind: "idle" }), 2200);
    return () => clearTimeout(t);
  }, [action.kind]);

  const handleMakeDefault = useCallback(async () => {
    setAction({ kind: "busy" });
    try {
      await setDefaultMdHandler();
      // Re-verify. macOS/Linux flip to `default` immediately; Windows stays
      // `not-default` until the user confirms in the Settings page we opened.
      const s = await defaultHandlerStatus();
      setStatus(s);
      setAction(
        s.state === "default" ? { kind: "success" } : { kind: "pending-confirm" },
      );
    } catch (e) {
      const message =
        typeof e === "string"
          ? e
          : ((e as Error)?.message ?? "An unknown error occurred.");
      setAction({ kind: "error", message });
    }
  }, []);

  const handleHelp = useCallback(() => {
    void openDefaultAppsHelp();
    setAction({ kind: "pending-confirm" });
  }, []);

  const succeeded = action.kind === "success";
  const transient =
    action.kind === "busy" ||
    action.kind === "pending-confirm" ||
    action.kind === "error" ||
    succeeded;

  // Base visibility: a DEFINITIVE not-default that isn't snoozed. `unknown` and
  // `default` never trigger the prompt. Transient action states keep the banner
  // up long enough to show progress/confirmation/errors.
  const baseVisible = status?.state === "not-default" && !snoozed;
  if (!baseVisible && !transient) return null;

  const busy = action.kind === "busy";
  const pendingConfirm = action.kind === "pending-confirm";
  const canSet = status?.canSet ?? false;

  return (
    <>
      {/* Inline styles are scoped to this component and avoid a separate CSS file. */}
      <style>{`
        @keyframes dh-banner-spin {
          to { transform: rotate(360deg); }
        }
        .dh-banner-spinner {
          animation: dh-banner-spin 0.7s linear infinite;
          flex: 0 0 auto;
        }
        .dh-banner-success-msg {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          color: var(--accent);
          font-size: 12px;
          font-weight: 600;
        }
        .dh-banner-error-msg {
          font-size: 11.5px;
          color: #d1242f;
          max-width: 320px;
          line-height: 1.4;
        }
        .dh-banner-link {
          background: none;
          border: none;
          padding: 0 2px;
          font-size: 11px;
          color: var(--text-muted, #8a8a8a);
          cursor: pointer;
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .dh-banner-link:hover { color: var(--text, #333); }
      `}</style>

      <div className="change-banner" role="status" aria-live="polite">
        <span className="change-banner-text">
          {action.kind === "error" ? (
            <span className="dh-banner-error-msg">{action.message}</span>
          ) : pendingConfirm ? (
            "Almost there — confirm Ashlr MD in the system settings that just opened."
          ) : (
            "Make Ashlr MD your default for Markdown files"
          )}
        </span>

        <div className="change-banner-actions">
          {succeeded ? (
            <span className="dh-banner-success-msg">
              <CheckCircleIcon />
              Set as default!
            </span>
          ) : pendingConfirm ? null : (
            <button
              type="button"
              className="banner-btn banner-btn-primary"
              onClick={canSet ? handleMakeDefault : handleHelp}
              disabled={busy}
              aria-busy={busy}
            >
              {busy && <SpinnerIcon />}
              {busy ? "Setting…" : canSet ? "Make Default" : "Show me how"}
            </button>
          )}

          {/* Snooze / dismiss — hidden mid-flight and on success. */}
          {!busy && !succeeded && (
            <>
              <button
                type="button"
                className="banner-btn"
                onClick={() => snooze(14)}
                aria-label="Remind me later"
              >
                Not now
              </button>
              <button
                type="button"
                className="dh-banner-link"
                onClick={() => neverAsk()}
                aria-label="Don't ask again about the default Markdown app"
              >
                Don't ask again
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
