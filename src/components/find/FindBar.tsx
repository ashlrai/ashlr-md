/**
 * FindBar.tsx — in-document find for the rendered read view.
 *
 * Highlights matches in `.markdown-body` (via domFind), shows a running count,
 * and navigates between hits. Enter / Shift+Enter step forward / back; Escape
 * closes. Re-highlights when the document content changes.
 */

import { useEffect, useRef, useState } from "react";
import { clearHighlights, highlight, setActive } from "../../lib/domFind";
import { useDocumentStore } from "../../store/documentStore";
import { useUiStore } from "../../store/uiStore";
import "../../styles/find.css";

export function FindBar() {
  const close = useUiStore((s) => s.closeFind);
  const content = useDocumentStore((s) => s.content);
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on open.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Re-highlight on query or document change; clear on unmount.
  useEffect(() => {
    const n = highlight(query);
    setCount(n);
    setIndex((i) => (n === 0 ? 0 : Math.min(i, n - 1)));
    return () => clearHighlights();
  }, [query, content]);

  // Keep the active match in view.
  useEffect(() => {
    if (count > 0) setActive(index);
  }, [index, count]);

  const go = (delta: number) => {
    if (count === 0) return;
    setIndex((i) => (i + delta + count) % count);
  };

  return (
    <div className="find-bar" role="search">
      <input
        ref={inputRef}
        className="find-input"
        type="text"
        placeholder="Find in document"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      />
      <span className="find-count">
        {query ? (count === 0 ? "0/0" : `${index + 1}/${count}`) : ""}
      </span>
      <button
        type="button"
        className="find-btn"
        onClick={() => go(-1)}
        disabled={count === 0}
        aria-label="Previous match"
        title="Previous (Shift+Enter)"
      >
        ↑
      </button>
      <button
        type="button"
        className="find-btn"
        onClick={() => go(1)}
        disabled={count === 0}
        aria-label="Next match"
        title="Next (Enter)"
      >
        ↓
      </button>
      <button
        type="button"
        className="find-btn find-close"
        onClick={close}
        aria-label="Close find"
        title="Close (Esc)"
      >
        ✕
      </button>
    </div>
  );
}
