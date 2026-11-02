/**
 * Wikilink.tsx — renders an Obsidian-style [[internal link]].
 *
 * Resolves the target against the effective vault root; clicking opens the
 * resolved file in a tab and, for a `[[note#Heading]]` or `[[note#^block]]`
 * link, scrolls to that heading or block once the document has rendered. Broken targets are styled and
 * disabled.
 */

import { useEffect, useRef, useState } from "react";
import {
  anchorElement,
  linkOpenError,
  scrollToFragment,
  wikilinkFragment,
} from "../../lib/docLinks";
import { smoothScrollBehavior } from "../../lib/motion";
import { splitFragment } from "../../lib/transclude";
import { resolveWikilink, useWikilinkCacheVersion } from "../../lib/wikilink";
import { useDocumentStore } from "../../store/documentStore";
import { toast } from "../../store/toastStore";
import { useDocPath } from "./docPath";

interface WikilinkProps {
  target: string;
  alias?: string;
}

export function Wikilink({ target, alias }: WikilinkProps) {
  // `[[#Heading]]`: a heading or block of the document holding the link.
  if (splitFragment(target).file.trim() === "") {
    return <HereLink target={target} alias={alias} />;
  }
  return <NoteLink target={target} alias={alias} />;
}

/**
 * A wikilink to a heading or block of its own document (`[[#Setup]]`,
 * `[[#^block]]`): a click scrolls there, in the rendered document (or embed)
 * that holds the link. Such a link was not recognised at all and showed as
 * the text `[[#Setup]]`.
 */
function HereLink({ target, alias }: WikilinkProps) {
  const fragment = wikilinkFragment(splitFragment(target).fragment) ?? "";
  const label = alias ?? target;
  return (
    <button
      type="button"
      className="wikilink"
      onClick={(e) => {
        const root = e.currentTarget.closest(".markdown-body") ?? document;
        const el = anchorElement(fragment, root);
        if (!el) {
          toast.info(`No heading or block “${fragment}” in this document.`);
          return;
        }
        el.scrollIntoView({ behavior: smoothScrollBehavior(), block: "start" });
      }}
      title={target}
    >
      {label}
    </button>
  );
}

function NoteLink({ target, alias }: WikilinkProps) {
  // undefined = resolving, null = broken, string = resolved path.
  const [resolved, setResolved] = useState<string | null | undefined>(undefined);
  // The heading or block to scroll to, decoded and as the page names it.
  const fragment = wikilinkFragment(splitFragment(target).fragment);
  // Holds the active scroll-retry canceller so we can stop it on unmount.
  const cancelScrollRef = useRef<(() => void) | null>(null);
  // In an embed, the embedded note's file: its links resolve from there.
  const docPath = useDocPath();
  // Resolved again when a file changes on disk, so a note deleted or renamed
  // since shows as broken.
  const cacheVersion = useWikilinkCacheVersion();

  useEffect(() => {
    void cacheVersion;
    let cancelled = false;
    void resolveWikilink(target, docPath)
      .then((p) => {
        if (!cancelled) setResolved(p);
      })
      .catch(() => {
        if (!cancelled) setResolved(null);
      });
    return () => {
      cancelled = true;
      cancelScrollRef.current?.();
    };
  }, [target, docPath, cacheVersion]);

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
          })
          .catch(() => {
            toast.error("Could not open linked note.");
          });
      }}
      disabled={resolved === undefined || broken}
      title={broken ? `Not found: ${target}` : target}
    >
      {label}
    </button>
  );
}
