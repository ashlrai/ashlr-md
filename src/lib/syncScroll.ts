/**
 * syncScroll.ts — proportional two-pane scroll synchronization.
 *
 * Links a source scroller (the editor) and a preview scroller so that scrolling
 * either keeps the other at the same scroll *percentage*. This is O(1) and
 * robust (no line/heading mapping); a direction lock prevents the feedback loop
 * where A drives B whose induced scroll event would otherwise drive A back.
 *
 * Returns a disposer that detaches both listeners.
 */

export function linkScroll(a: HTMLElement, b: HTMLElement): () => void {
  let lock: HTMLElement | null = null;
  let raf = 0;
  let releaseRaf = 0;

  const ratio = (el: HTMLElement): number => {
    const max = el.scrollHeight - el.clientHeight;
    return max > 0 ? el.scrollTop / max : 0;
  };

  const drive = (from: HTMLElement, to: HTMLElement) => {
    const max = to.scrollHeight - to.clientHeight;
    to.scrollTop = ratio(from) * max;
  };

  const makeHandler = (driver: HTMLElement, follower: HTMLElement) => () => {
    // If `driver`'s scroll was itself induced by the other pane, ignore it.
    if (lock === driver) return;
    lock = follower;
    cancelAnimationFrame(raf);
    // Cancel any pending lock-release from a prior frame, else a stale release
    // can fire mid-drive during fast scrolling and let the panes fight.
    cancelAnimationFrame(releaseRaf);
    raf = requestAnimationFrame(() => {
      drive(driver, follower);
      // Release the lock a frame later, after the induced scroll has fired.
      releaseRaf = requestAnimationFrame(() => {
        lock = null;
      });
    });
  };

  const onA = makeHandler(a, b);
  const onB = makeHandler(b, a);
  a.addEventListener("scroll", onA, { passive: true });
  b.addEventListener("scroll", onB, { passive: true });

  return () => {
    a.removeEventListener("scroll", onA);
    b.removeEventListener("scroll", onB);
    cancelAnimationFrame(raf);
    cancelAnimationFrame(releaseRaf);
  };
}
