/**
 * RelatedNotes.tsx — auto-surfaced links to related documents.
 *
 * When a doc is open, finds other Markdown files in the user's library that
 * relate to it (by the file's title + first heading, via the same local
 * retrieval that powers library chat) and shows them as one-click chips — the
 * "your notes connect" discovery surface, with the software doing the linking.
 */

import { useEffect, useState } from "react";
import { type LibraryCitation, retrieveLibraryContext } from "../../lib/libraryContext";
import { openKeepingView } from "../../lib/openKeepingView";
import { atxHeadings } from "../../lib/outline";
import { useDocumentStore } from "../../store/documentStore";

/**
 * The retrieval query for a document: its file name without the extension
 * and its first level 1 to 3 heading. Headings are read by the outline's
 * rules (atxHeadings), so a `# comment` in front matter or fenced code is
 * not taken, `  # Title` and `#\tTitle` are, and a closing `#` run is
 * dropped. A column-0 regex used to take the first `#` line anywhere.
 */
export function queryFromDoc(fileName: string, content: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const heading =
    atxHeadings(content).find((h) => h.depth <= 3 && h.text !== "")?.text ?? "";
  return `${stem} ${heading}`.trim();
}

export function RelatedNotes() {
  const path = useDocumentStore((s) => s.path);
  const fileName = useDocumentStore((s) => s.fileName);
  const [related, setRelated] = useState<LibraryCitation[]>([]);

  // Compute once per document open (not per keystroke — read content lazily).
  useEffect(() => {
    // Clear immediately so we never show the previous doc's related notes.
    setRelated([]);
    if (!path) return;
    let cancelled = false;
    const content = useDocumentStore.getState().content;
    void retrieveLibraryContext(queryFromDoc(fileName, content)).then((ctx) => {
      if (cancelled) return;
      setRelated(ctx.citations.filter((c) => c.path !== path).slice(0, 5));
    });
    return () => {
      cancelled = true;
    };
  }, [path, fileName]);

  if (related.length === 0) return null;

  return (
    <div className="ai-related">
      <div className="ai-related__label">Related notes</div>
      <div className="ai-related__chips">
        {related.map((c) => (
          <button
            key={c.path}
            type="button"
            className="ai-related__chip"
            onClick={() => void openKeepingView(c.path)}
            title={c.path}
          >
            {c.fileName}
          </button>
        ))}
      </div>
    </div>
  );
}
