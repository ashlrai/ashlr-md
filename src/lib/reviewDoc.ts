/**
 * reviewDoc.ts
 *
 * Pure, side-effect-free detection for agent "review" / findings documents —
 * the kind an AI coding agent writes when it reports a code review: a list of
 * findings each tagged with a severity (Critical / High / … / Nit / Info),
 * often with a `Confidence: <n>` line and `path/to/file.ext:123` references.
 *
 * The Renderer uses {@link detectReviewDoc} to decide whether to show a
 * structured summary card above the normal Markdown body. Detection is
 * deliberately CONSERVATIVE: ordinary prose that merely says "this is critical"
 * once must NOT qualify. We only count a severity word when it appears in a
 * *structural* position — at the start of a heading, a list item, or a bold
 * lead-in ("**High:** …") — and require at least {@link MIN_FINDINGS} such
 * findings before classifying the document as a review.
 *
 * No AST traversal: line-oriented regex heuristics are fast and sufficient, and
 * mirror the approach in agent-detect.ts.
 */

import { stripFrontmatter } from "./frontmatter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Canonical severities, ordered most → least severe. */
export type Severity =
  | "blocker"
  | "critical"
  | "high"
  | "major"
  | "medium"
  | "low"
  | "minor"
  | "nit"
  | "info";

/** Display order + labels for the summary card. */
export const SEVERITY_ORDER: Severity[] = [
  "blocker",
  "critical",
  "high",
  "major",
  "medium",
  "low",
  "minor",
  "nit",
  "info",
];

export const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: "Blocker",
  critical: "Critical",
  high: "High",
  major: "Major",
  medium: "Medium",
  low: "Low",
  minor: "Minor",
  nit: "Nit",
  info: "Info",
};

/** A single parsed finding. */
export interface Finding {
  /** Canonical severity of the finding. */
  severity: Severity;
  /** Short title / lead text following the severity marker (may be empty). */
  title: string;
  /** 1-based source line where the finding starts. */
  line: number;
  /** Confidence percentage (0–100) if a `Confidence: <n>` line was attached. */
  confidence?: number;
}

/** Result of analysing a document, or null when it is not a review. */
export interface ReviewSummary {
  /** Parsed findings, in document order. */
  findings: Finding[];
  /** Count of findings per severity (only severities present are keys). */
  counts: Partial<Record<Severity, number>>;
  /** Total number of findings. */
  total: number;
  /** Average of all confidence values found, rounded; undefined if none. */
  averageConfidence?: number;
  /** Number of `path:line` style file references found in the document. */
  fileRefs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum number of severity-tagged findings before a document is treated as a
 * review. Two is enough to distinguish a real findings list from prose that
 * happens to use a severity word once, while still catching short reviews.
 */
export const MIN_FINDINGS = 2;

/** Map of recognised severity words (lower-case) → canonical severity. */
const SEVERITY_WORDS: Record<string, Severity> = {
  blocker: "blocker",
  critical: "critical",
  high: "high",
  major: "major",
  medium: "medium",
  moderate: "medium",
  low: "low",
  minor: "minor",
  nit: "nit",
  nitpick: "nit",
  info: "info",
  informational: "info",
};

const SEVERITY_ALT = Object.keys(SEVERITY_WORDS).join("|");

/**
 * A severity marker at the START of a structural line. We accept it when it is
 * the leading token of:
 *   - a heading:           `### [High] SQL injection`  /  `## High: …`
 *   - a list item:         `- **Critical** …`  /  `* [Medium] …`  /  `1. Low — …`
 *   - a bold lead:         `**Blocker:** …`
 *   - a table-ish leading cell: `| High | …`
 *
 * The marker may optionally be wrapped in `[...]`, `**...**`, or both, and is
 * followed by a delimiter (`:`, `-`, `—`, `–`, `|`, `)`, whitespace, or EOL) so
 * that words like "Highlight" or "Lowercase" do NOT match.
 */
// Common line lead: optional blockquote, then heading hashes / list marker /
// table pipe.
const LEAD = String.raw`^[ \t]*(?:>[ \t]*)?(?:#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+|\|[ \t]*)?`;

/**
 * A severity finding matches one of two shapes (so prose never qualifies):
 *
 *   (a) WRAPPED — the severity word is delimited by `[...]` and/or `**...**`,
 *       e.g. `## [Critical] …`, `- **High** …`, `**[Blocker]** …`. Once wrapped,
 *       any trailing title text is fine.
 *
 *   (b) BARE — the word stands alone and is immediately followed by a tag
 *       delimiter (`:`, `-`, `—`, `–`, `|`, `)`) or the end of the line,
 *       e.g. `**Medium:** …` (the bold is the wrapper) or `| Critical |`.
 *       A bare severity word followed by ordinary prose (a space + more words,
 *       no delimiter) does NOT match — that is how "high severity" in a
 *       sentence is rejected.
 */
const FINDING_RE = new RegExp(
  `${LEAD}(?:` +
    // (a) wrapped: opening [ or ** (or **[) … word … optional inner delimiter
    //     (e.g. the colon in `**High:**`) … matching close.
    String.raw`(?:\*\*\[|\[|\*\*|__)(${SEVERITY_ALT})\b[ \t]*[:\-—–)|]?[ \t]*(?:\]\*\*|\]|\*\*|__)` +
    "|" +
    // (b) bare word + required delimiter / EOL. A hyphen only counts as a tag
    //     delimiter when followed by whitespace or EOL ("High - SQLi"), NOT when
    //     it joins a compound word ("High-level", "Low-level", "Medium-sized") —
    //     otherwise ordinary architecture headings would read as findings.
    String.raw`(${SEVERITY_ALT})\b[ \t]*(?:[:)|—–]|-(?=[ \t]|$)|$)` +
    ")",
  "i",
);

/** Strip the matched severity marker from a line to leave the title text. */
const TITLE_STRIP_RE = new RegExp(
  `${LEAD}(?:\\*\\*\\[|\\[|\\*\\*|__)?(?:${SEVERITY_ALT})\\b` +
    String.raw`[ \t]*[:\-—–)|]?[ \t]*(?:\]\*\*|\]|\*\*|__)?[ \t]*[:\-—–)|]?[ \t]*`,
  "i",
);

/** `Confidence: 85` / `Confidence: 0.9` / `confidence — 70%` lines. */
const CONFIDENCE_RE = /\bconfidence\b[ \t]*[:=—–-]?[ \t]*(\d+(?:\.\d+)?)[ \t]*%?/i;

/**
 * `path/to/file.ext:123` references. Requires a path segment with a file
 * extension followed by `:` and a line number. The path may contain slashes,
 * dots, dashes, underscores. Kept conservative to avoid matching `http://x:80`
 * (those have `//` right after the scheme, which we exclude).
 */
const FILE_REF_RE =
  /(?<![\w/])(?!https?:)[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z][\w]{0,9}:\d+(?::\d+)?\b/g;

/** Lines that open/close a fenced code block (``` or ~~~). */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise a raw severity word to its canonical key. */
function canonicalSeverity(word: string): Severity {
  return SEVERITY_WORDS[word.toLowerCase()];
}

/** Parse a confidence number, normalising 0–1 floats to a 0–100 percentage. */
function parseConfidence(raw: string): number | undefined {
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) return undefined;
  // A bare 0–1 value is treated as a fraction (0.9 → 90); anything ≥1 is a %.
  const pct = n > 0 && n <= 1 ? n * 100 : n;
  if (pct < 0 || pct > 100) return undefined;
  return Math.round(pct);
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Analyse `markdown` and return a {@link ReviewSummary} when it looks like an
 * agent review/findings document, or `null` for ordinary documents.
 *
 * A document qualifies when it contains at least {@link MIN_FINDINGS}
 * severity-tagged findings in structural positions (heading / list item / bold
 * lead). `Confidence:` lines and `path:line` references are parsed and surfaced
 * but are NOT required — the severity-finding threshold is the gate.
 */
export function detectReviewDoc(markdown: string): ReviewSummary | null {
  if (!markdown || markdown.trim() === "") return null;

  const { lines, offset } = stripFrontmatter(markdown);
  const findings: Finding[] = [];
  let fence: string | null = null;
  let fileRefs = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track fenced code blocks so we never parse findings/refs inside them.
    const fenceMatch = FENCE_RE.exec(line);
    if (fence) {
      if (fenceMatch) {
        const marker = fenceMatch[1];
        const rest = line.slice(line.indexOf(marker) + marker.length).trim();
        if (marker[0] === fence[0] && marker.length >= fence.length && rest === "") {
          fence = null;
        }
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }

    // Count file refs on this (non-code) line.
    FILE_REF_RE.lastIndex = 0;
    const refMatches = line.match(FILE_REF_RE);
    if (refMatches) fileRefs += refMatches.length;

    // Severity finding?
    const m = FINDING_RE.exec(line);
    if (m) {
      // m[1] = wrapped form, m[2] = bare form (only one is set).
      const severity = canonicalSeverity(m[1] ?? m[2]);
      const title = line.replace(TITLE_STRIP_RE, "").trim();
      const finding: Finding = { severity, title, line: offset + i + 1 };

      // Attach an inline confidence if present on the same line.
      const inlineConf = CONFIDENCE_RE.exec(line);
      if (inlineConf) {
        const c = parseConfidence(inlineConf[1]);
        if (c !== undefined) finding.confidence = c;
      }
      findings.push(finding);
    } else {
      // Confidence lines often trail the finding on the next non-empty lines —
      // attach to the most recent finding that has none yet.
      const conf = CONFIDENCE_RE.exec(line);
      if (conf && findings.length > 0) {
        const last = findings[findings.length - 1];
        if (last.confidence === undefined) {
          const c = parseConfidence(conf[1]);
          if (c !== undefined) last.confidence = c;
        }
      }
    }
  }

  if (findings.length < MIN_FINDINGS) return null;

  // Build counts.
  const counts: Partial<Record<Severity, number>> = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }

  // Average confidence over findings that carry one.
  const confs = findings
    .map((f) => f.confidence)
    .filter((c): c is number => c !== undefined);
  const averageConfidence =
    confs.length > 0
      ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length)
      : undefined;

  return {
    findings,
    counts,
    total: findings.length,
    averageConfidence,
    fileRefs,
  };
}
