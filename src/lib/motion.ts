/**
 * motion.ts: scrolling that honours the system's reduced motion setting.
 */

/**
 * `"smooth"`, or `"auto"` (an instant jump) when the user asks the system
 * to reduce motion. The reduced-motion rule in global.css sets
 * `scroll-behavior: auto`, but a `behavior: "smooth"` passed to
 * `scrollIntoView` or `scrollTo` overrides the CSS, so the outline, find,
 * links to headings, the review card and the AI chat scrolled with an
 * animation anyway.
 */
export function smoothScrollBehavior(): ScrollBehavior {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth";
  } catch {
    return "smooth";
  }
}
