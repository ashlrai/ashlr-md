/**
 * Wikilink.tsx — renders an Obsidian-style [[internal link]].
 *
 * Resolves the target against the effective vault root; clicking opens the
 * resolved file in a tab and, for a `[[note#Heading]]` link, scrolls to that
 * heading once the document has rendered. Broken targets are styled and
 * disabled.
 */

import GithubSlugger from "github-slugger";
import { useEffect, useRef, useState } from "react";
import { splitFragment } from "../../lib/transclude";
import { resolveWikilink } from "../../lib/wikilink";
import { useDocumentStore } from "../../store/documentStore";

interface WikilinkProps {
  target: string;
  alias?: string;
}

/**
 * Scroll to a heading by slug once it appears (the doc renders async after
 * open). Returns a cancel fn so a pending retry loop can be stopped if the
 * component unmounts or the user navigates again.
 */
function scrollToHeading(fragment: string): () => void {
  // Block references (^id) have no rendered anchor — skip gracefully.
  if (fragment.startsWith("^")) return () => {};
  const slug = new GithubSlugger().slug(fragment);
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    const el = document.getElementById(slug);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (tries++ < 12) timer = setTimeout(tick, 60);
  };
  tick();
  return () => {
    if (timer !== null) clearTimeout(timer);
  };
}

export function Wikilink({ target, alias }: WikilinkProps) {
  // undefined = resolving, null = broken, string = resolved path.
  const [resolved, setResolved] = useState<string | null | undefined>(undefined);
  const { fragment } = splitFragment(target);
  // Holds the active scroll-retry canceller so we can stop it on unmount.
  const cancelScrollRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveWikilink(target).then((p) => {
      if (!cancelled) setResolved(p);
    });
    return () => {
      cancelled = true;
      cancelScrollRef.current?.();
    };
  }, [target]);

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
            cancelScrollRef.current = scrollToHeading(fragment);
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
