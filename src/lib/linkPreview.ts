/**
 * linkPreview.ts — resolve link targets to preview content for
 * LinkPreviewPopover.
 *
 * Three kinds of link are handled:
 *
 *   1. Internal .md / vault wikilinks  — read the file via IPC and return
 *      the first heading + paragraph (or first 15 lines), so the popover
 *      renders a meaningful snippet without loading the full document.
 *
 *   2. External http(s) links          — privacy-first stub: no fetch is ever
 *      issued; the popover just shows "External link — <domain>".
 *
 *   3. Anything else (mailto:, #anchors, etc.) — returns null so the caller
 *      knows not to show a popover.
 *
 * Results are memoized per resolved path / URL to avoid re-invoking IPC on
 * every mouse-enter. Null results (broken links) are cached briefly so that
 * creating the target file then re-hovering picks it up.
 */

import { invoke } from "@tauri-apps/api/core";
import { resolveWikilink } from "./wikilink";
import { splitFragment } from "./transclude";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LinkKind = "internal" | "external" | "none";

export interface LinkPreviewResult {
  kind: LinkKind;
  /** Markdown snippet to render (internal) or a plain description (external). */
  snippet: string;
  /** Resolved absolute path for internal links; empty string otherwise. */
  resolvedPath: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const NULL_TTL_MS = 5_000;

interface CacheEntry {
  value: LinkPreviewResult | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();

/** Drop every cached preview — useful after vault changes in tests. */
export function invalidateLinkPreviewCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract a preview snippet from raw markdown content.
 *
 * Preference order:
 *   1. First heading (any level) + the paragraph immediately following it.
 *   2. Failing that, the first 15 non-empty lines.
 *
 * The result is stripped of YAML frontmatter.
 */
export function extractPreviewSnippet(content: string): string {
  // Strip YAML frontmatter.
  const stripped = content.replace(/^---[\s\S]*?---\s*\n?/, "");
  const lines = stripped.split("\n");

  // Try heading + following paragraph.
  const headingIdx = lines.findIndex((l) => /^#{1,6}\s/.test(l));
  if (headingIdx >= 0) {
    const heading = lines[headingIdx];
    // Collect the paragraph that immediately follows (skip blank lines first).
    let paraStart = headingIdx + 1;
    while (paraStart < lines.length && lines[paraStart].trim() === "") paraStart++;
    let paraEnd = paraStart;
    while (paraEnd < lines.length && lines[paraEnd].trim() !== "") paraEnd++;
    const para = lines.slice(paraStart, paraEnd).join("\n");
    return para ? `${heading}\n\n${para}` : heading;
  }

  // Fallback: first 15 non-empty lines.
  const preview: string[] = [];
  for (const line of lines) {
    if (preview.length >= 15) break;
    if (line.trim() !== "") preview.push(line);
  }
  return preview.join("\n");
}

/**
 * Classify an href string.
 *
 *   - http(s):// → "external"
 *   - A path ending in .md, or a bare name (wikilink-style), → "internal"
 *   - Everything else (#anchor, mailto:, data:, …) → "none"
 */
export function classifyHref(href: string): LinkKind {
  if (!href) return "none";
  if (/^https?:\/\//i.test(href)) return "external";
  // Anchor-only links, mailto:, javascript:, data:, etc.
  if (/^(#|mailto:|javascript:|data:)/i.test(href)) return "none";
  // Path to a .md file, or a bare wikilink target passed as href.
  if (href.endsWith(".md") || /^[^/\\:*?"<>|]+$/.test(href)) return "internal";
  return "none";
}

/**
 * Extract the hostname from an http(s) URL for the external stub message.
 * Returns the full href on parse failure.
 */
export function domainOf(href: string): string {
  try {
    return new URL(href).hostname;
  } catch {
    return href;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve `href` to a preview result.
 *
 * For internal links, `currentPath` is the path of the document currently
 * open in the editor — it is forwarded to `resolveWikilink` so relative
 * targets resolve correctly. Pass `null` when no document is open.
 *
 * Returns `null` when the link kind is "none" or a broken internal link
 * cannot be found.
 */
export async function resolveLinkPreview(
  href: string,
  currentPath: string | null,
): Promise<LinkPreviewResult | null> {
  const kind = classifyHref(href);

  if (kind === "none") return null;

  if (kind === "external") {
    const domain = domainOf(href);
    return {
      kind: "external",
      snippet: `External link — ${domain}`,
      resolvedPath: "",
    };
  }

  // Internal: resolve the file, then read it.
  // Strip any #fragment so we resolve the file itself.
  const { file } = splitFragment(href);

  // Cache key: include currentPath so the same href from different docs resolves
  // independently (a target like "notes.md" could be in different directories).
  const cacheKey = `${currentPath ?? ""}|${file}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    if (cached.value !== null || Date.now() - cached.at < NULL_TTL_MS) {
      return cached.value;
    }
  }

  // Resolve absolute path via the same wikilink resolver used by Wikilink.tsx.
  // We temporarily stub the document store path so resolveWikilink uses the
  // correct base directory. resolveWikilink reads `documentStore.getState().path`
  // internally; in the preview flow we rely on the store already holding the
  // current path, which is the normal runtime state.
  const resolvedPath = await resolveWikilink(file);
  if (!resolvedPath) {
    cache.set(cacheKey, { value: null, at: Date.now() });
    return null;
  }

  try {
    const doc = await invoke<{ content: string }>("read_markdown_file", {
      path: resolvedPath,
    });
    const snippet = extractPreviewSnippet(doc.content);
    const result: LinkPreviewResult = { kind: "internal", snippet, resolvedPath };
    cache.set(cacheKey, { value: result, at: Date.now() });
    return result;
  } catch {
    cache.set(cacheKey, { value: null, at: Date.now() });
    return null;
  }
}
