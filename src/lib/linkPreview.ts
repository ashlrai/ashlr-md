/**
 * linkPreview.ts — resolve link targets to preview content for
 * LinkPreviewPopover.
 *
 * Three kinds of link are handled:
 *
 *   1. Internal .md links and bare note names, resolved as a click
 *      resolves them (docLinks.ts) — read the file via IPC and return
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
import { linkTarget, resolveLinkTarget } from "./docLinks";
import { atxHeadings, markdownLines } from "./outline";
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
  // Try heading + following paragraph. The heading is the outline's first
  // (atxHeadings, the rule of mdopener-mcp's headings): a `# ` line in
  // fenced code used to be taken, and `  # Title` or `#\tTitle` was not.
  const heading = atxHeadings(content).find((h) => h.text !== "");
  if (heading) {
    const lines = content.split("\n");
    const headingIdx = heading.line - 1;
    const headingLine = lines[headingIdx];
    // Collect the paragraph that immediately follows (skip blank lines first).
    let paraStart = headingIdx + 1;
    while (paraStart < lines.length && lines[paraStart].trim() === "") paraStart++;
    let paraEnd = paraStart;
    while (paraEnd < lines.length && lines[paraEnd].trim() !== "") paraEnd++;
    const para = lines.slice(paraStart, paraEnd).join("\n");
    return para ? `${headingLine}\n\n${para}` : headingLine;
  }

  // Fallback: first 15 non-empty lines, without YAML frontmatter, which
  // ends on a line that is `---` or `...` as the outline reads it. A lazy
  // regex used to end it at any later `---`, mid-line too, so a document
  // opening with a thematic break lost the text up to the next one.
  const lines = markdownLines(content)
    .filter((l) => l.kind !== "frontmatter")
    .map((l) => l.text);
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
  // Internal exactly when a click opens a document from it (linkTarget, here
  // from a stand-in document, as only the kind matters): a Markdown path or
  // a bare note name. The test of its own missed links a click follows, so
  // `notes/plan.md#Goals`, `notes/Plan`, `Plan.MD` and `x.markdown` showed
  // no preview.
  const target = linkTarget(href, CLASSIFY_FROM);
  return target.kind === "document" || target.kind === "note" ? "internal" : "none";
}

/** The stand-in document {@link classifyHref} reads a relative link from. */
const CLASSIFY_FROM = "/classify/doc.md";

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
 * Internal links resolve by the rule a click follows
 * ({@link resolveLinkTarget}, docLinks.ts) from `currentPath`, the document
 * holding the link: a path with a Markdown extension is that file relative
 * to the document, a bare name is a note found as a wikilink is. The preview
 * used to look every link up as a wikilink (vault-wide, from the open
 * document) while a click opened the relative path, so the two could name
 * different files, and a bare `[x](Note)` previewed a note a click refused.
 *
 * Returns `null` when the link kind is "none", when a click would not open
 * it, or when a broken internal link cannot be found.
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
      snippet: `External link: ${domain}`,
      resolvedPath: "",
    };
  }

  // Internal: resolve the file, then read it. The #fragment names a place
  // in the file, so it is not part of the cache key.
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

  const target = await resolveLinkTarget(href, currentPath);
  if (target.kind !== "document") {
    cache.set(cacheKey, { value: null, at: Date.now() });
    return null;
  }
  const resolvedPath = target.path;

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
