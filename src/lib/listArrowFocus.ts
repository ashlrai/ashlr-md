import type { KeyboardEvent } from "react";

/** Enhance native button lists without activating items or capturing text-editing keys. */
export function listArrowFocus(e: KeyboardEvent, horizontal = false): void {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing)
    return;
  const buttons = Array.from(
    e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
  );
  const from = buttons.indexOf(e.target as HTMLButtonElement);
  if (from < 0) return;
  const next = horizontal ? "ArrowRight" : "ArrowDown";
  const previous = horizontal ? "ArrowLeft" : "ArrowUp";
  const to =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? buttons.length - 1
        : e.key === next
          ? (from + 1) % buttons.length
          : e.key === previous
            ? (from - 1 + buttons.length) % buttons.length
            : null;
  if (to === null) return;
  e.preventDefault();
  buttons[to].focus();
}
