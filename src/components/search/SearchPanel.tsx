/**
 * SearchPanel.tsx — cross-file full-text search (left dock, mirrors Outline).
 *
 * Searches recent documents and the watched folder via the Rust `search_files`
 * command (debounced), groups hits by file with line snippets, and opens the
 * file on click. Shares the left dock with Outline/Activity (mutual exclusion
 * lives in uiStore).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { type FileSearchResult, searchFiles } from "../../lib/crossSearch";
import { useActivityStore } from "../../store/activityStore";
import { useDocumentStore } from "../../store/documentStore";
import { useRecentStore } from "../../store/recentStore";
import { useUiStore } from "../../store/uiStore";
import "../../styles/search.css";

export function SearchPanel() {
  const open = useUiStore((s) => s.searchOpen);
  const close = useUiStore((s) => s.closeSearch);
  const recents = useRecentStore((s) => s.recents);
  const activityFiles = useActivityStore((s) => s.files);
  const openPath = useDocumentStore((s) => s.openPath);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Deduped candidate paths: recents + watched-folder files.
  const paths = useMemo(() => {
    const set = new Set<string>();
    for (const r of recents) set.add(r.path);
    for (const f of activityFiles) set.add(f.path);
    return Array.from(set);
  }, [recents, activityFiles]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  // Debounced search whenever the query (or candidate set) changes.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    const handle = window.setTimeout(() => {
      searchFiles(paths, q).then((r) => {
        setResults(r);
        setBusy(false);
      });
    }, 180);
    return () => window.clearTimeout(handle);
  }, [query, paths]);

  const total = results.reduce((n, r) => n + r.matches.length, 0);

  return (
    <aside
      className={`search-panel${open ? " search-panel--open" : ""}`}
      aria-hidden={!open}
    >
      <div className="search-panel__header">
        <div className="search-panel__title">Search files</div>
        <button
          type="button"
          className="search-panel__close"
          onClick={close}
          aria-label="Close search"
        >
          ✕
        </button>
      </div>

      <div className="search-panel__input-row">
        <input
          ref={inputRef}
          className="search-panel__input"
          type="text"
          placeholder="Search recent & watched files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
        />
      </div>

      {query.trim() && (
        <div className="search-panel__summary">
          {busy
            ? "Searching…"
            : `${total} match${total === 1 ? "" : "es"} in ${results.length} file${
                results.length === 1 ? "" : "s"
              }`}
        </div>
      )}

      <div className="search-panel__results">
        {results.map((file) => (
          <div className="search-file" key={file.path}>
            <div className="search-file__name" title={file.path}>
              {file.fileName}
            </div>
            {file.matches.map((m) => (
              <button
                key={`${file.path}:${m.lineNo}`}
                type="button"
                className="search-match"
                onClick={() => {
                  openPath(file.path);
                  close();
                }}
                title={`Line ${m.lineNo}`}
              >
                <span className="search-match__line">{m.lineNo}</span>
                <span className="search-match__snippet">{m.snippet}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
