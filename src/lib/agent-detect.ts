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
 *   "spec"       — frontmatter `kind: spec` OR heading pattern (## Requirements, ## Design, ## Implementation)
 *   "review"     — frontmatter `kind: review` OR heading pattern (## Files Changed, ## Summary, ## Feedback)
 *   "runbook"    — frontmatter `kind: runbook` OR heading + code pattern (## Prerequisites, ## Steps, ## Rollback)
 *   "generic"    — agent output that doesn't match a specific pattern
 *   null         — ordinary document (no agent fingerprint detected)
 *
 * All helpers operate on the raw markdown string. No AST traversal needed here
 * — regex heuristics are fast and sufficient for detection purposes.
 *
 * Headings are read by outline.ts's atxHeadings, outside front matter and
 * fenced code: a column-0 regex used to take a `# comment` in a code sample
 * as a heading, so a shell script's `# e.g. foo` counted as a file-path
 * heading and a `## Next` in a code block ended the acceptance criteria.
 */

import { type AtxHeading, atxHeading, atxHeadings, markdownLines } from "./outline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocKind =
  | "plan"
  | "diff"
  | "multi-file"
  | "spec"
  | "review"
  | "runbook"
  | "generic"
  | null;

export interface DocInfo {
  /** Detected document kind, or null for plain docs. */
  kind: DocKind;
  /** Total task items found (GFM `- [ ]` / `- [x]`). */
  taskTotal: number;
  /** Completed task items (`- [x]`). */
  taskDone: number;
  /** Total diff hunks found (kind === "diff" only; 0 otherwise). */
  hunkTotal: number;
  /**
   * For "spec" docs: acceptance-criteria items extracted from the document.
   * Each item is the raw text of a task-list line under a criteria-related heading.
   */
  acceptanceCriteria?: string[];
  /**
   * For "runbook" docs: the total number of numbered steps detected.
   */
  stepCount?: number;
}

// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

/** Matches a line that is a GFM task-list item (checked or unchecked). */
const TASK_RE = /^[ \t]*(?:[-*+]|\d+\.)[ \t]+\[([ xX])\](?:\s|$)/;

/** Matches a fenced diff block opening fence. */
const DIFF_FENCE_RE = /^```diff\b/m;

/**
 * Matches the text of a level 1 to 4 `### some/path/file.ext` heading that
 * looks like a file path (contains a slash, dot, or looks like a filename
 * with extension).
 */
const FILE_HEADING_RE = /^[\w./\\-]+(?:\/[\w./\\-]+|\.\w+)/;

// ---------------------------------------------------------------------------
// New-kind regexes
// ---------------------------------------------------------------------------

/**
 * Matches `kind: <value>` inside a YAML frontmatter block.
 * Only looks at the frontmatter region (first `---…---` block).
 */
const FRONTMATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;
const FRONTMATTER_KIND_RE = /^kind\s*:\s*(\S+)/m;

/**
 * Spec heading signals: ## Requirements, ## Design, ## Implementation (and variants).
 * Matches the text of level-2 headings; case-insensitive.
 */
const SPEC_HEADINGS_RE =
  /^(?:requirements?|design|implementation|architecture|api\s+design|interface\s+spec)/i;

/**
 * Review heading signals: ## Files Changed, ## Summary, ## Feedback (and variants).
 */
const REVIEW_HEADINGS_RE =
  /^(?:files?\s+changed|summary|feedback|findings?|comments?|review\s+notes?)/i;

/**
 * Numbered step in a runbook (e.g. `1.` or `**Step 1:**`); a `### Step 1`
 * heading (level 1 to 4) is matched on its text by RUNBOOK_STEP_HEADING_RE.
 */
const RUNBOOK_STEP_RE = /^(?:\d+\.\s+\S|\*\*[Ss]tep\s+\d+)/;
const RUNBOOK_STEP_HEADING_RE = /^[Ss]tep\s+\d+/;

/**
 * Acceptance-criteria heading text: ## Acceptance Criteria, ## Success Criteria, etc.
 */
const CRITERIA_HEADING_RE =
  /^(?:acceptance\s+criteria|success\s+criteria|criteria|done\s+when|definition\s+of\s+done)/i;

/**
 * A fenced code block — used to confirm runbook (code as commands is a strong signal).
 */
const CODE_FENCE_RE = /^```\w*/m;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the `kind` value from a YAML frontmatter block, or null if absent /
 * invalid. Only reads the first `---…---` block at the top of the document.
 */
export function parseFrontmatterKind(content: string): string | null {
  const blockMatch = FRONTMATTER_BLOCK_RE.exec(content);
  if (!blockMatch) return null;
  const kindMatch = FRONTMATTER_KIND_RE.exec(blockMatch[1]);
  if (!kindMatch) return null;
  // Strip surrounding quotes if present (e.g. kind: "spec")
  return kindMatch[1].replace(/^["']|["']$/g, "").toLowerCase();
}

/** True when some level-2 heading's text matches `re`. */
function hasH2(headings: AtxHeading[], re: RegExp): boolean {
  return headings.some((h) => h.depth === 2 && re.test(h.text));
}

/** How many of `patterns` some level-2 heading's text matches. */
function h2Hits(headings: AtxHeading[], patterns: RegExp[]): number {
  return patterns.filter((re) => hasH2(headings, re)).length;
}

/**
 * Count heading-level spec signals.
 * Returns true when at least 2 of the 3 canonical spec sections are present.
 */
function hasSpecHeadingStructure(headings: AtxHeading[]): boolean {
  const hits = h2Hits(headings, [
    /^requirements?/i,
    /^design/i,
    /^implementation/i,
    /^architecture/i,
    /^api\s+design/i,
  ]);
  return hits >= 2;
}

/**
 * Count heading-level review signals.
 * Returns true when at least 2 canonical review sections are present.
 */
function hasReviewHeadingStructure(headings: AtxHeading[]): boolean {
  const hits = h2Hits(headings, [
    /^files?\s+changed/i,
    /^summary/i,
    /^feedback/i,
    /^findings?/i,
    /^comments?/i,
    /^review\s+notes?/i,
  ]);
  return hits >= 2;
}

/**
 * Count heading-level runbook signals.
 * Returns true when at least 2 canonical runbook sections are present AND
 * the document contains at least one fenced code block.
 */
function hasRunbookStructure(content: string, headings: AtxHeading[]): boolean {
  const headingHits = h2Hits(headings, [
    /^prerequisites?/i,
    /^steps?/i,
    /^rollback/i,
    /^procedure/i,
    /^troubleshooting/i,
    /^verification/i,
  ]);
  return headingHits >= 2 && CODE_FENCE_RE.test(content);
}

/**
 * Count numbered steps in a runbook document: `1.` and `**Step 1` lines and
 * level 1 to 4 `Step 1` headings, outside front matter and fenced code (a
 * numbered line in a code sample used to count).
 */
function countRunbookSteps(content: string): number {
  let n = 0;
  for (const l of markdownLines(content)) {
    if (l.kind !== "text") continue;
    const h = atxHeading(l.text);
    if (
      h
        ? h.depth <= 4 && RUNBOOK_STEP_HEADING_RE.test(h.text)
        : RUNBOOK_STEP_RE.test(l.text)
    ) {
      n++;
    }
  }
  return n;
}

/**
 * Extract acceptance-criteria task items from a spec document.
 * Looks for a criteria-heading and collects all GFM task items that follow it
 * until the next same-level (##) heading.
 */
function extractAcceptanceCriteria(content: string): string[] {
  const results: string[] = [];
  let inCriteriaSection = false;

  // Front matter and fenced code are neither headings nor criteria.
  for (const { kind, text: line } of markdownLines(content)) {
    if (kind !== "text") continue;
    const h = atxHeading(line);
    // Enter criteria section when we hit a criteria heading.
    if (h?.depth === 2 && CRITERIA_HEADING_RE.test(h.text)) {
      inCriteriaSection = true;
      continue;
    }
    // Exit criteria section when we hit the next ## heading.
    if (inCriteriaSection && h?.depth === 2) {
      inCriteriaSection = false;
      continue;
    }
    // Collect task items inside the criteria section.
    if (inCriteriaSection) {
      const m = /^[ \t]*(?:[-*+]|\d+\.)\s+\[([ xX])\]\s+(.+)/.exec(line);
      if (m) {
        results.push(m[2].trim());
      }
    }
  }
  return results;
}

/**
 * Count GFM task-list items in a markdown string, outside front matter and
 * fenced code ({@link markdownLines}): a `- [ ]` line in a code sample is
 * not a task, and it used to count toward the badge and the status bar.
 */
function countTasks(content: string): { total: number; done: number } {
  let total = 0;
  let done = 0;
  for (const l of markdownLines(content)) {
    if (l.kind !== "text") continue;
    const m = TASK_RE.exec(l.text);
    if (!m) continue;
    total++;
    if (m[1] !== " ") done++;
  }
  return { total, done };
}

/** Count level 1 to 4 headings whose text looks like a file path. */
function countFileHeadings(headings: AtxHeading[]): number {
  return headings.filter((h) => h.depth <= 4 && FILE_HEADING_RE.test(h.text)).length;
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
 * Detection priority (highest → lowest):
 *   1. Explicit frontmatter `kind:` marker — always wins
 *   2. diff  — any ```diff block
 *   3. multi-file — ≥3 file-path headings
 *   4. runbook — ≥2 runbook headings + code fence
 *   5. spec  — ≥2 spec headings (or spec heading + criteria heading)
 *   6. review (heading-based) — ≥2 review headings
 *   7. plan — h1 + ≥2 task items
 *   8. generic — ≥2 task items, no h1
 *
 * @param content  Raw markdown string (full document, including frontmatter).
 */
export function detectDocKind(content: string): DocInfo {
  if (!content || content.trim() === "") {
    return { kind: null, taskTotal: 0, taskDone: 0, hunkTotal: 0 };
  }

  const { total: taskTotal, done: taskDone } = countTasks(content);
  const headings = atxHeadings(content);

  // ── 1. Explicit frontmatter kind marker ──────────────────────────────────
  const fmKind = parseFrontmatterKind(content);
  if (fmKind === "spec") {
    const criteria = extractAcceptanceCriteria(content);
    return {
      kind: "spec",
      taskTotal,
      taskDone,
      hunkTotal: 0,
      acceptanceCriteria: criteria,
    };
  }
  if (fmKind === "review") {
    return { kind: "review", taskTotal, taskDone, hunkTotal: 0 };
  }
  if (fmKind === "runbook") {
    const stepCount = countRunbookSteps(content);
    return { kind: "runbook", taskTotal, taskDone, hunkTotal: 0, stepCount };
  }

  // ── 2. diff: any ```diff block is a strong signal ────────────────────────
  if (DIFF_FENCE_RE.test(content)) {
    return { kind: "diff", taskTotal, taskDone, hunkTotal: countHunksInline(content) };
  }

  // ── 3. multi-file: ≥3 file-path headings ─────────────────────────────────
  if (countFileHeadings(headings) >= 3) {
    return { kind: "multi-file", taskTotal, taskDone, hunkTotal: 0 };
  }

  // ── 4. runbook: structural heading + code signal ──────────────────────────
  if (hasRunbookStructure(content, headings)) {
    const stepCount = countRunbookSteps(content);
    return { kind: "runbook", taskTotal, taskDone, hunkTotal: 0, stepCount };
  }

  // ── 5. spec: structural heading signal ───────────────────────────────────
  if (
    hasSpecHeadingStructure(headings) ||
    (hasH2(headings, SPEC_HEADINGS_RE) && hasH2(headings, CRITERIA_HEADING_RE))
  ) {
    const criteria = extractAcceptanceCriteria(content);
    return {
      kind: "spec",
      taskTotal,
      taskDone,
      hunkTotal: 0,
      acceptanceCriteria: criteria,
    };
  }

  // ── 6. review: structural heading signal ─────────────────────────────────
  if (
    hasReviewHeadingStructure(headings) ||
    (hasH2(headings, REVIEW_HEADINGS_RE) && countFileHeadings(headings) >= 1)
  ) {
    return { kind: "review", taskTotal, taskDone, hunkTotal: 0 };
  }

  // ── 7. plan: starts with an h1 AND has task items ────────────────────────
  if (headings.some((h) => h.depth === 1 && h.text !== "") && taskTotal >= 2) {
    return { kind: "plan", taskTotal, taskDone, hunkTotal: 0 };
  }

  // ── 8. generic agent output: many tasks but no h1 ────────────────────────
  if (taskTotal >= 2) {
    return { kind: "generic", taskTotal, taskDone, hunkTotal: 0 };
  }

  return { kind: null, taskTotal, taskDone, hunkTotal: 0 };
}

// ---------------------------------------------------------------------------
// Re-export toggleTaskAtLine for convenience (Renderer only needs one import)
// ---------------------------------------------------------------------------
export { isTaskLine, toggleTaskAtLine } from "./tasklist";
