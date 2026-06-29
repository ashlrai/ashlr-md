/**
 * spec-renderer.ts
 *
 * Pure data-extraction helpers for "spec" documents — agent-generated
 * specifications that follow a canonical section structure.
 *
 * These are intentionally side-effect-free and React-independent so they can be
 * unit-tested without a DOM. The React components in
 * src/components/viewer/SpecRenderer.tsx consume these types and functions.
 *
 * Canonical spec sections (case-insensitive ## headings):
 *   Requirements, Design, Implementation, Architecture, API Design, Interface Spec
 *
 * Acceptance criteria are extracted from a "## Acceptance Criteria" (or
 * equivalent) section as a list of structured items with their completion state.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single acceptance-criterion item extracted from a spec document. */
export interface CriterionItem {
  /** Display text of the criterion. */
  text: string;
  /** True when the item is checked (`- [x]`). */
  done: boolean;
  /** 1-based line number in the original source for write-back. */
  line: number;
}

/**
 * A logical section of a spec document, with its heading text and the raw
 * markdown body that follows it (up to the next same-level heading).
 */
export interface SpecSection {
  /** Heading level (2 = ##, 3 = ###, etc.). */
  level: number;
  /** Heading text (without the `##` prefix). */
  title: string;
  /** Raw markdown body of the section. */
  body: string;
  /** 1-based line number of the heading. */
  line: number;
}

/** Full parsed representation of a spec document. */
export interface ParsedSpec {
  /** Top-level document title (first h1, if present). */
  title: string;
  /** Extracted logical sections (Requirements / Design / Implementation / etc.). */
  sections: SpecSection[];
  /** Acceptance criteria extracted from the criteria section(s). */
  criteria: CriterionItem[];
  /** Total criteria count. */
  criteriaTotal: number;
  /** Done criteria count. */
  criteriaDone: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Headings that represent top-level spec sections. */
const SPEC_SECTION_TITLES = new Set([
  "requirements",
  "design",
  "implementation",
  "architecture",
  "api design",
  "interface spec",
  "overview",
  "background",
  "motivation",
  "goals",
  "non-goals",
  "open questions",
]);

/** Headings that introduce acceptance criteria. */
const CRITERIA_TITLES = new Set([
  "acceptance criteria",
  "success criteria",
  "criteria",
  "done when",
  "definition of done",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.+)/;
const TASK_ITEM_RE = /^[ \t]*(?:[-*+]|\d+\.)\s+\[([ xX])\]\s+(.+)/;

function normaliseTitle(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Parse a spec document into its logical sections and acceptance criteria.
 *
 * @param content  Raw markdown string (may include frontmatter).
 * @returns A {@link ParsedSpec} — always returns a value; empty arrays when
 *          no spec structure is detected (callers should check `sections.length`).
 */
export function parseSpec(content: string): ParsedSpec {
  const lines = content.split("\n");
  const sections: SpecSection[] = [];
  const criteria: CriterionItem[] = [];
  let title = "";

  let currentSection: SpecSection | null = null;
  let inCriteriaSection = false;
  let inFrontmatter = false;
  let frontmatterClosed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip YAML frontmatter block.
    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === "---" || line.trim() === "...") {
        inFrontmatter = false;
        frontmatterClosed = true;
      }
      continue;
    }
    void frontmatterClosed; // used only to skip parsing

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      const normTitle = normaliseTitle(headingText);

      // Capture h1 as document title.
      if (level === 1 && !title) {
        title = headingText;
      }

      // Flush previous section body.
      if (currentSection !== null) {
        const flushed: SpecSection = {
          level: currentSection.level,
          title: currentSection.title,
          body: currentSection.body.trimEnd(),
          line: currentSection.line,
        };
        sections.push(flushed);
        currentSection = null;
      }

      // Determine if this is a spec section or criteria section.
      if (CRITERIA_TITLES.has(normTitle)) {
        inCriteriaSection = true;
        continue;
      }
      inCriteriaSection = false;

      if (SPEC_SECTION_TITLES.has(normTitle) && level <= 3) {
        currentSection = { level, title: headingText, body: "", line: lineNum };
        continue;
      }
      // Sub-headings inside an active section: append to body.
      if (currentSection !== null) {
        (currentSection as SpecSection).body += `${line}\n`;
      }
      continue;
    }

    // Inside a criteria section: collect task items.
    if (inCriteriaSection) {
      const taskMatch = TASK_ITEM_RE.exec(line);
      if (taskMatch) {
        criteria.push({
          text: taskMatch[2].trim(),
          done: taskMatch[1].trim().toLowerCase() === "x",
          line: lineNum,
        });
      }
      continue;
    }

    // Append line to current section body.
    if (currentSection) {
      currentSection.body += `${line}\n`;
    }
  }

  // Flush last section.
  if (currentSection !== null) {
    sections.push({
      level: currentSection.level,
      title: currentSection.title,
      body: currentSection.body.trimEnd(),
      line: currentSection.line,
    });
  }

  return {
    title,
    sections,
    criteria,
    criteriaTotal: criteria.length,
    criteriaDone: criteria.filter((c) => c.done).length,
  };
}
