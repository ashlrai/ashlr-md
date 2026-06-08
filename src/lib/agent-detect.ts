/**
 * agent-detect.ts
 *
 * Pure, side-effect-free helpers that classify a Markdown document into one of
 * several "agent output" kinds so the Renderer can display a contextual badge.
 *
 * Kinds:
 *   "plan"       — starts with a top-level heading + contains GFM task items
 *   "diff"       — contains one or more ```diff fenced code blocks
 *   "multi-file" — repeated ### path/to/file headings followed by code blocks
 *   "generic"    — agent output that doesn't match a specific pattern
 *   null         — ordinary document (no agent fingerprint detected)
 *
 * All helpers operate on the raw markdown string. No AST traversal needed here
 * — regex heuristics are fast and sufficient for detection purposes.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocKind = "plan" | "diff" | "multi-file" | "generic" | null;

export interface DocInfo {
  /** Detected document kind, or null for plain docs. */
  kind: DocKind;
  /** Total task items found (GFM `- [ ]` / `- [x]`). */
  taskTotal: number;
  /** Completed task items (`- [x]`). */
  taskDone: number;
  /** Total diff hunks found (kind === "diff" only; 0 otherwise). */
  hunkTotal: number;
}

// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

/** Matches GFM task-list items (checked or unchecked). */
const TASK_RE = /^[ \t]*(?:[-*+]|\d+\.)\s+\[([ xX])\]\s/gm;

/** Matches a fenced diff block opening fence. */
const DIFF_FENCE_RE = /^```diff\b/m;

/**
 * Matches a `### some/path/file.ext` heading that looks like a file path
 * (contains a slash, dot, or looks like a filename with extension).
 */
const FILE_HEADING_RE = /^#{1,4}\s+[\w./\\-]+(?:\/[\w./\\-]+|\.\w+)/gm;

/** Detects a top-level h1 heading. */
const H1_RE = /^#\s+\S/m;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count GFM task-list items in a markdown string. */
function countTasks(content: string): { total: number; done: number } {
  let total = 0;
  let done = 0;
  // Reset lastIndex since we reuse the regex
  TASK_RE.lastIndex = 0;
  let m: RegExpExecArray | null = TASK_RE.exec(content);
  while (m !== null) {
    total++;
    if (m[1] !== " ") done++;
    m = TASK_RE.exec(content);
  }
  return { total, done };
}

/** Count occurrences of file-path-style headings. */
function countFileHeadings(content: string): number {
  FILE_HEADING_RE.lastIndex = 0;
  return (content.match(FILE_HEADING_RE) ?? []).length;
}

/** Count `@@` hunk headers in a raw diff string (inline to avoid import cycle). */
function countHunksInline(content: string): number {
  let n = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("@@")) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Analyse `content` and return a {@link DocInfo} describing its kind and task
 * completion statistics.
 *
 * @param content  Raw markdown string (full document, including frontmatter).
 */
export function detectDocKind(content: string): DocInfo {
  if (!content || content.trim() === "") {
    return { kind: null, taskTotal: 0, taskDone: 0, hunkTotal: 0 };
  }

  const { total: taskTotal, done: taskDone } = countTasks(content);

  // ── diff: any ```diff block is a strong signal ───────────────────────────
  if (DIFF_FENCE_RE.test(content)) {
    return { kind: "diff", taskTotal, taskDone, hunkTotal: countHunksInline(content) };
  }

  // ── multi-file: ≥3 file-path headings ────────────────────────────────────
  if (countFileHeadings(content) >= 3) {
    return { kind: "multi-file", taskTotal, taskDone, hunkTotal: 0 };
  }

  // ── plan: starts with an h1 AND has task items ───────────────────────────
  if (H1_RE.test(content) && taskTotal >= 2) {
    return { kind: "plan", taskTotal, taskDone, hunkTotal: 0 };
  }

  // ── generic agent output: many tasks but no h1 ───────────────────────────
  if (taskTotal >= 2) {
    return { kind: "generic", taskTotal, taskDone, hunkTotal: 0 };
  }

  return { kind: null, taskTotal, taskDone, hunkTotal: 0 };
}

// ---------------------------------------------------------------------------
// Re-export toggleTaskAtLine for convenience (Renderer only needs one import)
// ---------------------------------------------------------------------------
export { isTaskLine, toggleTaskAtLine } from "./tasklist";
