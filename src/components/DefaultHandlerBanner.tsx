/**
 * DefaultHandlerBanner.tsx
 *
 * A slim, dismissible top banner shown when:
 *   1. Ashlr MD is NOT the current default app for .md files, AND
 *   2. The user hasn't permanently dismissed the prompt.
 *
 * Sits directly below the TitleBar (above the main content area) — mount it
 * in Shell.tsx immediately after <ExternalChangeBanner />.
 *
 * Styling reuses the existing `.change-banner` family defined in global.css so
 * it blends seamlessly with the rest of the app chrome.
 */

import { useCallback, useEffect, useState } from "react";
import { isDefaultMdHandler, setDefaultMdHandler } from "../lib/defaultHandler";
import { useSettingsStore } from "../store/settingsStore";

// ---------------------------------------------------------------------------
// Status type for the "Make Default" async action
// ---------------------------------------------------------------------------

type ActionStatus =
  | { kind: "idle" }
  | { kind: "busy" }
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
  const dismissed = useSettingsStore((s) => s.defaultPromptDismissed);
  const setDismissed = useSettingsStore((s) => s.setDefaultPromptDismissed);

  // null = unknown (still checking), false = not default, true = is default
  const [isDefault, setIsDefault] = useState<boolean | null>(null);
  const [status, setStatus] = useState<ActionStatus>({ kind: "idle" });

  // Check once on mount — fast IPC call, no visible delay.
  useEffect(() => {
    if (dismissed) return; // No need to hit IPC at all if already dismissed.
    let cancelled = false;
    isDefaultMdHandler().then((v) => {
      if (!cancelled) setIsDefault(v);
    });
    return () => {
      cancelled = true;
    };
  }, [dismissed]);

  const handleMakeDefault = useCallback(async () => {
    setStatus({ kind: "busy" });
    try {
      await setDefaultMdHandler();
      setStatus({ kind: "success" });
      // Re-verify so the banner hides on confirmed success.
      const confirmed = await isDefaultMdHandler();
      if (confirmed) {
        setIsDefault(true);
      }
    } catch (e) {
      const message =
        typeof e === "string"
          ? e
          : ((e as Error)?.message ?? "An unknown error occurred.");
      setStatus({ kind: "error", message });
    }
  }, []);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, [setDismissed]);

  // Hide when: dismissed by user, still loading, or already the default app.
  if (dismissed || isDefault === null || isDefault === true) {
    return null;
  }

  // After a confirmed success, hide the banner (isDefault flips to true above).
  // While the success state is briefly visible, show inline confirmation.
  const busy = status.kind === "busy";
  const succeeded = status.kind === "success";

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
      `}</style>

      <div className="change-banner" role="status" aria-live="polite">
        <span className="change-banner-text">
          {status.kind === "error" ? (
            <span className="dh-banner-error-msg">{status.message}</span>
          ) : (
            "Make Ashlr MD your default for Markdown files"
          )}
        </span>

        <div className="change-banner-actions">
          {succeeded ? (
            /* Brief confirmation before isDefault flips and the banner unmounts. */
            <span className="dh-banner-success-msg">
              <CheckCircleIcon />
              Set as default!
            </span>
          ) : (
            <button
              type="button"
              className="banner-btn banner-btn-primary"
              onClick={handleMakeDefault}
              disabled={busy}
              aria-busy={busy}
            >
              {busy && <SpinnerIcon />}
              {busy ? "Setting…" : "Make Default"}
            </button>
          )}

          {/* Dismiss — only hide when not mid-flight so we don't lose error feedback. */}
          {!busy && !succeeded && (
            <button
              type="button"
              className="banner-btn"
              onClick={handleDismiss}
              aria-label="Dismiss this suggestion"
            >
              Not now
            </button>
          )}
        </div>
      </div>
    </>
  );
}
