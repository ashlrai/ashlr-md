/**
 * runbook-renderer.ts
 *
 * Pure data-extraction helpers for "runbook" documents — agent-generated
 * operational runbooks with prerequisites, numbered steps, and rollback
 * procedures.
 *
 * These helpers are side-effect-free and React-independent. The React
 * components in src/components/viewer/RunbookRenderer.tsx consume these
 * types and the step-status state persisted to the Zustand store.
 *
 * Canonical runbook sections:
 *   Prerequisites, Steps, Rollback, Procedure, Troubleshooting, Verification
 *
 * Step detection recognises:
 *   - Ordered list items under a Steps/Procedure heading
 *   - `### Step N: ...` sub-headings
 *   - `**Step N:**` bold leads
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of a single runbook step, persisted to the store. */
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** A single executable step in a runbook. */
export interface RunbookStep {
  /** Unique step identifier within the document (1-based index). */
  id: number;
  /** Short label / title of the step. */
  title: string;
  /** Full body markdown for the step (commands, notes, etc.). */
  body: string;
  /**
   * Code commands extracted from fenced code blocks within the step body.
   * Each element is the raw content of one code block.
   */
  commands: string[];
  /** 1-based line number where the step heading or list item starts. */
  line: number;
}

/** A prerequisite item (from ## Prerequisites). */
export interface Prerequisite {
  /** Display text. */
  text: string;
  /** Whether it is a checked task item. */
  done: boolean;
  /** 1-based source line. */
  line: number;
}

/** Full parsed representation of a runbook document. */
export interface ParsedRunbook {
  /** Top-level document title (first h1, if present). */
  title: string;
  /** Prerequisites extracted from ## Prerequisites. */
  prerequisites: Prerequisite[];
  /** Numbered steps extracted from the Steps/Procedure section. */
  steps: RunbookStep[];
  /** Raw markdown of the rollback section (if present). */
  rollback: string;
  /** Raw markdown of the troubleshooting section (if present). */
  troubleshooting: string;
  /** Raw markdown of the verification section (if present). */
  verification: string;
  /** Total step count. */
  stepCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREREQ_TITLES = new Set(["prerequisites", "prerequisite", "requirements", "before you begin"]);
const STEPS_TITLES = new Set(["steps", "step", "procedure", "instructions", "how to"]);
const ROLLBACK_TITLES = new Set(["rollback", "undo", "revert", "recovery"]);
const TROUBLESHOOTING_TITLES = new Set(["troubleshooting", "debugging", "known issues", "faq"]);
const VERIFICATION_TITLES = new Set(["verification", "verify", "testing", "validation", "smoke test"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.+)/;
const TASK_ITEM_RE = /^[ \t]*(?:[-*+])\s+\[([ xX])\]\s+(.+)/;
const ORDERED_ITEM_RE = /^[ \t]*(\d+)[.)]\s+(.+)/;
const BOLD_STEP_RE = /^\*\*[Ss]tep\s+(\d+)[:.]\*\*\s*(.*)/;
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})(\w*)/;

function normaliseTitle(text: string): string {
  return text.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Extract all fenced code block contents from a markdown body string.
 */
function extractCommands(body: string): string[] {
  const commands: string[] = [];
  const bodyLines = body.split("\n");
  let fenceMarker: string | null = null;
  let buffer: string[] = [];

  for (const bl of bodyLines) {
    const fenceMatch = FENCE_OPEN_RE.exec(bl);
    if (fenceMarker) {
      // Check for closing fence.
      if (bl.trim().startsWith(fenceMarker[0]) && bl.trim().length >= fenceMarker.length) {
        const code = buffer.join("\n").trim();
        if (code) commands.push(code);
        buffer = [];
        fenceMarker = null;
      } else {
        buffer.push(bl);
      }
    } else if (fenceMatch) {
      fenceMarker = fenceMatch[1];
      buffer = [];
    }
  }
  // Unclosed fence: include what we have.
  if (buffer.length > 0) {
    const code = buffer.join("\n").trim();
    if (code) commands.push(code);
  }

  return commands;
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Parse a runbook document into its prerequisites, steps, and auxiliary
 * sections.
 *
 * @param content  Raw markdown string (may include frontmatter).
 * @returns A {@link ParsedRunbook} — always returns a value; check
 *          `steps.length` to determine if any structure was found.
 */
export function parseRunbook(content: string): ParsedRunbook {
  const lines = content.split("\n");

  let title = "";
  const prerequisites: Prerequisite[] = [];
  const steps: RunbookStep[] = [];
  let rollback = "";
  let troubleshooting = "";
  let verification = "";

  type SectionKind = "prereq" | "steps" | "rollback" | "troubleshooting" | "verification" | null;
  let currentSection: SectionKind = null;
  let sectionLines: string[] = [];
  let sectionStartLine = 0;

  let inFrontmatter = false;
  let stepCounter = 0;

  function flushSection() {
    const body = sectionLines.join("\n");

    if (currentSection === "prereq") {
      for (let idx = 0; idx < sectionLines.length; idx++) {
        const sl = sectionLines[idx];
        // Checked/unchecked task items: `- [x] text` / `- [ ] text`
        const taskMatch = TASK_ITEM_RE.exec(sl);
        if (taskMatch) {
          prerequisites.push({
            text: taskMatch[2].trim(),
            done: taskMatch[1].trim().toLowerCase() === "x",
            line: sectionStartLine + idx,
          });
          continue;
        }
        // Ordered list items: `1. text`
        const orderedMatch = ORDERED_ITEM_RE.exec(sl);
        if (orderedMatch) {
          prerequisites.push({
            text: orderedMatch[2].trim(),
            done: false,
            line: sectionStartLine + idx,
          });
          continue;
        }
        // Plain bullet list items: `- text` / `* text` / `+ text`
        const bulletMatch = /^[ \t]*[-*+]\s+(.+)/.exec(sl);
        if (bulletMatch) {
          prerequisites.push({
            text: bulletMatch[1].trim(),
            done: false,
            line: sectionStartLine + idx,
          });
        }
      }
    } else if (currentSection === "steps") {
      // Parse steps from ordered list items or sub-headings.
      let stepTitle = "";
      let stepStart = sectionStartLine;
      let stepLines: string[] = [];

      const commitStep = () => {
        if (stepTitle || stepLines.some((l) => l.trim())) {
          stepCounter++;
          const stepBody = stepLines.join("\n").trim();
          steps.push({
            id: stepCounter,
            title: stepTitle || `Step ${stepCounter}`,
            body: stepBody,
            commands: extractCommands(stepBody),
            line: stepStart,
          });
        }
      };

      for (let idx = 0; idx < sectionLines.length; idx++) {
        const sl = sectionLines[idx];
        const orderedMatch = ORDERED_ITEM_RE.exec(sl);
        const subHeading = /^(#{3,6})\s+(.+)/.exec(sl);
        const boldStep = BOLD_STEP_RE.exec(sl);

        if (orderedMatch) {
          commitStep();
          stepTitle = orderedMatch[2].trim();
          stepStart = sectionStartLine + idx;
          stepLines = [];
        } else if (subHeading) {
          commitStep();
          stepTitle = subHeading[2].trim();
          stepStart = sectionStartLine + idx;
          stepLines = [];
        } else if (boldStep) {
          commitStep();
          stepTitle = boldStep[2].trim();
          stepStart = sectionStartLine + idx;
          stepLines = [];
        } else {
          stepLines.push(sl);
        }
      }
      commitStep();
    } else if (currentSection === "rollback") {
      rollback = body.trim();
    } else if (currentSection === "troubleshooting") {
      troubleshooting = body.trim();
    } else if (currentSection === "verification") {
      verification = body.trim();
    }

    sectionLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip YAML frontmatter block.
    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === "---" || line.trim() === "...") inFrontmatter = false;
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      const normTitle = normaliseTitle(headingText);

      if (level === 1 && !title) {
        title = headingText;
        continue;
      }

      if (level === 2) {
        flushSection();
        if (PREREQ_TITLES.has(normTitle)) {
          currentSection = "prereq";
          sectionStartLine = i + 2;
        } else if (STEPS_TITLES.has(normTitle)) {
          currentSection = "steps";
          sectionStartLine = i + 2;
        } else if (ROLLBACK_TITLES.has(normTitle)) {
          currentSection = "rollback";
          sectionStartLine = i + 2;
        } else if (TROUBLESHOOTING_TITLES.has(normTitle)) {
          currentSection = "troubleshooting";
          sectionStartLine = i + 2;
        } else if (VERIFICATION_TITLES.has(normTitle)) {
          currentSection = "verification";
          sectionStartLine = i + 2;
        } else {
          currentSection = null;
        }
        continue;
      }
    }

    if (currentSection) {
      sectionLines.push(line);
    }
  }

  flushSection();

  return {
    title,
    prerequisites,
    steps,
    rollback,
    troubleshooting,
    verification,
    stepCount: steps.length,
  };
}
