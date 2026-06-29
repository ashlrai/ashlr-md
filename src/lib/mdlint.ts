/**
 * mdlint.ts — Pluggable Markdown linter with autofix support.
 *
 * Each rule receives the full document text and returns zero or more
 * Violation objects. Every violation carries an optional `fix` function that
 * returns the corrected document string.
 *
 * Rules are designed to be pure functions (no side-effects, no async I/O)
 * so they can run synchronously on every editor keystroke.
 *
 * Integration points:
 *   - SourceEditor: shows inline squiggles via CodeMirror decorations
 *   - LintRulesPanel: settings UI to enable/disable rules per vault
 *   - settingsStore: persists enabled/disabled rule IDs
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** A single text position (0-based character offset). */
export interface LintPosition {
  /** 0-based character offset from start of document. */
  offset: number;
  /** 1-based line number. */
  line: number;
  /** 0-based column on that line. */
  col: number;
}

/** A range within the document. */
export interface LintRange {
  from: LintPosition;
  to: LintPosition;
}

/** Severity level for a violation. */
export type LintSeverity = "error" | "warning" | "info";

/** A single rule violation. */
export interface LintViolation {
  /** Rule that produced this violation. */
  ruleId: string;
  /** Human-readable message. */
  message: string;
  severity: LintSeverity;
  /** Location of the problematic text. null means document-level. */
  range: LintRange | null;
  /**
   * Returns the corrected document text, or null if not fixable.
   * Receives the CURRENT document text so multiple fixes compose correctly.
   */
  fix: ((doc: string) => string) | null;
}

/** Context available to every rule during a lint run. */
export interface LintContext {
  /** Full document text. */
  doc: string;
  /** Lines split from doc (without trailing \n). */
  lines: string[];
  /**
   * Wikilink targets present in the vault.
   * When undefined the "wikilink targets exist" rule is skipped.
   */
  knownTargets?: Set<string>;
}

/** A lint rule definition. */
export interface LintRule {
  id: string;
  /** Short label shown in the settings panel. */
  label: string;
  /** Longer explanation shown as a tooltip. */
  description: string;
  severity: LintSeverity;
  /** Runs synchronously; returns all violations in one pass. */
  check(ctx: LintContext): LintViolation[];
}

/** Per-vault rule configuration stored in settingsStore. */
export interface LintRuleConfig {
  /** Rule IDs explicitly disabled by the user. All others are enabled. */
  disabledRules: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a LintPosition from a character offset and the split lines array. */
export function positionFromOffset(offset: number, lines: string[]): LintPosition {
  let remaining = offset;
  for (let i = 0; i < lines.length; i++) {
    // +1 accounts for the \n that was stripped by split
    const lineLen = lines[i].length + 1;
    if (remaining < lineLen) {
      return { offset, line: i + 1, col: remaining };
    }
    remaining -= lineLen;
  }
  // Clamp to end of document
  const lastLine = lines.length - 1;
  return { offset, line: lastLine + 1, col: lines[lastLine]?.length ?? 0 };
}

/** Build a simple range that spans [from, to) in the document. */
function range(doc: string, from: number, to: number): LintRange {
  const lines = doc.split("\n");
  return {
    from: positionFromOffset(from, lines),
    to: positionFromOffset(to, lines),
  };
}

// ── Built-in Rules ────────────────────────────────────────────────────────────

/**
 * RULE: frontmatter-required
 * The document must begin with a YAML frontmatter block (--- ... ---).
 */
export const ruleFrontmatterRequired: LintRule = {
  id: "frontmatter-required",
  label: "Frontmatter required",
  description: "Every document should have a YAML frontmatter block (--- ... ---) at the top.",
  severity: "warning",
  check({ doc }): LintViolation[] {
    const FM_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
    if (FM_RE.test(doc)) return [];
    return [
      {
        ruleId: "frontmatter-required",
        message: "Document is missing a frontmatter block.",
        severity: "warning",
        range: null,
        fix: (d) => `---\ntitle: \ntags: []\n---\n\n${d}`,
      },
    ];
  },
};

/**
 * RULE: max-heading-depth
 * Headings deeper than level 3 (####) are discouraged.
 */
export const ruleMaxHeadingDepth: LintRule = {
  id: "max-heading-depth",
  label: "Max heading depth = 3",
  description: "Headings deeper than H3 (####) reduce scannability.",
  severity: "warning",
  check({ doc, lines }): LintViolation[] {
    const violations: LintViolation[] = [];
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^(#{4,})\s/);
      if (m) {
        const depth = m[1].length;
        const from = offset;
        const to = offset + m[1].length;
        violations.push({
          ruleId: "max-heading-depth",
          message: `Heading depth ${depth} exceeds maximum of 3.`,
          severity: "warning",
          range: range(doc, from, to),
          fix: (d) => {
            // Replace the first occurrence of this exact heading line
            return d.replace(
              new RegExp(`^${m[1]}(\\s)`, "m"),
              `###$1`,
            );
          },
        });
      }
      offset += line.length + 1; // +1 for the \n
    }
    return violations;
  },
};

/**
 * RULE: no-bare-urls
 * Bare URLs (not wrapped in <> or []()) are flagged.
 * Autofix wraps them in Markdown link syntax.
 *
 * A "bare URL" is a URL that is:
 *   - not inside a markdown link: [text](url)
 *   - not inside an angle-bracket autolink: <url>
 *   - not inside a code span or fenced block
 */
export const ruleNoBareUrls: LintRule = {
  id: "no-bare-urls",
  label: "No bare URLs",
  description: "URLs should be wrapped in Markdown link syntax [text](url) or <url>.",
  severity: "warning",
  check({ doc }): LintViolation[] {
    const violations: LintViolation[] = [];

    // Strip code fences so we don't flag URLs inside code blocks
    const stripped = stripCodeBlocks(doc);

    // Match bare URLs: starts with http:// or https://, not preceded by ( or <
    // and not followed by ) (which would mean it's already in a link)
    const URL_RE = /(?<![(<\[])(https?:\/\/[^\s<>)"'\]]+)/g;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(stripped)) !== null) {
      const url = m[1];
      const from = m.index;
      const to = from + url.length;
      violations.push({
        ruleId: "no-bare-urls",
        message: `Bare URL: ${url.length > 60 ? url.slice(0, 57) + "…" : url}`,
        severity: "warning",
        range: range(doc, from, to),
        fix: (d) => {
          // Replace this specific occurrence by offset
          return d.slice(0, from) + `[${url}](${url})` + d.slice(to);
        },
      });
    }
    return violations;
  },
};

/**
 * RULE: wikilink-targets-exist
 * All [[wikilink]] targets must be present in the vault's known file set.
 * Skipped when knownTargets is undefined (vault not indexed).
 */
export const ruleWikilinkTargetsExist: LintRule = {
  id: "wikilink-targets-exist",
  label: "Wikilink targets exist",
  description: "All [[wikilinks]] must resolve to a file in the vault.",
  severity: "error",
  check({ doc, knownTargets }): LintViolation[] {
    if (!knownTargets) return []; // vault not indexed — skip
    const violations: LintViolation[] = [];
    const WIKI_RE = /\[\[([^\]|#\n]+?)(?:[|#][^\]]*?)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = WIKI_RE.exec(doc)) !== null) {
      const target = m[1].trim();
      if (!knownTargets.has(target) && !knownTargets.has(`${target}.md`)) {
        const from = m.index;
        const to = from + m[0].length;
        violations.push({
          ruleId: "wikilink-targets-exist",
          message: `Wikilink target not found: "${target}"`,
          severity: "error",
          range: range(doc, from, to),
          fix: null, // can't auto-create the missing file
        });
      }
    }
    return violations;
  },
};

/**
 * RULE: no-empty-headings
 * Headings must have non-whitespace content after the # markers.
 */
export const ruleNoEmptyHeadings: LintRule = {
  id: "no-empty-headings",
  label: "No empty headings",
  description: "Headings must have text content.",
  severity: "error",
  check({ doc, lines }): LintViolation[] {
    const violations: LintViolation[] = [];
    let offset = 0;
    for (const line of lines) {
      const m = line.match(/^(#{1,6})\s*$/);
      if (m) {
        violations.push({
          ruleId: "no-empty-headings",
          message: "Empty heading.",
          severity: "error",
          range: range(doc, offset, offset + line.length),
          fix: null,
        });
      }
      offset += line.length + 1;
    }
    return violations;
  },
};

/**
 * RULE: no-trailing-spaces
 * Lines must not end with trailing whitespace (excluding intentional BR: two spaces).
 */
export const ruleNoTrailingSpaces: LintRule = {
  id: "no-trailing-spaces",
  label: "No trailing spaces",
  description: "Lines should not end with trailing whitespace.",
  severity: "info",
  check({ doc, lines }): LintViolation[] {
    const violations: LintViolation[] = [];
    let offset = 0;
    for (const line of lines) {
      // Allow exactly two trailing spaces (Markdown hard line break).
      // Match any trailing whitespace run, then skip if it is exactly two spaces.
      const m = line.match(/ +$/);
      if (m && m[0].length !== 2) {
        const trailStart = offset + m.index!;
        const trailEnd = trailStart + m[0].length;
        // Capture offset and line by value in a const so the fix closure
        // refers to this line's position, not the mutable loop variable.
        const lineStart = offset;
        const lineEnd = offset + line.length;
        violations.push({
          ruleId: "no-trailing-spaces",
          message: "Trailing whitespace.",
          severity: "info",
          range: range(doc, trailStart, trailEnd),
          fix: (d) => {
            const cleaned = d.slice(lineStart, lineEnd).replace(/ +$/, (s) => s.length === 2 ? s : "");
            return d.slice(0, lineStart) + cleaned + d.slice(lineEnd);
          },
        });
      }
      offset += line.length + 1;
    }
    return violations;
  },
};

/**
 * RULE: single-h1
 * A document should have at most one H1 heading.
 */
export const ruleSingleH1: LintRule = {
  id: "single-h1",
  label: "Single H1 heading",
  description: "Documents should contain at most one top-level (H1) heading.",
  severity: "warning",
  check({ doc, lines }): LintViolation[] {
    const violations: LintViolation[] = [];
    const h1Offsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
      if (/^#\s/.test(line)) h1Offsets.push(offset);
      offset += line.length + 1;
    }
    if (h1Offsets.length > 1) {
      // Flag every H1 after the first
      for (let i = 1; i < h1Offsets.length; i++) {
        const off = h1Offsets[i];
        violations.push({
          ruleId: "single-h1",
          message: `Duplicate H1 heading (${h1Offsets.length} total).`,
          severity: "warning",
          range: range(doc, off, off + 2), // just the "# " prefix
          fix: null,
        });
      }
    }
    return violations;
  },
};

/**
 * RULE: no-consecutive-blank-lines
 * More than one consecutive blank line is flagged.
 */
export const ruleNoConsecutiveBlankLines: LintRule = {
  id: "no-consecutive-blank-lines",
  label: "No consecutive blank lines",
  description: "At most one blank line between sections.",
  severity: "info",
  check({ doc, lines }): LintViolation[] {
    const violations: LintViolation[] = [];
    let offset = 0;
    let blankRun = 0;
    let blankRunStart = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") {
        if (blankRun === 0) blankRunStart = offset;
        blankRun++;
      } else {
        if (blankRun > 1) {
          // The run covers blankRunStart .. offset-1 (the \n before current line)
          violations.push({
            ruleId: "no-consecutive-blank-lines",
            message: `${blankRun} consecutive blank lines (max 1).`,
            severity: "info",
            range: range(doc, blankRunStart, offset - 1),
            fix: (d) => {
              // Collapse any run of 2+ blank lines to a single blank line
              return d.replace(/\n{3,}/g, "\n\n");
            },
          });
        }
        blankRun = 0;
      }
      offset += line.length + 1;
    }
    return violations;
  },
};

/**
 * RULE: orphaned-heading
 * A heading that is immediately followed by another heading (with no body text
 * between them) is "orphaned" — it introduces a section but has no content.
 * Fix: no autofix (the user needs to add content or remove the heading).
 */
export const ruleOrphanedHeading: LintRule = {
  id: "orphaned-heading",
  label: "No orphaned headings",
  description: "A heading should be followed by body text before the next heading.",
  severity: "warning",
  check({ doc, lines }): LintViolation[] {
    const violations: LintViolation[] = [];
    let offset = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^#{1,6}\s/.test(line)) {
        // Look for the next non-blank line
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (j < lines.length && /^#{1,6}\s/.test(lines[j])) {
          violations.push({
            ruleId: "orphaned-heading",
            message: `Orphaned heading: "${line.replace(/^#+\s+/, "").slice(0, 40)}" has no body text before the next heading.`,
            severity: "warning",
            range: range(doc, offset, offset + line.length),
            fix: null,
          });
        }
      }
      offset += line.length + 1;
    }
    return violations;
  },
};

/**
 * RULE: invalid-link-target
 * Markdown links whose href is empty or obviously broken (just `#`, bare `?`,
 * or whitespace-only) are flagged. Autofix replaces the href with a `TODO`
 * placeholder so it is searchable.
 */
export const ruleInvalidLinkTarget: LintRule = {
  id: "invalid-link-target",
  label: "No invalid link targets",
  description: "Markdown link hrefs must not be empty or contain only whitespace/punctuation.",
  severity: "warning",
  check({ doc }): LintViolation[] {
    const violations: LintViolation[] = [];
    // Match [text](href) — capture the full match so we can compute offset
    const LINK_RE = /\[([^\]]*?)\]\(([^)]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(doc)) !== null) {
      const href = m[2];
      // Consider invalid: empty, whitespace-only, lone "#", lone "?"
      if (/^\s*$/.test(href) || href === "#" || href === "?") {
        const from = m.index;
        const to = from + m[0].length;
        const text = m[1] || "link";
        violations.push({
          ruleId: "invalid-link-target",
          message: `Invalid link target: [${text.slice(0, 30)}](${href || "empty"})`,
          severity: "warning",
          range: range(doc, from, to),
          fix: (d) => {
            // Replace this specific occurrence by offset
            const placeholder = `[${text}](TODO)`;
            return d.slice(0, from) + placeholder + d.slice(to);
          },
        });
      }
    }
    return violations;
  },
};

/**
 * RULE: missing-alt-text
 * Markdown images without alt text (![](url) or ![ ](url)) are flagged.
 * Autofix inserts a `TODO: describe image` placeholder.
 */
export const ruleMissingAltText: LintRule = {
  id: "missing-alt-text",
  label: "Images must have alt text",
  description: "Every image must have descriptive alt text for accessibility.",
  severity: "warning",
  check({ doc }): LintViolation[] {
    const violations: LintViolation[] = [];
    // Match ![alt](src) — alt may be empty
    const IMG_RE = /!\[([^\]]*?)\]\([^)]+\)/g;
    let m: RegExpExecArray | null;
    while ((m = IMG_RE.exec(doc)) !== null) {
      const alt = m[1];
      if (/^\s*$/.test(alt)) {
        const from = m.index;
        const to = from + m[0].length;
        // Extract the src to reconstruct the fixed image tag
        const srcMatch = m[0].match(/\]\(([^)]+)\)/);
        const src = srcMatch ? srcMatch[1] : "";
        violations.push({
          ruleId: "missing-alt-text",
          message: `Image is missing alt text: ${src.length > 40 ? src.slice(0, 37) + "…" : src}`,
          severity: "warning",
          range: range(doc, from, to),
          fix: (d) => {
            const fixed = `![TODO: describe image](${src})`;
            return d.slice(0, from) + fixed + d.slice(to);
          },
        });
      }
    }
    return violations;
  },
};

// ── Built-in rule registry ────────────────────────────────────────────────────

export const BUILTIN_RULES: LintRule[] = [
  ruleFrontmatterRequired,
  ruleMaxHeadingDepth,
  ruleNoBareUrls,
  ruleWikilinkTargetsExist,
  ruleNoEmptyHeadings,
  ruleNoTrailingSpaces,
  ruleSingleH1,
  ruleNoConsecutiveBlankLines,
  ruleOrphanedHeading,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
];

/**
 * The subset of rules that are enabled by default in the Linter Toast UI.
 * These are the four rules highlighted in the Settings → Linter rules panel.
 */
export const LINTER_DEFAULT_ENABLED_RULES: readonly string[] = [
  "no-trailing-spaces",
  "orphaned-heading",
  "invalid-link-target",
  "missing-alt-text",
];

// ── Linter engine ─────────────────────────────────────────────────────────────

export interface LintOptions {
  /** Rules to run. Defaults to BUILTIN_RULES. */
  rules?: LintRule[];
  /** Rule IDs that are disabled (from settingsStore). */
  disabledRules?: string[];
  /** Known wikilink targets in the vault. */
  knownTargets?: Set<string>;
}

/**
 * Run the linter over `doc` and return all violations, sorted by position
 * (document-level violations last).
 */
export function lintDocument(doc: string, opts: LintOptions = {}): LintViolation[] {
  const rules = opts.rules ?? BUILTIN_RULES;
  const disabled = new Set(opts.disabledRules ?? []);
  const lines = doc.split("\n");
  const ctx: LintContext = { doc, lines, knownTargets: opts.knownTargets };

  const violations: LintViolation[] = [];
  for (const rule of rules) {
    if (disabled.has(rule.id)) continue;
    violations.push(...rule.check(ctx));
  }

  // Sort: document-level (null range) last, others by offset ascending.
  violations.sort((a, b) => {
    if (!a.range && !b.range) return 0;
    if (!a.range) return 1;
    if (!b.range) return -1;
    return a.range.from.offset - b.range.from.offset;
  });

  return violations;
}

/**
 * Apply all available fixes for the given violations, in reverse offset order
 * so fixes don't invalidate each other's offsets.
 */
export function applyAllFixes(doc: string, violations: LintViolation[]): string {
  // Only violations with a fix function, sorted by descending offset
  // (document-level violations last, then highest offset first).
  const fixable = violations
    .filter((v) => v.fix !== null)
    .sort((a, b) => {
      if (!a.range && !b.range) return 0;
      if (!a.range) return 1; // doc-level fixes after positional
      if (!b.range) return -1;
      return b.range.from.offset - a.range.from.offset; // descending
    });

  let result = doc;
  for (const v of fixable) {
    result = v.fix!(result);
  }
  return result;
}

/**
 * Apply the fix for a single violation.
 */
export function applyFix(doc: string, violation: LintViolation): string {
  if (!violation.fix) return doc;
  return violation.fix(doc);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Replace fenced code blocks and inline code spans with spaces so URL/link
 * rules don't flag content inside code.  Preserves character offsets.
 */
function stripCodeBlocks(doc: string): string {
  // Replace fenced blocks (``` ... ```) with spaces
  let result = doc.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
  // Replace inline code (`...`) with spaces
  result = result.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
  return result;
}
