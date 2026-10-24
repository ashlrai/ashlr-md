import type React from "react";
import "../../styles/tabbar.css";
import { useDocumentStore } from "../../store/documentStore";

/** Small × glyph for the per-tab close button. */
function CloseIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M3 3l6 6M9 3l-6 6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The tab Left/Right/Home/End moves to from tab `from` of `count`, wrapping. */
function arrowTarget(key: string, from: number, count: number): number | null {
  if (key === "ArrowRight") return (from + 1) % count;
  if (key === "ArrowLeft") return (from - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/**
 * Horizontal strip of open documents. Renders NOTHING when fewer than two tabs
 * are open, so the single-document layout is visually identical to before.
 *
 * Each tab is a flex row holding two real <button>s — one that fills the row to
 * switch, and a close button — so we never nest interactive elements and both
 * affordances are keyboard-reachable.
 *
 * The tabs follow the ARIA tabs pattern: only the active tab is in the Tab
 * order, and Left/Right (Home/End) move to and open the previous/next (first/
 * last) document. Every tab used to be its own Tab stop with no arrow keys,
 * so a list announced as tabs did not answer the keys it promised.
 */
export function TabBar() {
  const tabs = useDocumentStore((s) => s.tabs);
  const activeId = useDocumentStore((s) => s.activeId);
  const switchTab = useDocumentStore((s) => s.switchTab);
  const closeTab = useDocumentStore((s) => s.closeTab);

  if (tabs.length < 2) return null;

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
    );
    const from = buttons.indexOf(e.target as HTMLElement);
    if (from === -1) return;
    const to = arrowTarget(e.key, from, buttons.length);
    if (to === null) return;
    e.preventDefault();
    switchTab(tabs[to].id);
    buttons[to]?.focus();
  }

  return (
    <div
      className="tabbar"
      role="tablist"
      aria-label="Open documents"
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={`tab${active ? " active" : ""}`}
            title={tab.path}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className="tab-switch"
              onClick={() => switchTab(tab.id)}
              onAuxClick={(e) => {
                // Middle-click closes, matching browser-tab convention.
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(tab.id);
                }
              }}
            >
              {/* The dot is the eye's; the hidden text is what is read (an
                  aria-label on a plain span is not). */}
              {tab.isDirty && <span className="tab-dirty" aria-hidden="true" />}
              <span className="tab-name">{tab.fileName || "Untitled"}</span>
              {tab.isDirty && (
                <span className="visually-hidden">, unsaved changes</span>
              )}
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${tab.fileName || "tab"}`}
              onClick={() => closeTab(tab.id)}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}
