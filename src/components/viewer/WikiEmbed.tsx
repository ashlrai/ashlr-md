/**
 * WikiEmbed.tsx — Obsidian `![[target]]` embeds.
 *
 *   ![[note]]            → full-file transclusion
 *   ![[note#Heading]]    → partial transclusion (just that section)
 *   ![[note#^blockid]]   → partial transclusion (just that block)
 *   ![[image.png|300]]   → inline image (optionally sized)
 *   ![[notes.txt]]       → a plain-text attachment, shown as written
 *
 * Markdown embeds render inline through the same Renderer; a depth context caps
 * recursion so `![[a]]`→`![[b]]`→`![[a]]` cycles can't loop forever. An
 * embedded note's own links, images and embeds resolve from its file
 * (DocPathContext), and the embed's target from the note holding it. Images are
 * read through Rust into a `data:` URL (no broad `asset://` scope needed) and
 * shown via a React <img> created AFTER sanitize.
 */

import { invoke } from "@tauri-apps/api/core";
import { createContext, useContext, useEffect, useState } from "react";
import {
  extractSection,
  isImageTarget,
  isPlainTextTarget,
  splitFragment,
} from "../../lib/transclude";
import { resolveWikilink } from "../../lib/wikilink";
import { DocPathContext, useDocPath } from "./docPath";
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
  const isText = isPlainTextTarget(file);

  // The note (or the open document) holding this embed.
  const docPath = useDocPath();

  // For images we hold the data URL; for markdown, the (maybe-sliced) text.
  const [resolved, setResolved] = useState<string | null | undefined>(undefined);
  // The embedded file's path, which its own relative links resolve from.
  const [embeddedPath, setEmbeddedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    if (!isImage && depth >= MAX_EMBED_DEPTH) return;
    let cancelled = false;
    (async () => {
      // Resolve the file part only — the `#fragment` is applied locally below.
      const path = await resolveWikilink(file, docPath);
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
        // A text attachment has no headings or blocks to take a section of.
        const out =
          fragment && !isText ? extractSection(doc.content, fragment) : doc.content;
        if (!cancelled) {
          setEmbeddedPath(path);
          setResolved(out);
        }
      } catch {
        if (!cancelled) setResolved(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, file, isImage, isText, fragment, depth, docPath]);

  // A blank target (e.g. the data attribute was stripped) — render nothing.
  if (!target) return null;

  if (isImage) {
    if (resolved === undefined) {
      return (
        <span className="wikiembed wikiembed--loading" data-name={file}>
          Loading {file}…
        </span>
      );
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
    return (
      <div className="wikiembed wikiembed--loading" data-name={target}>
        Loading {target}…
      </div>
    );
  }
  if (resolved === null) {
    return <div className="wikiembed wikiembed--broken">⚠ Can't embed “{target}”</div>;
  }

  if (isText) {
    return (
      <div className="wikiembed">
        <div className="wikiembed__title">{target}</div>
        <pre className="wikiembed__text">{resolved}</pre>
      </div>
    );
  }

  return (
    <div className="wikiembed">
      <div className="wikiembed__title">{target}</div>
      <EmbedDepthContext.Provider value={depth + 1}>
        <DocPathContext.Provider value={embeddedPath}>
          <Renderer content={resolved} />
        </DocPathContext.Provider>
      </EmbedDepthContext.Provider>
    </div>
  );
}
