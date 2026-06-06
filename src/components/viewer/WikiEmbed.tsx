/**
 * WikiEmbed.tsx — Obsidian `![[target]]` embeds.
 *
 *   ![[note]]            → full-file transclusion
 *   ![[note#Heading]]    → partial transclusion (just that section)
 *   ![[note#^blockid]]   → partial transclusion (just that block)
 *   ![[image.png|300]]   → inline image (optionally sized)
 *
 * Markdown embeds render inline through the same Renderer; a depth context caps
 * recursion so `![[a]]`→`![[b]]`→`![[a]]` cycles can't loop forever. Images are
 * read through Rust into a `data:` URL (no broad `asset://` scope needed) and
 * shown via a React <img> created AFTER sanitize.
 */

import { invoke } from "@tauri-apps/api/core";
import { createContext, useContext, useEffect, useState } from "react";
import { extractSection, isImageTarget, splitFragment } from "../../lib/transclude";
import { resolveWikilink } from "../../lib/wikilink";
import { Renderer } from "./Renderer";

/** Current transclusion depth; Renderer-rendered embeds inherit depth + 1. */
const EmbedDepthContext = createContext(0);
const MAX_EMBED_DEPTH = 3;

interface WikiEmbedProps {
  target: string;
  /** Obsidian size hint from the `|` slot: "300" (width) or "300x200" (w×h). */
  size?: string;
}

/** Parse an Obsidian image size hint into width/height pixel attributes. */
function parseSize(size: string | undefined): { width?: number; height?: number } {
  if (!size) return {};
  const m = /^(\d+)(?:x(\d+))?$/.exec(size.trim());
  if (!m) return {};
  return { width: Number(m[1]), height: m[2] ? Number(m[2]) : undefined };
}

export function WikiEmbed({ target, size }: WikiEmbedProps) {
  const depth = useContext(EmbedDepthContext);
  const { file, fragment } = splitFragment(target);
  const isImage = isImageTarget(file);

  // For images we hold the resolved path; for markdown, the (maybe-sliced) text.
  const [resolved, setResolved] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!target) return;
    if (!isImage && depth >= MAX_EMBED_DEPTH) return;
    let cancelled = false;
    (async () => {
      // Resolve the file part only — the `#fragment` is applied locally below.
      const path = await resolveWikilink(file);
      if (!path) {
        if (!cancelled) setResolved(null);
        return;
      }
      if (isImage) {
        try {
          const dataUrl = await invoke<string>("read_image_data_url", { path });
          if (!cancelled) setResolved(dataUrl);
        } catch {
          if (!cancelled) setResolved(null);
        }
        return;
      }
      try {
        const doc = await invoke<{ content: string }>("read_markdown_file", { path });
        const out = fragment ? extractSection(doc.content, fragment) : doc.content;
        if (!cancelled) setResolved(out);
      } catch {
        if (!cancelled) setResolved(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, isImage, fragment, depth]);

  // A blank target (e.g. the data attribute was stripped) — render nothing.
  if (!target) return null;

  if (isImage) {
    if (resolved === undefined) {
      return <span className="wikiembed wikiembed--loading">Loading {file}…</span>;
    }
    if (resolved === null) {
      return (
        <span className="wikiembed wikiembed--broken">⚠ Missing image “{file}”</span>
      );
    }
    const { width, height } = parseSize(size);
    return (
      <img
        className="wikiembed__image"
        src={resolved}
        alt={file}
        width={width}
        height={height}
        loading="lazy"
      />
    );
  }

  if (depth >= MAX_EMBED_DEPTH) {
    return (
      <div className="wikiembed wikiembed--limit">↪ {target} (embed depth limit)</div>
    );
  }
  if (resolved === undefined) {
    return <div className="wikiembed wikiembed--loading">Loading {target}…</div>;
  }
  if (resolved === null) {
    return <div className="wikiembed wikiembed--broken">⚠ Can't embed “{target}”</div>;
  }

  return (
    <div className="wikiembed">
      <div className="wikiembed__title">{target}</div>
      <EmbedDepthContext.Provider value={depth + 1}>
        <Renderer content={resolved} />
      </EmbedDepthContext.Provider>
    </div>
  );
}
