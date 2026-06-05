/**
 * HeadingAnchor.tsx — a hover-revealed "copy link" affordance on every heading.
 *
 * Reuses the `rehype-slug` id already present on the heading. Copies a
 * `mdopener://` deep link to the file at that heading when the document is
 * saved, or a plain `#slug` fragment for unsaved documents.
 */

import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { useDocumentStore } from "../../store/documentStore";

export function HeadingAnchor({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(
    async (e: MouseEvent) => {
      e.preventDefault();
      const path = useDocumentStore.getState().path;
      const link = path
        ? `mdopener://open?path=${encodeURIComponent(path)}&heading=${encodeURIComponent(slug)}`
        : `#${slug}`;
      try {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1400);
      } catch {
        // Clipboard unavailable — no-op.
      }
    },
    [slug],
  );

  return (
    <button
      type="button"
      className="heading-anchor"
      onClick={copy}
      aria-label="Copy link to this heading"
      title={copied ? "Copied!" : "Copy link to this heading"}
    >
      {copied ? "✓" : "#"}
    </button>
  );
}
