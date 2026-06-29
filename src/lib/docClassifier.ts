/**
 * docClassifier.ts
 *
 * Pure, side-effect-free classifier that maps a Markdown document to one of
 * five semantic types:
 *
 *   "PLAN"     — project/feature plans, roadmaps, to-do lists with tasks
 *   "REVIEW"   — code review, PR feedback, assessment, findings docs
 *   "SPEC"     — technical specifications, requirements, API/design docs
 *   "RUNBOOK"  — operational runbooks, deployment guides, step-by-step procedures
 *   "GENERIC"  — anything that doesn't fit a more specific type
 *
 * Detection uses four independent signal families that are combined via a
 * confidence-weighted sum; the type with the highest score wins.
 *
 * Signal families:
 *   1. Heading patterns  — regex matches on `##` / `###` section headings
 *   2. Word frequency    — occurrence counts of domain-characteristic terms
 *   3. Checklist density — ratio of GFM task-list items to total lines
 *   4. Code-block density — ratio of fenced code-block lines to total lines
 *
 * The classifier is intentionally distinct from `agent-detect.ts` / `DocKind`.
 * That module classifies agent *output*; this module classifies the *semantic
 * purpose* of any Markdown document. The types map to UI affordances (sidebar
 * prompts, renderer selection) rather than agent-badge display.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DocType = "PLAN" | "REVIEW" | "SPEC" | "RUNBOOK" | "GENERIC";

// ---------------------------------------------------------------------------
// Heading-pattern signals
// ---------------------------------------------------------------------------

/**
 * Per-type heading regexes. Each regex is tested against the full document; a
 * hit contributes a fixed weight to that type's score.
 */
const HEADING_PATTERNS: Record<Exclude<DocType, "GENERIC">, RegExp[]> = {
  PLAN: [
    /^#{1,3}\s+(?:project\s+plan|feature\s+plan|roadmap|milestone|sprint|iteration|release\s+plan)/im,
    /^#{1,3}\s+(?:goals?|objectives?|tasks?|action\s+items?|deliverables?)/im,
    /^#{1,3}\s+(?:timeline|schedule|phases?|kickoff)/im,
    /^#{1,3}\s+(?:open\s+questions?|risks?|blockers?|dependencies)/im,
    /^#{1,3}\s+(?:implementation\s+plan|execution\s+plan|work\s+plan)/im,
  ],
  REVIEW: [
    /^#{1,3}\s+(?:code\s+review|pr\s+review|pull\s+request\s+review)/im,
    /^#{1,3}\s+(?:files?\s+changed|files?\s+reviewed)/im,
    /^#{1,3}\s+(?:feedback|comments?|review\s+notes?|reviewer\s+notes?)/im,
    /^#{1,3}\s+(?:findings?|issues?\s+found|concerns?|recommendations?)/im,
    /^#{1,3}\s+(?:summary|assessment|overall|verdict|approval)/im,
    /^#{1,3}\s+(?:blocking|non[-\s]blocking|minor|major|nitpick)/im,
    /^#{1,3}\s+(?:lgtm|approved?|request(?:ed)?\s+changes?)/im,
  ],
  SPEC: [
    /^#{1,3}\s+(?:specification|technical\s+spec|api\s+spec|design\s+spec)/im,
    /^#{1,3}\s+(?:requirements?|functional\s+requirements?|non[-\s]functional)/im,
    /^#{1,3}\s+(?:architecture|design|system\s+design|high[-\s]level\s+design)/im,
    /^#{1,3}\s+(?:api\s+design|interface|data\s+model|schema)/im,
    /^#{1,3}\s+(?:acceptance\s+criteria|success\s+criteria|definition\s+of\s+done)/im,
    /^#{1,3}\s+(?:scope|out\s+of\s+scope|constraints?|assumptions?)/im,
    /^#{1,3}\s+(?:motivation|background|context|problem\s+statement)/im,
  ],
  RUNBOOK: [
    /^#{1,3}\s+(?:runbook|operations?\s+guide|operational\s+procedure)/im,
    /^#{1,3}\s+(?:prerequisites?|pre[-\s]requisites?|requirements?)/im,
    /^#{1,3}\s+(?:steps?|procedure|instructions?|how\s+to)/im,
    /^#{1,3}\s+(?:rollback|roll[-\s]back|undo|revert\s+steps?)/im,
    /^#{1,3}\s+(?:troubleshooting|debugging|diagnosis|common\s+errors?)/im,
    /^#{1,3}\s+(?:verification|validation|post[-\s]deploy|smoke\s+test)/im,
    /^#{1,3}\s+(?:deployment|deploy|release\s+steps?|on[-\s]call)/im,
  ],
};

/** Weight applied per heading-pattern hit. */
const HEADING_HIT_WEIGHT = 12;

// ---------------------------------------------------------------------------
// Word-frequency signals
// ---------------------------------------------------------------------------

/**
 * Per-type term lists. Each occurrence of a term in the plain-text body
 * contributes a small fractional weight. We count distinct terms (not raw
 * occurrences) so a single repeated word can't dominate.
 */
const WORD_TERMS: Record<Exclude<DocType, "GENERIC">, RegExp[]> = {
  PLAN: [
    /\bplan\b/gi,
    /\btask\b/gi,
    /\bgoal\b/gi,
    /\bobjective\b/gi,
    /\bmilestone\b/gi,
    /\btimeline\b/gi,
    /\bdeadline\b/gi,
    /\bpriority\b/gi,
    /\bowner\b/gi,
    /\bphase\b/gi,
    /\bsprint\b/gi,
    /\bepic\b/gi,
    /\bbacklog\b/gi,
    /\broadmap\b/gi,
    /\bdeliverable\b/gi,
    /\bschedule\b/gi,
    /\baction\s+item\b/gi,
    /\bkickoff\b/gi,
    /\bstakeholder\b/gi,
    /\bsuccess\s+criteria\b/gi,
  ],
  REVIEW: [
    /\breview\b/gi,
    /\bfeedback\b/gi,
    /\bassessment\b/gi,
    /\bapprove[d]?\b/gi,
    /\blgtm\b/gi,
    /\bnit\b/gi,
    /\bblocking\b/gi,
    /\bcomment\b/gi,
    /\bsuggest\b/gi,
    /\bconcern\b/gi,
    /\bfinding\b/gi,
    /\bissue\s+found\b/gi,
    /\bnit[-\s]?pick\b/gi,
    /\bchange\s+request\b/gi,
    /\brequest(?:ed)?\s+changes?\b/gi,
    /\blooks\s+good\b/gi,
    /\bcode\s+review\b/gi,
    /\bpr\s+review\b/gi,
    /\breviewer\b/gi,
    /\bcritique\b/gi,
  ],
  SPEC: [
    /\bspecification\b/gi,
    /\brequirement\b/gi,
    /\binterface\b/gi,
    /\barchitecture\b/gi,
    /\bdesign\b/gi,
    /\bschema\b/gi,
    /\bendpoint\b/gi,
    /\bapi\b/gi,
    /\bcontract\b/gi,
    /\bdefinition\b/gi,
    /\bconstraint\b/gi,
    /\bscope\b/gi,
    /\bassumption\b/gi,
    /\bdata\s+model\b/gi,
    /\buse\s+case\b/gi,
    /\bactor\b/gi,
    /\bflow\b/gi,
    /\bsequence\s+diagram\b/gi,
    /\bcriteria\b/gi,
    /\bsuccess\s+metric\b/gi,
  ],
  RUNBOOK: [
    /\brunbook\b/gi,
    /\bprerequisite\b/gi,
    /\brollback\b/gi,
    /\btroubleshoot\b/gi,
    /\bdeploy\b/gi,
    /\bprocedure\b/gi,
    /\bverif(?:y|ication)\b/gi,
    /\binstruction\b/gi,
    /\bon[-\s]?call\b/gi,
    /\bincident\b/gi,
    /\bmitigate\b/gi,
    /\bpost[-\s]mortem\b/gi,
    /\bsla\b/gi,
    /\bmonitoring\b/gi,
    /\balert\b/gi,
    /\bexecute\b/gi,
    /\brun\s+the\s+following\b/gi,
    /\bcommand\b/gi,
    /\bscript\b/gi,
    /\bstep[-\s]\d+\b/gi,
  ],
};

/** Weight per distinct matched word-term. */
const WORD_HIT_WEIGHT = 2;

// ---------------------------------------------------------------------------
// GFM task-list density
// ---------------------------------------------------------------------------

const TASK_LINE_RE = /^[ \t]*(?:[-*+]|\d+\.)\s+\[[ xX]\]/gm;

/**
 * Compute the ratio of task-list lines to total non-blank lines.
 * Returns a value in [0, 1].
 */
function checklistDensity(content: string): number {
  const lines = content.split("\n");
  const nonBlank = lines.filter((l) => l.trim().length > 0).length;
  if (nonBlank === 0) return 0;
  const taskMatches = content.match(TASK_LINE_RE);
  const taskLines = taskMatches ? taskMatches.length : 0;
  return taskLines / nonBlank;
}

// ---------------------------------------------------------------------------
// Code-block density
// ---------------------------------------------------------------------------

/**
 * Compute the ratio of lines inside fenced code blocks to total document lines.
 * Returns a value in [0, 1].
 */
function codeBlockDensity(content: string): number {
  const lines = content.split("\n");
  const total = lines.length;
  if (total === 0) return 0;

  let codeLines = 0;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) codeLines++;
  }
  return codeLines / total;
}

// ---------------------------------------------------------------------------
// Numbered-steps signal (strong RUNBOOK indicator)
// ---------------------------------------------------------------------------

const NUMBERED_STEP_RE = /^(?:\d+\.\s+\S|\*\*[Ss]tep\s+\d+|#{1,4}\s+[Ss]tep\s+\d+)/gm;

function countNumberedSteps(content: string): number {
  const m = content.match(NUMBERED_STEP_RE);
  return m ? m.length : 0;
}

// ---------------------------------------------------------------------------
// Frontmatter type hint (highest priority)
// ---------------------------------------------------------------------------

const FM_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;
const FM_TYPE_RE = /^(?:type|kind|doc_type|doctype)\s*:\s*(\S+)/im;

/**
 * Read an explicit `type:` / `kind:` / `doc_type:` value from frontmatter.
 * Returns the normalised DocType string, or null if absent / unrecognised.
 */
function frontmatterDocType(content: string): DocType | null {
  const blockMatch = FM_BLOCK_RE.exec(content);
  if (!blockMatch) return null;
  const m = FM_TYPE_RE.exec(blockMatch[1]);
  if (!m) return null;
  const raw = m[1].replace(/^["']|["']$/g, "").toUpperCase();
  if (raw === "PLAN" || raw === "REVIEW" || raw === "SPEC" || raw === "RUNBOOK" || raw === "GENERIC") {
    return raw as DocType;
  }
  // Also accept lowercase synonyms used in agent-detect frontmatter
  const synonyms: Record<string, DocType> = {
    SPEC: "SPEC",
    REVIEW: "REVIEW",
    RUNBOOK: "RUNBOOK",
    PLAN: "PLAN",
  };
  return synonyms[raw] ?? null;
}

// ---------------------------------------------------------------------------
// Main scorer
// ---------------------------------------------------------------------------

interface TypeScore {
  type: Exclude<DocType, "GENERIC">;
  score: number;
}

/**
 * Compute per-type confidence scores from all signal families.
 */
function scoreContent(content: string): TypeScore[] {
  const scores: Record<Exclude<DocType, "GENERIC">, number> = {
    PLAN: 0,
    REVIEW: 0,
    SPEC: 0,
    RUNBOOK: 0,
  };

  // ── 1. Heading patterns ──────────────────────────────────────────────────
  for (const [type, patterns] of Object.entries(HEADING_PATTERNS) as [Exclude<DocType, "GENERIC">, RegExp[]][]) {
    for (const re of patterns) {
      if (re.test(content)) scores[type] += HEADING_HIT_WEIGHT;
    }
  }

  // ── 2. Word frequency ────────────────────────────────────────────────────
  for (const [type, terms] of Object.entries(WORD_TERMS) as [Exclude<DocType, "GENERIC">, RegExp[]][]) {
    for (const re of terms) {
      // Reset lastIndex for global regexes before each test
      re.lastIndex = 0;
      if (re.test(content)) scores[type] += WORD_HIT_WEIGHT;
    }
  }

  // ── 3. Checklist density (strong PLAN signal; mild REVIEW signal) ─────────
  const clDensity = checklistDensity(content);
  if (clDensity > 0.15) scores.PLAN += 10;
  else if (clDensity > 0.05) scores.PLAN += 5;
  if (clDensity > 0.05) scores.REVIEW += 3;

  // ── 4. Code-block density (strong RUNBOOK / SPEC signal) ──────────────────
  const cbDensity = codeBlockDensity(content);
  if (cbDensity > 0.3) scores.RUNBOOK += 10;
  else if (cbDensity > 0.1) scores.RUNBOOK += 5;
  if (cbDensity > 0.1) scores.SPEC += 4;

  // ── 5. Numbered steps (strong RUNBOOK signal) ─────────────────────────────
  const steps = countNumberedSteps(content);
  if (steps >= 5) scores.RUNBOOK += 12;
  else if (steps >= 3) scores.RUNBOOK += 7;
  else if (steps >= 1) scores.RUNBOOK += 3;

  return (Object.entries(scores) as [Exclude<DocType, "GENERIC">, number][]).map(
    ([type, score]) => ({ type, score }),
  );
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Classify a Markdown document into a semantic {@link DocType}.
 *
 * Classification algorithm:
 *   1. If the frontmatter contains an explicit `type:` / `kind:` marker that
 *      maps to a recognised DocType, return it immediately.
 *   2. Score all four typed categories using heading patterns, word frequency,
 *      checklist density, and code-block density.
 *   3. If the highest score exceeds a minimum confidence threshold AND leads
 *      the second-best by a meaningful margin, return that type.
 *   4. Otherwise fall back to "GENERIC".
 *
 * @param content  Raw markdown string, including any YAML frontmatter.
 * @returns        High-confidence {@link DocType}.
 */
export function classify(content: string): DocType {
  if (!content || content.trim().length === 0) return "GENERIC";

  // ── Step 1: Explicit frontmatter hint ────────────────────────────────────
  const fmType = frontmatterDocType(content);
  if (fmType) return fmType;

  // ── Step 2: Score all types ───────────────────────────────────────────────
  const scores = scoreContent(content).sort((a, b) => b.score - a.score);
  const best = scores[0];
  const secondBest = scores[1];

  // ── Step 3: Confidence gate ───────────────────────────────────────────────
  // Require minimum absolute score AND meaningful lead over second place.
  const MIN_SCORE = 10;
  const MIN_LEAD = 4;

  if (best.score >= MIN_SCORE && best.score - secondBest.score >= MIN_LEAD) {
    return best.type;
  }

  // ── Step 4: Fallback ──────────────────────────────────────────────────────
  return "GENERIC";
}
