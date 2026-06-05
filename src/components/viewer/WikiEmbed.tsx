/**
 * WikiEmbed.tsx — transclusion for ![[target]] embeds.
 *
 * Resolves and reads the target file, then renders it inline through the same
 * Renderer. A depth context caps recursion so `![[a]]`→`![[b]]`→`![[a]]` cycles
 * can't loop forever.
 */

import { invoke } from "@tauri-apps/api/core";
import { createContext, useContext, useEffect, useState } from "react";
import { resolveWikilink } from "../../lib/wikilink";
import { Renderer } from "./Renderer";

/** Current transclusion depth; Renderer-rendered embeds inherit depth + 1. */
const EmbedDepthContext = createContext(0);
const MAX_EMBED_DEPTH = 3;

interface WikiEmbedProps {
  target: string;
}

export function WikiEmbed({ target }: WikiEmbedProps) {
  const depth = useContext(EmbedDepthContext);
  // undefined = loading, null = unresolved/unreadable, string = content.
  const [content, setContent] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (depth >= MAX_EMBED_DEPTH || !target) return;
    let cancelled = false;
    (async () => {
      const path = await resolveWikilink(target);
      if (!path) {
        if (!cancelled) setContent(null);
        return;
      }
      try {
        const file = await invoke<{ content: string }>("read_markdown_file", { path });
        if (!cancelled) setContent(file.content);
      } catch {
        if (!cancelled) setContent(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, depth]);

  // A blank target (e.g. the data attribute was stripped) — render nothing
  // rather than firing a spurious resolve for "".
  if (!target) return null;
  if (depth >= MAX_EMBED_DEPTH) {
    return (
      <div className="wikiembed wikiembed--limit">↪ {target} (embed depth limit)</div>
    );
  }
  if (content === undefined) {
    return <div className="wikiembed wikiembed--loading">Loading {target}…</div>;
  }
  if (content === null) {
    return <div className="wikiembed wikiembed--broken">⚠ Can't embed “{target}”</div>;
  }

  return (
    <div className="wikiembed">
      <div className="wikiembed__title">{target}</div>
      <EmbedDepthContext.Provider value={depth + 1}>
        <Renderer content={content} />
      </EmbedDepthContext.Provider>
    </div>
  );
}
