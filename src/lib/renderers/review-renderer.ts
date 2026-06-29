/**
 * review-renderer.ts
 *
 * Pure data-extraction helpers for "review" documents — agent-generated code
 * reviews that follow a canonical section structure with file summaries,
 * summary text, and feedback annotations.
 *
 * This module focuses on the _structural_ review kind (detected by heading
 * pattern: ## Files Changed, ## Summary, ## Feedback) as opposed to the
 * severity-tagged findings format handled by reviewDoc.ts + ReviewSummaryCard.
 *
 * Both formats can coexist: `detectDocKind` detects structural reviews; the
 * severity-badge path (detectReviewDoc) handles findings-style docs.
 *
 * Canonical review sections:
 *   Files Changed, Summary, Feedback, Comments, Review Notes, Findings
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single file summary entry from the "## Files Changed" section. */
export interface FileSummary {
  /** File path as written in the document (e.g. `src/lib/foo.ts`). */
  path: string;
  /** Short description/summary for the file change (may be empty). */
  description: string;
  /** 1-based line number of the file reference. */
  line: number;
}

/** A single feedback annotation (a comment, suggestion, or note). */
export interface FeedbackAnnotation {
  /** The heading or bold-lead text that introduced this annotation. */
  label: string;
  /** Full body text of the annotation. */
  body: string;
  /**
   * Optional file path reference if the annotation targets a specific file
   * (e.g. found as the first `path:line` reference in the body).
   */
  fileRef?: string;
  /** 1-based line number where the annotation starts. */
  line: number;
}

/** Full parsed representation of a structural review document. */
export interface ParsedReview {
  /** Top-level document title (first h1, if present). */
  title: string;
  /** Summary text from the ## Summary section (raw markdown). */
  summary: string;
  /** File summaries extracted from ## Files Changed. */
  files: FileSummary[];
  /** Threaded feedback annotations from ## Feedback / ## Comments sections. */
  feedback: FeedbackAnnotation[];
  /** Total annotation count. */
  feedbackTotal: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILES_SECTION_TITLES = new Set([
  "files changed",
  "files reviewed",
  "changed files",
]);

const SUMMARY_SECTION_TITLES = new Set([
  "summary",
  "overview",
  "review summary",
]);

const FEEDBACK_SECTION_TITLES = new Set([
  "feedback",
  "comments",
  "review notes",
  "findings",
  "suggestions",
  "notes",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.+)/;

/** `path/to/file.ext:123` or just `path/to/file.ext` (no line number). */
const FILE_PATH_RE = /(?:^|\s)([\w./\\-]+\.[A-Za-z][\w]{0,9})(?::\d+)?/;

/** A list item (bullet or ordered). */
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+\.)\s+(.+)/;

function normaliseTitle(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Parse a structural review document into its file summaries, summary text,
 * and feedback annotations.
 *
 * @param content  Raw markdown string (may include frontmatter).
 * @returns A {@link ParsedReview} — always returns a value; check
 *          `files.length + feedback.length` to determine if parsing found
 *          any structure.
 */
export function parseReview(content: string): ParsedReview {
  const lines = content.split("\n");

  let title = "";
  let summary = "";
  const files: FileSummary[] = [];
  const feedback: FeedbackAnnotation[] = [];

  type Section = "files" | "summary" | "feedback" | null;
  let currentSection: Section = null;
  let sectionBuffer: string[] = [];
  let sectionStartLine = 0;

  let inFrontmatter = false;

  function flushSection() {
    if (currentSection === "summary") {
      summary = sectionBuffer.join("\n").trim();
    } else if (currentSection === "files") {
      for (let idx = 0; idx < sectionBuffer.length; idx++) {
        const bufLine = sectionBuffer[idx];
        const itemMatch = LIST_ITEM_RE.exec(bufLine);
        if (itemMatch) {
          const text = itemMatch[1].trim();
          const pathMatch = FILE_PATH_RE.exec(text);
          const path = pathMatch ? pathMatch[1] : text;
          const description = pathMatch ? text.slice(pathMatch.index + pathMatch[0].length).trim() : "";
          files.push({
            path,
            description: description.replace(/^[-–—:]\s*/, ""),
            line: sectionStartLine + idx,
          });
        }
      }
    } else if (currentSection === "feedback") {
      // Each sub-heading (###) or bold lead is a feedback annotation.
      let annotLabel = "";
      let annotStart = sectionStartLine;
      let annotLines: string[] = [];

      const commitAnnot = () => {
        const body = annotLines.join("\n").trim();
        // Only commit when there is a non-empty label or non-empty body.
        if (!annotLabel && !body) return;
        const fileRefMatch = FILE_PATH_RE.exec(body);
        feedback.push({
          label: annotLabel,
          body,
          fileRef: fileRefMatch ? fileRefMatch[1] : undefined,
          line: annotStart,
        });
      };

      for (let idx = 0; idx < sectionBuffer.length; idx++) {
        const bufLine = sectionBuffer[idx];
        const subHeading = /^(#{3,6})\s+(.+)/.exec(bufLine);
        const boldLead = /^\*\*([^*]+)\*\*:?\s*(.*)/.exec(bufLine);

        if (subHeading) {
          commitAnnot();
          annotLabel = subHeading[2].trim();
          annotStart = sectionStartLine + idx;
          annotLines = [];
        } else if (boldLead && !annotLabel) {
          commitAnnot();
          annotLabel = boldLead[1].trim();
          annotStart = sectionStartLine + idx;
          annotLines = boldLead[2] ? [boldLead[2]] : [];
        } else {
          annotLines.push(bufLine);
        }
      }
      commitAnnot();
    }

    sectionBuffer = [];
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

      // Level-2 headings define major sections.
      if (level === 2) {
        flushSection();
        if (FILES_SECTION_TITLES.has(normTitle)) {
          currentSection = "files";
          sectionStartLine = i + 2; // body starts after this heading
        } else if (SUMMARY_SECTION_TITLES.has(normTitle)) {
          currentSection = "summary";
          sectionStartLine = i + 2;
        } else if (FEEDBACK_SECTION_TITLES.has(normTitle)) {
          currentSection = "feedback";
          sectionStartLine = i + 2;
        } else {
          currentSection = null;
        }
        continue;
      }
    }

    if (currentSection) {
      sectionBuffer.push(line);
    }
  }

  flushSection();

  return {
    title,
    summary,
    files,
    feedback,
    feedbackTotal: feedback.length,
  };
}
