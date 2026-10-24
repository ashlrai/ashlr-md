/**
 * Exact, unique find→replace — the frontend half of the MCP `/edit` round-trip.
 *
 * This MIRRORS the Rust `apply_unique_edit` contract (see
 * `src-tauri/src/ipc.rs`) exactly, so the agent-facing behavior is identical
 * regardless of which layer runs it:
 *   - empty `find`      → error
 *   - 0 matches         → "not found" error
 *   - exactly 1 match   → replace the single occurrence
 *   - >1 matches        → "not unique" error (reports the count)
 *
 * WHY this lives on the frontend: the edit must apply against the LIVE document
 * the user is editing, not the 200 ms-debounced server-side mirror. Running it
 * here against `documentStore`'s current content both finds text typed within
 * the last debounce window and derives the new content from that live basis, so
 * applying the result can never clobber the user's just-typed edits.
 *
 * Also exports stream-edit diff utilities used by the `mcp://stream-edit` bridge
 * handler — preview-before-apply, multi-match ranking, and unified diff generation.
 */

export interface EditOutcome {
  ok: boolean;
  /** Replacements made: 1 on success, 0 on any failure. */
  replaced: number;
  /** The new full document content (only meaningful when `ok`). */
  content?: string;
  /** Human-readable reason when `ok` is false. */
  error?: string;
}

/** A match of `find` in a document: `[start, end)`. */
export interface FindMatch {
  start: number;
  end: number;
}

/**
 * The non-overlapping matches of `find` in `content`, in order. A line
 * break in `find` (`\n` or `\r\n`) matches either line break in `content`,
 * and every other character matches exactly, so an agent's LF `find`
 * matches the same text in a CRLF document: it used to be "not found"
 * there, though get_current_content's text, once the agent's client read
 * it, often had LF breaks. A match never starts between the `\r` and the
 * `\n` of a line break.
 */
export function findMatches(content: string, find: string): FindMatch[] {
  if (find === "") return [];
  const out: FindMatch[] = [];
  if (!find.includes("\n")) {
    let from = 0;
    for (;;) {
      const i = content.indexOf(find, from);
      if (i === -1) break;
      // Advance past this match (non-overlapping), mirroring Rust's
      // `str::matches`, which also counts non-overlapping matches.
      out.push({ start: i, end: i + find.length });
      from = i + find.length;
    }
    return out;
  }
  const pattern = find
    .split(/\r?\n/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\r?\\n");
  for (const m of content.matchAll(new RegExp(pattern, "g"))) {
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * The line break of `content` at `offset`: the one that ends its line, or
 * for the last line the one before it, `\n` when it has none. A
 * replacement is written in it, so a CRLF document (or a CRLF part of a
 * mixed one) keeps CRLF lines.
 */
function lineBreakAt(content: string, offset: number): string {
  let nl = content.indexOf("\n", offset);
  if (nl === -1) nl = content.lastIndexOf("\n", offset - 1);
  return nl > 0 && content[nl - 1] === "\r" ? "\r\n" : "\n";
}

/** `replace` with its line breaks in those of `content` at `offset`. */
function inDocumentLineBreaks(
  content: string,
  offset: number,
  replace: string,
): string {
  return replace.includes("\n")
    ? replace.replace(/\r?\n/g, lineBreakAt(content, offset))
    : replace;
}

/**
 * `content`, the whole new text of a document, in the style of `live`, the
 * text it replaces: CRLF line breaks when `live` is a CRLF document (it has
 * `\r\n` and no lone `\n`) and `content` has no `\r`, and the byte order
 * mark of `live` when `content` has none. An agent writes the whole text
 * with LF and no mark, so replacing a CRLF file changed every line of it on
 * save and dropped its mark. A `content` that carries `\r` or the mark of
 * its own is written as given.
 */
export function inDocumentStyle(live: string, content: string): string {
  const crlf = /\r\n/.test(live) && !/(^|[^\r])\n/.test(live);
  let out = crlf && !content.includes("\r") ? content.replace(/\n/g, "\r\n") : content;
  if (live.startsWith("\uFEFF") && !out.startsWith("\uFEFF")) out = `\uFEFF${out}`;
  return out;
}

/** `content` with `match` replaced by `replace`, in its line breaks. */
function replaceMatch(content: string, match: FindMatch, replace: string): string {
  return (
    content.slice(0, match.start) +
    inDocumentLineBreaks(content, match.start, replace) +
    content.slice(match.end)
  );
}

/**
 * What an edit answers when `find` is not in the live document. It used to
 * stop at "not found", with no next step, so an agent retried the same text;
 * the usual cause is text copied with other whitespace or line breaks, or a
 * document that changed since it was read.
 */
export const FIND_NOT_FOUND =
  "`find` string not found in the current document. It must match the document exactly, whitespace included (a line break matches LF or CRLF): read the live text with get_current_content and copy `find` from it.";

/**
 * Apply a single exact find→replace requiring `find` to appear EXACTLY once
 * ({@link findMatches}: a line break matches LF or CRLF). The replacement
 * is written in the document's line breaks. Returns the new content on
 * success, or a human-readable error otherwise. Pure — does not touch any
 * store.
 */
export function applyUniqueEdit(
  content: string,
  find: string,
  replace: string,
): EditOutcome {
  if (find === "") {
    return { ok: false, replaced: 0, error: "`find` must not be empty." };
  }
  const matches = findMatches(content, find);
  const n = matches.length;
  if (n === 0) {
    return {
      ok: false,
      replaced: 0,
      error: FIND_NOT_FOUND,
    };
  }
  if (n > 1) {
    return {
      ok: false,
      replaced: 0,
      error: `\`find\` string is not unique (${n} matches): include more surrounding context to disambiguate.`,
    };
  }
  return { ok: true, replaced: 1, content: replaceMatch(content, matches[0], replace) };
}

// ── Stream-edit diff utilities ────────────────────────────────────────────────
//
// These are pure functions used by the `mcp://stream-edit` bridge handler.
// They compute minimal unified diffs for preview-before-apply, handle multi-
// match ranking, and provide context-windowed diff output.

/**
 * One candidate diff when `find` matches at multiple locations.
 *
 * `matchIndex` — 0-based index of this occurrence in the document.
 * `startLine`  — 1-based line number of the first line of the match.
 * `diff`       — minimal unified diff string for this candidate only.
 * `rank`       — relevance rank (1 = best candidate; lower score = better).
 *                Currently assigned by occurrence order (first = rank 1),
 *                which matches user expectation for most editing workflows.
 */
export interface StreamEditCandidate {
  matchIndex: number;
  startLine: number;
  diff: string;
  rank: number;
}

/**
 * Result of `computeStreamEditDiff`.
 *
 * When `ok` is true:
 *   - `diff`       — unified diff for the unique (or first) match.
 *   - `candidates` — ranked list of diffs when `find` is not unique (length ≥ 2).
 *   - `matchCount` — total number of occurrences of `find` in `content`.
 *
 * When `ok` is false, `error` describes why (empty find, not found, etc.).
 */
export interface StreamEditDiffResult {
  ok: boolean;
  diff?: string;
  /** Populated only when matchCount > 1. */
  candidates?: StreamEditCandidate[];
  matchCount: number;
  error?: string;
}

/**
 * Collect all non-overlapping start indices of `needle` within `haystack`
 * ({@link findMatches}). Returns indices in document order.
 */
export function findAllOccurrences(haystack: string, needle: string): number[] {
  return findMatches(haystack, needle).map((m) => m.start);
}

/**
 * Convert a character offset into a 1-based line number within `content`.
 */
export function offsetToLine(content: string, offset: number): number {
  // Count newlines before `offset`.
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/**
 * Build a minimal unified diff string showing what changes when `find` at
 * `matchOffset` is replaced by `replace`.
 *
 * `contextLines` (default 3) controls how many unchanged lines surround the
 * changed region (matches `git diff -U<N>` semantics).
 *
 * The diff uses the standard unified format:
 *   --- a/<path>
 *   +++ b/<path>
 *   @@ -L,N +L,N @@
 *   -old lines
 *   +new lines
 *    context lines
 */
export function buildUnifiedDiff(
  content: string,
  find: string,
  replace: string,
  matchOffset: number,
  contextLines = 3,
  label = "document",
): string {
  const lines = content.split("\n");
  const afterContent =
    content.slice(0, matchOffset) + replace + content.slice(matchOffset + find.length);
  const afterLines = afterContent.split("\n");

  // The edit touches whole lines [s, s + removed) of the original. Everything
  // outside them is unchanged, so on the "after" side the same lines start at
  // s and span `replace`'s line count. The added lines are read from the
  // edited text, not from `replace`: a match inside a line keeps the text
  // around it ("Hello world" with "world" -> "there" reads "+Hello there").
  const s = offsetToLine(content, matchOffset) - 1;
  const removedLineCount = find.split("\n").length;
  const addedLineCount = replace.split("\n").length;

  // Context window, clamped to the file on each side.
  const ctxStart = Math.max(0, s - contextLines);
  const ctxBefore = s - ctxStart;
  const removeEnd = s + removedLineCount;
  const ctxEnd = Math.min(lines.length, removeEnd + contextLines);
  const ctxAfter = ctxEnd - removeEnd;

  // Hunk header: both sides start at the same line (nothing before the
  // change moved), and each side counts exactly the lines it lists.
  const aHunkLen = ctxBefore + removedLineCount + ctxAfter;
  const bHunkLen = ctxBefore + addedLineCount + ctxAfter;
  const hunkHeader = `@@ -${ctxStart + 1},${aHunkLen} +${ctxStart + 1},${bHunkLen} @@`;

  const diffLines: string[] = [`--- a/${label}`, `+++ b/${label}`, hunkHeader];
  for (let i = ctxStart; i < s; i++) diffLines.push(` ${lines[i]}`);
  for (let i = s; i < removeEnd; i++) diffLines.push(`-${lines[i]}`);
  for (let i = s; i < s + addedLineCount; i++) diffLines.push(`+${afterLines[i]}`);
  for (let i = removeEnd; i < ctxEnd; i++) diffLines.push(` ${lines[i]}`);

  return `${diffLines.join("\n")}\n`;
}

/**
 * Compute a stream-edit diff for `find`→`replace` against `content`.
 *
 * Behaviour:
 *  - `find` empty            → `{ ok: false, matchCount: 0, error }`
 *  - 0 matches               → `{ ok: false, matchCount: 0, error }`
 *  - exactly 1 match         → `{ ok: true, diff, matchCount: 1 }`
 *  - multiple matches        → `{ ok: true, diff (for match 0), candidates (ranked), matchCount: N }`
 *                               ok=true so the preview can still be shown; the
 *                               caller uses `candidates` to present choices.
 *
 * `contextLines` controls the `±N` lines of context in the unified diff.
 */
export function computeStreamEditDiff(
  content: string,
  find: string,
  replace: string,
  contextLines = 3,
  label = "document",
): StreamEditDiffResult {
  if (find === "") {
    return { ok: false, matchCount: 0, error: "`find` must not be empty." };
  }

  const matches = findMatches(content, find);

  if (matches.length === 0) {
    return {
      ok: false,
      matchCount: 0,
      error: FIND_NOT_FOUND,
    };
  }

  // Each diff shows the text matched and the replacement as it is written
  // (in the document's line breaks).
  const diffOf = (m: FindMatch) =>
    buildUnifiedDiff(
      content,
      content.slice(m.start, m.end),
      inDocumentLineBreaks(content, m.start, replace),
      m.start,
      contextLines,
      label,
    );

  if (matches.length === 1) {
    return { ok: true, diff: diffOf(matches[0]), matchCount: 1 };
  }

  // Multiple matches — build ranked candidates (rank 1 = first occurrence).
  const candidates: StreamEditCandidate[] = matches.map((m, idx) => ({
    matchIndex: idx,
    startLine: offsetToLine(content, m.start),
    diff: diffOf(m),
    rank: idx + 1,
  }));

  // Primary diff is the first (rank-1) candidate.
  return {
    ok: true,
    diff: candidates[0].diff,
    candidates,
    matchCount: matches.length,
  };
}

/**
 * Apply `find`→`replace` at a specific match occurrence (0-based `matchIndex`).
 *
 * Used by `mcp://stream-edit-apply` when the agent has confirmed a specific
 * candidate from a multi-match preview.  Falls back to the unique-edit path
 * when `matchIndex` is 0 and there is only one match.
 *
 * Returns an EditOutcome with the mutated content, or an error.
 */
export function applyEditAtOccurrence(
  content: string,
  find: string,
  replace: string,
  matchIndex: number,
): EditOutcome {
  if (find === "") {
    return { ok: false, replaced: 0, error: "`find` must not be empty." };
  }

  const matches = findMatches(content, find);

  if (matches.length === 0) {
    return {
      ok: false,
      replaced: 0,
      error: FIND_NOT_FOUND,
    };
  }

  if (matchIndex < 0 || matchIndex >= matches.length) {
    return {
      ok: false,
      replaced: 0,
      error:
        `matchIndex ${matchIndex} out of bounds: document has ${matches.length} occurrence(s). ` +
        `Use a match_index from 0 to ${matches.length - 1}, or call stream_edit again to see the candidates.`,
    };
  }

  return {
    ok: true,
    replaced: 1,
    content: replaceMatch(content, matches[matchIndex], replace),
  };
}
