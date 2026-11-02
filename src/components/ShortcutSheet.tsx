import { useEffect, useMemo, useRef } from "react";
import { getCommands } from "../lib/commands";
import { formatShortcut, isDismissEscape } from "../lib/keymap";
import { shortcutSheet } from "../lib/shortcutSheet";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useUiStore } from "../store/uiStore";
import "../styles/settings.css";

/**
 * Keyboard shortcut cheat sheet (Help > Keyboard shortcuts, mod+/). Lists
 * every shortcut from the command registry, labelled for this platform (⌘ on
 * macOS, Ctrl elsewhere). Escape or a click outside closes it.
 */
export function ShortcutSheet() {
  const close = useUiStore((s) => s.closeShortcuts);
  const panelRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => shortcutSheet(getCommands()), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isDismissEscape(e)) {
        e.stopPropagation();
        close();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  useFocusTrap(panelRef);

  return (
    <div
      className="settings-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="settings-panel shortcut-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-sheet-title"
        ref={panelRef}
      >
        <div className="settings-header">
          <h2 className="settings-title" id="shortcut-sheet-title">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            className="settings-close-btn"
            onClick={close}
            aria-label="Close keyboard shortcuts"
          >
            ×
          </button>
        </div>
        {/* The list scrolls and holds nothing focusable: a Tab stop of its
            own lets the keyboard scroll it (WebKit scrolls only what has
            focus). The arrow keys and Page keys did nothing. */}
        <div
          className="settings-body shortcut-sheet-body"
          role="region"
          aria-label="Shortcuts"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable to scroll by keyboard
          tabIndex={0} // NOSONAR S6845: the named scroll region needs focus for keyboard scrolling in WebKit.
        >
          {groups.map((g) => (
            <section
              key={g.group}
              className="shortcut-sheet-group"
              aria-label={g.group}
            >
              <h3 className="shortcut-sheet-heading">{g.group}</h3>
              <dl>
                {g.rows.map((r) => (
                  <div key={r.title} className="shortcut-sheet-row">
                    <dt>{r.title}</dt>
                    <dd>
                      {r.keys.map((k) => (
                        <kbd key={k}>{formatShortcut(k)}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
