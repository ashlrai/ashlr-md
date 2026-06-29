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

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    count += 1;
    // Advance past this match (non-overlapping), mirroring Rust's
    // `str::matches`, which also counts non-overlapping matches.
    from = i + needle.length;
  }
  return count;
}

/**
 * Apply a single exact find→replace requiring `find` to appear EXACTLY once.
 * Returns the new content on success, or a human-readable error otherwise.
 * Pure — does not touch any store.
 */
export function applyUniqueEdit(
  content: string,
  find: string,
  replace: string,
): EditOutcome {
  if (find === "") {
    return { ok: false, replaced: 0, error: "`find` must not be empty." };
  }
  const n = countOccurrences(content, find);
  if (n === 0) {
    return {
      ok: false,
      replaced: 0,
      error: "`find` string not found in the current document.",
    };
  }
  if (n > 1) {
    return {
      ok: false,
      replaced: 0,
      error: `\`find\` string is not unique (${n} matches) — include more surrounding context to disambiguate.`,
    };
  }
  // Replace only the first (and only) occurrence.
  const idx = content.indexOf(find);
  const next = content.slice(0, idx) + replace + content.slice(idx + find.length);
  return { ok: true, replaced: 1, content: next };
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
 * Collect all non-overlapping start indices of `needle` within `haystack`.
 * Returns indices in document order.
 */
export function findAllOccurrences(haystack: string, needle: string): number[] {
  if (needle === "") return [];
  const indices: number[] = [];
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    indices.push(i);
    from = i + needle.length;
  }
  return indices;
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
    content.slice(0, matchOffset) +
    replace +
    content.slice(matchOffset + find.length);
  const afterLines = afterContent.split("\n");

  // Determine the line range affected by the change.
  const findLines = find.split("\n");
  const replaceLines = replace.split("\n");

  // startLine: 1-based line where the match begins
  const startLine = offsetToLine(content, matchOffset);
  const removedLineCount = findLines.length;
  const addedLineCount = replaceLines.length;

  // Context window (clamped to actual file bounds)
  const ctxStart = Math.max(0, startLine - 1 - contextLines);
  const removeEnd = startLine - 1 + removedLineCount;
  const ctxEnd = Math.min(lines.length, removeEnd + contextLines);

  // Build hunk lines for "before" (a) side
  const aLines = lines.slice(ctxStart, ctxEnd);
  // Build hunk lines for "after" (b) side
  const bStart = ctxStart;
  const bEnd = Math.min(afterLines.length, ctxStart + contextLines + addedLineCount + contextLines);

  // Hunk header numbers
  const aHunkStart = ctxStart + 1;
  const aHunkLen = ctxEnd - ctxStart;
  const bHunkStart = ctxStart + 1;
  const bHunkLen = bEnd - bStart;

  const hunkHeader = `@@ -${aHunkStart},${aHunkLen} +${bHunkStart},${bHunkLen} @@`;

  // Produce diff lines by walking both sides
  const diffLines: string[] = [
    `--- a/${label}`,
    `+++ b/${label}`,
    hunkHeader,
  ];

  // Context before change
  const ctxBefore = startLine - 1 - ctxStart;
  for (let i = 0; i < ctxBefore; i++) {
    diffLines.push(` ${aLines[i] ?? ""}`);
  }
  // Removed lines
  for (let i = 0; i < removedLineCount; i++) {
    diffLines.push(`-${aLines[ctxBefore + i] ?? ""}`);
  }
  // Added lines
  for (let i = 0; i < addedLineCount; i++) {
    diffLines.push(`+${replaceLines[i]}`);
  }
  // Context after change
  const ctxAfterStart = ctxBefore + removedLineCount;
  for (let i = ctxAfterStart; i < aLines.length; i++) {
    diffLines.push(` ${aLines[i]}`);
  }

  return diffLines.join("\n") + "\n";
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

  const offsets = findAllOccurrences(content, find);

  if (offsets.length === 0) {
    return {
      ok: false,
      matchCount: 0,
      error: "`find` string not found in the document.",
    };
  }

  if (offsets.length === 1) {
    const diff = buildUnifiedDiff(content, find, replace, offsets[0], contextLines, label);
    return { ok: true, diff, matchCount: 1 };
  }

  // Multiple matches — build ranked candidates (rank 1 = first occurrence).
  const candidates: StreamEditCandidate[] = offsets.map((offset, idx) => ({
    matchIndex: idx,
    startLine: offsetToLine(content, offset),
    diff: buildUnifiedDiff(content, find, replace, offset, contextLines, label),
    rank: idx + 1,
  }));

  // Primary diff is the first (rank-1) candidate.
  return {
    ok: true,
    diff: candidates[0].diff,
    candidates,
    matchCount: offsets.length,
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

  const offsets = findAllOccurrences(content, find);

  if (offsets.length === 0) {
    return {
      ok: false,
      replaced: 0,
      error: "`find` string not found in the document.",
    };
  }

  if (matchIndex < 0 || matchIndex >= offsets.length) {
    return {
      ok: false,
      replaced: 0,
      error: `matchIndex ${matchIndex} out of bounds — document has ${offsets.length} occurrence(s).`,
    };
  }

  const offset = offsets[matchIndex];
  const next =
    content.slice(0, offset) + replace + content.slice(offset + find.length);
  return { ok: true, replaced: 1, content: next };
}
