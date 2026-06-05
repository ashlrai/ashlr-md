/**
 * Wikilink.tsx — renders an Obsidian-style [[internal link]].
 *
 * Resolves the target against the current document's directory; clicking opens
 * the resolved file in a tab. Broken targets are styled distinctly and disabled.
 */

import { useEffect, useState } from "react";
import { resolveWikilink } from "../../lib/wikilink";
import { useDocumentStore } from "../../store/documentStore";

interface WikilinkProps {
  target: string;
  alias?: string;
}

export function Wikilink({ target, alias }: WikilinkProps) {
  // undefined = resolving, null = broken, string = resolved path.
  const [resolved, setResolved] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    resolveWikilink(target).then((p) => {
      if (!cancelled) setResolved(p);
    });
    return () => {
      cancelled = true;
    };
  }, [target]);

  const broken = resolved === null;
  const label = alias ?? target;

  return (
    <button
      type="button"
      className={`wikilink${broken ? " wikilink--broken" : ""}`}
      onClick={() => {
        if (resolved) useDocumentStore.getState().openPath(resolved);
      }}
      disabled={resolved === undefined || broken}
      title={broken ? `Not found: ${target}` : target}
    >
      {label}
    </button>
  );
}
