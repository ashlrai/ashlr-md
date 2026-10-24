/**
 * Wikilink.tsx — renders an Obsidian-style [[internal link]].
 *
 * Resolves the target against the effective vault root; clicking opens the
 * resolved file in a tab and, for a `[[note#Heading]]` or `[[note#^block]]`
 * link, scrolls to that heading or block once the document has rendered. Broken targets are styled and
 * disabled.
 */

import { useEffect, useRef, useState } from "react";
import { linkOpenError, scrollToFragment, wikilinkFragment } from "../../lib/docLinks";
import { splitFragment } from "../../lib/transclude";
import { resolveWikilink } from "../../lib/wikilink";
import { useDocumentStore } from "../../store/documentStore";
import { toast } from "../../store/toastStore";
import { useDocPath } from "./docPath";

interface WikilinkProps {
  target: string;
  alias?: string;
}

export function Wikilink({ target, alias }: WikilinkProps) {
  // undefined = resolving, null = broken, string = resolved path.
  const [resolved, setResolved] = useState<string | null | undefined>(undefined);
  // The heading or block to scroll to, decoded and as the page names it.
  const fragment = wikilinkFragment(splitFragment(target).fragment);
  // Holds the active scroll-retry canceller so we can stop it on unmount.
  const cancelScrollRef = useRef<(() => void) | null>(null);
  // In an embed, the embedded note's file: its links resolve from there.
  const docPath = useDocPath();

  useEffect(() => {
    let cancelled = false;
    resolveWikilink(target, docPath).then((p) => {
      if (!cancelled) setResolved(p);
    });
    return () => {
      cancelled = true;
      cancelScrollRef.current?.();
    };
  }, [target, docPath]);

  const broken = resolved === null;
  const label = alias ?? target;

  return (
    <button
      type="button"
      className={`wikilink${broken ? " wikilink--broken" : ""}`}
      onClick={() => {
        if (!resolved) return;
        cancelScrollRef.current?.(); // cancel any prior pending scroll
        // A note deleted since the link was resolved is said in a toast;
        // the document holding the link stays in view.
        void useDocumentStore
          .getState()
          .openPath(resolved, { keepViewOnError: true })
          .then((error) => {
            if (error !== null) toast.error(linkOpenError(resolved, error));
            else if (fragment) cancelScrollRef.current = scrollToFragment(fragment);
          });
      }}
      disabled={resolved === undefined || broken}
      title={broken ? `Not found: ${target}` : target}
    >
      {label}
    </button>
  );
}
