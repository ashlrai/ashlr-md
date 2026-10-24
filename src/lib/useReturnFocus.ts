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
