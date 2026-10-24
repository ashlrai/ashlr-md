/**
 * Wikilink.tsx — renders an Obsidian-style [[internal link]].
 *
 * Resolves the target against the effective vault root; clicking opens the
 * resolved file in a tab and, for a `[[note#Heading]]` link, scrolls to that
 * heading once the document has rendered. Broken targets are styled and
 * disabled.
 */

import { useEffect, useRef, useState } from "react";
import { scrollToFragment } from "../../lib/docLinks";
import { splitFragment } from "../../lib/transclude";
import { resolveWikilink } from "../../lib/wikilink";
import { useDocumentStore } from "../../store/documentStore";
import { useDocPath } from "./docPath";

interface WikilinkProps {
  target: string;
  alias?: string;
}

export function Wikilink({ target, alias }: WikilinkProps) {
  // undefined = resolving, null = broken, string = resolved path.
  const [resolved, setResolved] = useState<string | null | undefined>(undefined);
  const { fragment } = splitFragment(target);
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
        const open = useDocumentStore.getState().openPath(resolved);
        if (fragment) {
          open.then(() => {
            cancelScrollRef.current = scrollToFragment(fragment);
          });
        }
      }}
      disabled={resolved === undefined || broken}
      title={broken ? `Not found: ${target}` : target}
    >
      {label}
    </button>
  );
}
