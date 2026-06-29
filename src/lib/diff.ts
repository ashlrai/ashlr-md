/**
 * diff.ts — pure-TS unified-diff parser.
 *
 * Parses a unified diff string into a list of `ParsedHunk` objects, each with
 * a target file path (from `--- a/…` / `+++ b/…` headers), the raw `@@ … @@`
 * header line, and precomputed `find` / `replace` strings for exact patch
 * application via string replace.
 *
 * Design notes:
 *  - Handles multiple hunks per diff, multiple files, no-header diffs.
 *  - Strips `\ No newline at end of file` markers.
 *  - Normalizes CRLF → LF throughout.
 *  - `find` = contextBefore + removed + contextAfter (original text).
 *  - `replace` = contextBefore + added + contextAfter (new text).
 *    Both are joined with `\n` so they match what string-replace expects.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedHunk {
  /** Path from `+++ b/…` (or `--- a/…` fallback); null when absent. */
  targetFile: string | null;
  /** The raw `@@ … @@` header line. */
  header: string;
  /** Original text (context + removed lines) — the "find" anchor. */
  find: string;
  /** Replacement text (context + added lines) — the "replace" payload. */
  replace: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip `a/` or `b/` git prefix from a diff file path. */
function stripPrefix(raw: string): string {
  return raw.replace(/^[ab]\//, "");
}

/** Parse `+++ b/path` / `--- a/path` style headers. Prefers `+++`. */
function extractTargetFile(lines: string[]): string | null {
  let target: string | null = null;
  for (const line of lines) {
    if (line.startsWith("--- ")) {
      const rest = line.slice(4).trim();
      if (rest !== "/dev/null") target = stripPrefix(rest);
    }
    if (line.startsWith("+++ ")) {
      const rest = line.slice(4).trim();
      if (rest !== "/dev/null") return stripPrefix(rest);
    }
  }
  return target;
}

// ---------------------------------------------------------------------------
// Primary export — parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw unified diff string into an array of {@link ParsedHunk}s.
 * Returns an empty array (never throws) on malformed input.
 */
export function parseDiffHunks(raw: string): ParsedHunk[] {
  // Normalize line endings.
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  const hunks: ParsedHunk[] = [];

  // File-level headers accumulate across lines until we hit a hunk header.
  const fileHeaderLines: string[] = [];
  let targetFile: string | null = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // File header lines.
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      fileHeaderLines.push(line);
      if (line.startsWith("+++ ")) {
        // Re-parse target now that we have both --- and +++ lines.
        targetFile = extractTargetFile(fileHeaderLines);
      }
      i++;
      continue;
    }

    // diff --git / index / new file mode etc. — pass over.
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to")
    ) {
      // Reset file headers when we start a new file section.
      if (line.startsWith("diff --git")) {
        fileHeaderLines.length = 0;
        targetFile = null;
      }
      i++;
      continue;
    }

    // Hunk header: `@@ -l,s +l,s @@ …`
    if (line.startsWith("@@")) {
      const header = line;
      i++;

      const contextBefore: string[] = [];
      const removed: string[] = [];
      const added: string[] = [];
      const contextAfter: string[] = [];

      // Collect hunk body lines.
      // We track whether we've seen any +/- so context lines after the last
      // add/remove become contextAfter (rather than contextBefore).
      let seenChange = false;
      let pendingContext: string[] = [];

      while (i < lines.length) {
        const l = lines[i];

        // Next hunk or file header — stop.
        if (l.startsWith("@@") || l.startsWith("--- ") || l.startsWith("+++ ")) break;
        // diff --git line — stop.
        if (l.startsWith("diff --git")) break;

        // Ignore "\ No newline at end of file".
        if (l.startsWith("\\ ")) {
          i++;
          continue;
        }

        if (l.startsWith("+")) {
          if (!seenChange) {
            // Flush pending context into contextBefore.
            contextBefore.push(...pendingContext);
            pendingContext = [];
          }
          seenChange = true;
          // Flush any pending context that came between changes into removed.
          // (This handles the rare case of interleaved context lines mid-hunk.)
          if (pendingContext.length > 0) {
            removed.push(...pendingContext);
            added.push(...pendingContext);
            pendingContext = [];
          }
          added.push(l.slice(1));
          i++;
          continue;
        }

        if (l.startsWith("-")) {
          if (!seenChange) {
            contextBefore.push(...pendingContext);
            pendingContext = [];
          }
          seenChange = true;
          if (pendingContext.length > 0) {
            removed.push(...pendingContext);
            added.push(...pendingContext);
            pendingContext = [];
          }
          removed.push(l.slice(1));
          i++;
          continue;
        }

        if (l.startsWith(" ") || l === "") {
          // Context line (space prefix or blank).
          const content = l.startsWith(" ") ? l.slice(1) : l;
          if (!seenChange) {
            pendingContext.push(content);
          } else {
            pendingContext.push(content);
          }
          i++;
          continue;
        }

        // Unknown line prefix — skip.
        i++;
      }

      // Remaining pendingContext is contextAfter.
      // Trim trailing empty strings that arise from a final newline in the fixture.
      const trailingContext = [...pendingContext];
      while (
        trailingContext.length > 0 &&
        trailingContext[trailingContext.length - 1] === ""
      ) {
        trailingContext.pop();
      }
      contextAfter.push(...trailingContext);

      // Build find / replace strings.
      const find = [...contextBefore, ...removed, ...contextAfter].join("\n");
      const replace = [...contextBefore, ...added, ...contextAfter].join("\n");

      hunks.push({ targetFile, header, find, replace });
      continue;
    }

    i++;
  }

  return hunks;
}

// ---------------------------------------------------------------------------
// Hunk application
// ---------------------------------------------------------------------------

export interface ApplyResult {
  ok: true;
  newContent: string;
}

export interface ApplyError {
  ok: false;
  error: string;
}

/**
 * Apply a single {@link ParsedHunk} to `content` using find/replace semantics.
 *
 * Returns `{ ok: true, newContent }` on success or `{ ok: false, error }` when:
 *  - the `find` anchor is not present in `content` (patch not found),
 *  - the `find` anchor appears more than once (ambiguous — need more context).
 *
 * "Loose" matching: callers that only need the +/- lines to match (ignoring
 * context) should strip context from `find`/`replace` before calling; this
 * function performs an exact substring replacement.
 */
export function applyHunkToContent(
  content: string,
  hunk: ParsedHunk,
): ApplyResult | ApplyError {
  if (hunk.find === hunk.replace) {
    // Nothing to change — treat as a successful no-op.
    return { ok: true, newContent: content };
  }
  const occurrences = content.split(hunk.find).length - 1;
  if (occurrences === 0) {
    return { ok: false, error: "Patch anchor not found in content" };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      error: "Patch anchor is ambiguous (appears more than once) — include more context lines",
    };
  }
  return { ok: true, newContent: content.replace(hunk.find, hunk.replace) };
}

// ---------------------------------------------------------------------------
// Convenience helper
// ---------------------------------------------------------------------------

/** Count `@@` hunk markers in a raw diff string. */
export function countHunks(raw: string): number {
  const normalized = raw.replace(/\r\n/g, "\n");
  let count = 0;
  for (const line of normalized.split("\n")) {
    if (line.startsWith("@@")) count++;
  }
  return count;
}
