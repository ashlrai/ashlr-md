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
 */

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
 * Matches level-2 headings; case-insensitive.
 */
const SPEC_HEADINGS_RE =
  /^##\s+(?:requirements?|design|implementation|architecture|api\s+design|interface\s+spec)/im;

/**
 * Review heading signals: ## Files Changed, ## Summary, ## Feedback (and variants).
 */
const REVIEW_HEADINGS_RE =
  /^##\s+(?:files?\s+changed|summary|feedback|findings?|comments?|review\s+notes?)/im;

/**
 * Numbered step in a runbook (e.g. `1.` or `**Step 1:**` or `### Step 1`).
 */
const RUNBOOK_STEP_RE = /^(?:#{1,4}\s+[Ss]tep\s+\d+|\d+\.\s+\S|\*\*[Ss]tep\s+\d+)/gm;

/**
 * Acceptance-criteria heading: ## Acceptance Criteria, ## Success Criteria, etc.
 */
const CRITERIA_HEADING_RE =
  /^##\s+(?:acceptance\s+criteria|success\s+criteria|criteria|done\s+when|definition\s+of\s+done)/im;

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

/**
 * Count heading-level spec signals.
 * Returns true when at least 2 of the 3 canonical spec sections are present.
 */
function hasSpecHeadingStructure(content: string): boolean {
  const hits = [
    /^##\s+requirements?/im,
    /^##\s+design/im,
    /^##\s+implementation/im,
    /^##\s+architecture/im,
    /^##\s+api\s+design/im,
  ].filter((re) => re.test(content));
  return hits.length >= 2;
}

/**
 * Count heading-level review signals.
 * Returns true when at least 2 canonical review sections are present.
 */
function hasReviewHeadingStructure(content: string): boolean {
  const hits = [
    /^##\s+files?\s+changed/im,
    /^##\s+summary/im,
    /^##\s+feedback/im,
    /^##\s+findings?/im,
    /^##\s+comments?/im,
    /^##\s+review\s+notes?/im,
  ].filter((re) => re.test(content));
  return hits.length >= 2;
}

/**
 * Count heading-level runbook signals.
 * Returns true when at least 2 canonical runbook sections are present AND
 * the document contains at least one fenced code block.
 */
function hasRunbookStructure(content: string): boolean {
  const headingHits = [
    /^##\s+prerequisites?/im,
    /^##\s+steps?/im,
    /^##\s+rollback/im,
    /^##\s+procedure/im,
    /^##\s+troubleshooting/im,
    /^##\s+verification/im,
  ].filter((re) => re.test(content));
  return headingHits.length >= 2 && CODE_FENCE_RE.test(content);
}

/** Count numbered steps in a runbook document. */
function countRunbookSteps(content: string): number {
  RUNBOOK_STEP_RE.lastIndex = 0;
  return (content.match(RUNBOOK_STEP_RE) ?? []).length;
}

/**
 * Extract acceptance-criteria task items from a spec document.
 * Looks for a criteria-heading and collects all GFM task items that follow it
 * until the next same-level (##) heading.
 */
function extractAcceptanceCriteria(content: string): string[] {
  const lines = content.split("\n");
  const results: string[] = [];
  let inCriteriaSection = false;

  for (const line of lines) {
    // Enter criteria section when we hit a criteria heading.
    if (CRITERIA_HEADING_RE.test(line)) {
      inCriteriaSection = true;
      continue;
    }
    // Exit criteria section when we hit the next ## heading.
    if (inCriteriaSection && /^##\s+/.test(line)) {
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
  if (countFileHeadings(content) >= 3) {
    return { kind: "multi-file", taskTotal, taskDone, hunkTotal: 0 };
  }

  // ── 4. runbook: structural heading + code signal ──────────────────────────
  if (hasRunbookStructure(content)) {
    const stepCount = countRunbookSteps(content);
    return { kind: "runbook", taskTotal, taskDone, hunkTotal: 0, stepCount };
  }

  // ── 5. spec: structural heading signal ───────────────────────────────────
  if (hasSpecHeadingStructure(content) || (SPEC_HEADINGS_RE.test(content) && CRITERIA_HEADING_RE.test(content))) {
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
  if (hasReviewHeadingStructure(content) || (REVIEW_HEADINGS_RE.test(content) && countFileHeadings(content) >= 1)) {
    return { kind: "review", taskTotal, taskDone, hunkTotal: 0 };
  }

  // ── 7. plan: starts with an h1 AND has task items ────────────────────────
  if (H1_RE.test(content) && taskTotal >= 2) {
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
