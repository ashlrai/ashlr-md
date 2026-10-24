/**
 * useReturnFocus: for a side panel that stays in the DOM, `inert`, while
 * closed (search, outline, agent activity). While `open`, it remembers what
 * had focus when the panel opened; when the panel closes with focus inside
 * it (or already fallen to the page), focus goes back there. An inert panel
 * cannot hold focus, so closing one from its own close button or with
 * Escape used to drop focus to the page, and a keyboard user lost their
 * place. Declare it before any effect that moves focus into the panel.
 */

import { type RefObject, useEffect } from "react";

export function useReturnFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      const panel = panelRef.current;
      const active = document.activeElement;
      const lost =
        active === null || active === document.body || !!panel?.contains(active);
      if (lost && previous?.isConnected && !panel?.contains(previous)) previous.focus();
    };
  }, [open, panelRef]);
}

/** What a panel's first focusable control is, when no preferred one is there. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Move focus into a side panel when it opens: to the first element matching
 * one of `preferred` (in order), else its first focusable control. Opening
 * the outline or agent activity from a shortcut used to leave focus where it
 * was, so a keyboard user had to find the panel. Focus already inside the
 * panel is left alone. Declare it after {@link useReturnFocus}, which must
 * see what had focus first. Pass a constant `preferred` (a new array each
 * render would move focus again).
 */
export function useFocusOnOpen(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  preferred: readonly string[],
): void {
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel || panel.contains(document.activeElement)) return;
    for (const sel of preferred) {
      const el = panel.querySelector<HTMLElement>(sel);
      if (el) {
        el.focus({ preventScroll: true });
        return;
      }
    }
    panel.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
  }, [open, panelRef, preferred]);
}
