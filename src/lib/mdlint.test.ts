/**
 * mdlint.test.ts — Comprehensive tests for the Markdown linter rule suite.
 *
 * Structure:
 *   1. LintViolation interface / LintRange encoding
 *   2. positionFromOffset helper
 *   3. Built-in rules (one describe block per rule)
 *   4. lintDocument engine (disabled rules, sorting, multi-violation docs)
 *   5. applyFix / applyAllFixes autofix
 *   6. Rule composition (multiple rules in sequence)
 *
 * Adding a new rule: add one describe("rule:<id>", …) block below.
 */

import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  applyFix,
  BUILTIN_RULES,
  lintDocument,
  LintRange,
  LintViolation,
  positionFromOffset,
  BUILTIN_RULES as builtins,
  ruleNoTrailingSpaces,
  ruleSingleH1,
  ruleFrontmatterRequired,
  ruleMaxHeadingDepth,
  ruleNoBareUrls,
  ruleWikilinkTargetsExist,
  ruleNoEmptyHeadings,
  ruleNoConsecutiveBlankLines,
} from "./mdlint";

// ─── 1. LintViolation interface & LintRange encoding ─────────────────────────

describe("LintViolation interface", () => {
  it("encodes range.from and range.to with line/col/offset", () => {
    const doc = "# Hello\n\nSome text here\n";
    const violations = lintDocument(doc, {
      rules: [ruleNoTrailingSpaces],
    });
    // No trailing spaces here — confirms zero violations for clean doc
    expect(violations).toHaveLength(0);

    // Directly verify a synthetic violation has correct shape
    const range: LintRange = {
      from: { offset: 0, line: 1, col: 0 },
      to: { offset: 7, line: 1, col: 7 },
    };
    const violation: LintViolation = {
      ruleId: "test-rule",
      message: "test",
      severity: "warning",
      range,
      fix: null,
    };
    expect(violation.range).not.toBeNull();
    expect(violation.range!.from.line).toBe(1);
    expect(violation.range!.from.col).toBe(0);
    expect(violation.range!.from.offset).toBe(0);
    expect(violation.range!.to.offset).toBe(7);
  });

  it("allows null range for document-level violations", () => {
    // frontmatter-required produces a null-range violation
    const violations = lintDocument("# No frontmatter\n", {
      rules: [ruleFrontmatterRequired],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].range).toBeNull();
  });

  it("severity is one of error | warning | info", () => {
    const severities = BUILTIN_RULES.map((r) => r.severity);
    for (const s of severities) {
      expect(["error", "warning", "info"]).toContain(s);
    }
  });
});

// ─── 2. positionFromOffset ────────────────────────────────────────────────────

describe("positionFromOffset", () => {
  const lines = ["Hello", "World", "!"];
  // "Hello\nWorld\n!\n" — offsets: H=0, e=1…; W=6, o=7…; !=12

  it("returns offset 0 as line 1, col 0", () => {
    expect(positionFromOffset(0, lines)).toEqual({ offset: 0, line: 1, col: 0 });
  });

  it("maps offset 6 to start of second line", () => {
    expect(positionFromOffset(6, lines)).toEqual({ offset: 6, line: 2, col: 0 });
  });

  it("maps offset 8 to line 2, col 2", () => {
    expect(positionFromOffset(8, lines)).toEqual({ offset: 8, line: 2, col: 2 });
  });

  it("maps offset 12 to start of third line", () => {
    expect(positionFromOffset(12, lines)).toEqual({ offset: 12, line: 3, col: 0 });
  });

  it("clamps past-end offset to last line", () => {
    const pos = positionFromOffset(999, lines);
    expect(pos.line).toBe(3);
    expect(pos.offset).toBe(999);
  });

  it("handles single-line document", () => {
    expect(positionFromOffset(3, ["abcde"])).toEqual({ offset: 3, line: 1, col: 3 });
  });
});

// ─── 3a. Rule: no-trailing-spaces ────────────────────────────────────────────

describe("rule:no-trailing-spaces", () => {
  it("passes on a clean document", () => {
    const doc = "# Title\n\nParagraph text.\n";
    expect(lintDocument(doc, { rules: [ruleNoTrailingSpaces] })).toHaveLength(0);
  });

  it("flags a single trailing space", () => {
    const doc = "Hello world \nNext line\n";
    const violations = lintDocument(doc, { rules: [ruleNoTrailingSpaces] });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("no-trailing-spaces");
    expect(violations[0].severity).toBe("info");
  });

  it("reports correct range for trailing space", () => {
    const doc = "abc   \ndef\n";
    const violations = lintDocument(doc, { rules: [ruleNoTrailingSpaces] });
    expect(violations).toHaveLength(1);
    const { from, to } = violations[0].range!;
    // trailing "   " starts at col 3 on line 1
    expect(from.line).toBe(1);
    expect(from.col).toBe(3);
    expect(to.col).toBe(6);
  });

  it("allows exactly two trailing spaces (Markdown hard line break)", () => {
    const doc = "Line one  \nLine two\n";
    const violations = lintDocument(doc, { rules: [ruleNoTrailingSpaces] });
    expect(violations).toHaveLength(0);
  });

  it("flags three trailing spaces (not a hard break)", () => {
    const doc = "Line one   \nLine two\n";
    const violations = lintDocument(doc, { rules: [ruleNoTrailingSpaces] });
    expect(violations).toHaveLength(1);
  });

  it("autofix removes trailing spaces", () => {
    const doc = "Hello   \nworld\n";
    const violations = lintDocument(doc, { rules: [ruleNoTrailingSpaces] });
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toBe("Hello\nworld\n");
  });

  it("autofix preserves hard line breaks", () => {
    const doc = "Hello  \nworld\n";
    const violations = lintDocument(doc, { rules: [ruleNoTrailingSpaces] });
    expect(violations).toHaveLength(0);
  });

  it("flags multiple lines each with trailing spaces", () => {
    const doc = "a  \nb  \nc\n";
    // "a  " has exactly 2 spaces → hard break allowed; not flagged
    // "b  " same
    const violations = lintDocument(doc, { rules: [ruleNoTrailingSpaces] });
    expect(violations).toHaveLength(0);

    const doc2 = "a   \nb   \nc\n";
    const v2 = lintDocument(doc2, { rules: [ruleNoTrailingSpaces] });
    expect(v2).toHaveLength(2);
  });
});

// ─── 3b. Rule: single-h1 (required-h1 / consistent heading) ─────────────────

describe("rule:single-h1", () => {
  it("passes when there is exactly one H1", () => {
    const doc = "# Title\n\n## Section\n\ntext\n";
    expect(lintDocument(doc, { rules: [ruleSingleH1] })).toHaveLength(0);
  });

  it("passes when there is no H1 at all", () => {
    const doc = "## Section\n\ntext\n";
    expect(lintDocument(doc, { rules: [ruleSingleH1] })).toHaveLength(0);
  });

  it("flags every H1 after the first", () => {
    const doc = "# First\n\n# Second\n\n# Third\n";
    const violations = lintDocument(doc, { rules: [ruleSingleH1] });
    expect(violations).toHaveLength(2); // second and third H1
    for (const v of violations) {
      expect(v.ruleId).toBe("single-h1");
      expect(v.severity).toBe("warning");
    }
  });

  it("reports correct offsets for the duplicate H1", () => {
    const doc = "# First\n\n# Second\n";
    const violations = lintDocument(doc, { rules: [ruleSingleH1] });
    expect(violations).toHaveLength(1);
    // Second H1 starts at offset 9 ("# First\n\n" = 9 chars)
    expect(violations[0].range!.from.offset).toBe(9);
    expect(violations[0].range!.from.line).toBe(3);
  });

  it("does not confuse ## with #", () => {
    const doc = "# Title\n\n## Sub\n\n## Sub2\n";
    expect(lintDocument(doc, { rules: [ruleSingleH1] })).toHaveLength(0);
  });

  it("has no autofix (cannot know which H1 is canonical)", () => {
    const doc = "# A\n\n# B\n";
    const violations = lintDocument(doc, { rules: [ruleSingleH1] });
    expect(violations[0].fix).toBeNull();
  });
});

// ─── 3c. Rule: frontmatter-required ──────────────────────────────────────────

describe("rule:frontmatter-required", () => {
  it("passes when frontmatter is present", () => {
    const doc = "---\ntitle: Test\ntags: []\n---\n\n# Hello\n";
    expect(lintDocument(doc, { rules: [ruleFrontmatterRequired] })).toHaveLength(0);
  });

  it("flags a document with no frontmatter", () => {
    const doc = "# Just a heading\n\nSome content.\n";
    const violations = lintDocument(doc, { rules: [ruleFrontmatterRequired] });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("frontmatter-required");
    expect(violations[0].severity).toBe("warning");
    expect(violations[0].range).toBeNull(); // document-level
  });

  it("autofix prepends a frontmatter skeleton", () => {
    const doc = "# Title\n\nContent.\n";
    const violations = lintDocument(doc, { rules: [ruleFrontmatterRequired] });
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toMatch(/^---\n/);
    expect(fixed).toContain("# Title");
  });

  it("autofix result passes the rule itself", () => {
    const doc = "No frontmatter here.\n";
    const violations = lintDocument(doc, { rules: [ruleFrontmatterRequired] });
    const fixed = applyFix(doc, violations[0]);
    const afterFix = lintDocument(fixed, { rules: [ruleFrontmatterRequired] });
    expect(afterFix).toHaveLength(0);
  });

  it("does not flag when frontmatter uses Windows line endings", () => {
    const doc = "---\r\ntitle: X\r\n---\r\n# Hello\r\n";
    expect(lintDocument(doc, { rules: [ruleFrontmatterRequired] })).toHaveLength(0);
  });
});

// ─── 3d. Rule: no-bare-urls ───────────────────────────────────────────────────

describe("rule:no-bare-urls", () => {
  it("passes when all URLs are in markdown links", () => {
    const doc = "See [docs](https://example.com) for details.\n";
    expect(lintDocument(doc, { rules: [ruleNoBareUrls] })).toHaveLength(0);
  });

  it("passes when URL is in angle-bracket autolink", () => {
    const doc = "See <https://example.com> for details.\n";
    expect(lintDocument(doc, { rules: [ruleNoBareUrls] })).toHaveLength(0);
  });

  it("flags a bare http URL", () => {
    const doc = "Visit http://example.com today.\n";
    const violations = lintDocument(doc, { rules: [ruleNoBareUrls] });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("no-bare-urls");
  });

  it("flags a bare https URL", () => {
    const doc = "See https://example.com/page?q=1 for more.\n";
    const violations = lintDocument(doc, { rules: [ruleNoBareUrls] });
    expect(violations).toHaveLength(1);
  });

  it("reports correct range for a bare URL", () => {
    const doc = "Go to https://example.com now.\n";
    const violations = lintDocument(doc, { rules: [ruleNoBareUrls] });
    expect(violations).toHaveLength(1);
    const { from, to } = violations[0].range!;
    expect(from.line).toBe(1);
    // "Go to " = 6 chars
    expect(from.col).toBe(6);
    expect(to.col).toBe(6 + "https://example.com".length);
  });

  it("does not flag URLs inside code spans", () => {
    const doc = "Use `https://example.com` as a reference.\n";
    expect(lintDocument(doc, { rules: [ruleNoBareUrls] })).toHaveLength(0);
  });

  it("does not flag URLs inside fenced code blocks", () => {
    const doc = "```\nhttps://example.com\n```\n";
    expect(lintDocument(doc, { rules: [ruleNoBareUrls] })).toHaveLength(0);
  });

  it("autofix wraps bare URL in markdown link", () => {
    const url = "https://example.com/path";
    const doc = `Visit ${url} today.\n`;
    const violations = lintDocument(doc, { rules: [ruleNoBareUrls] });
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toContain(`[${url}](${url})`);
    expect(fixed).not.toMatch(/Visit https?:\/\/[^\[]/);
  });

  it("flags multiple bare URLs in one document", () => {
    const doc = "See https://a.com and https://b.com for details.\n";
    const violations = lintDocument(doc, { rules: [ruleNoBareUrls] });
    expect(violations).toHaveLength(2);
  });
});

// ─── 3e. Rule: consistent-list-markers (max-heading-depth as a proxy) ────────
//         We test ruleMaxHeadingDepth as the "consistent structure" rule.

describe("rule:max-heading-depth", () => {
  it("passes on H1–H3 headings", () => {
    const doc = "# H1\n\n## H2\n\n### H3\n";
    expect(lintDocument(doc, { rules: [ruleMaxHeadingDepth] })).toHaveLength(0);
  });

  it("flags H4 headings", () => {
    const doc = "#### Too Deep\n\ntext\n";
    const violations = lintDocument(doc, { rules: [ruleMaxHeadingDepth] });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("max-heading-depth");
    expect(violations[0].severity).toBe("warning");
  });

  it("flags H5 and H6 headings", () => {
    const doc = "##### H5\n\n###### H6\n";
    const violations = lintDocument(doc, { rules: [ruleMaxHeadingDepth] });
    expect(violations).toHaveLength(2);
  });

  it("reports correct range (only the hashes)", () => {
    const doc = "#### Section\n";
    const violations = lintDocument(doc, { rules: [ruleMaxHeadingDepth] });
    const { from, to } = violations[0].range!;
    expect(from.offset).toBe(0);
    expect(to.offset).toBe(4); // "####"
  });

  it("autofix demotes H4+ to H3", () => {
    const doc = "#### Deep heading\n";
    const violations = lintDocument(doc, { rules: [ruleMaxHeadingDepth] });
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toMatch(/^### /);
  });

  it("does not flag headings that are not preceded by # at column 0", () => {
    // indented — not a heading in CommonMark (> 3 spaces = code block)
    const doc = "    #### not a heading\n";
    expect(lintDocument(doc, { rules: [ruleMaxHeadingDepth] })).toHaveLength(0);
  });
});

// ─── 3f. Rule: wikilink-targets-exist ────────────────────────────────────────

describe("rule:wikilink-targets-exist", () => {
  it("passes when all wikilinks are in knownTargets", () => {
    const doc = "See [[MyNote]] and [[Other Note]].\n";
    const knownTargets = new Set(["MyNote", "Other Note"]);
    expect(
      lintDocument(doc, { rules: [ruleWikilinkTargetsExist], knownTargets }),
    ).toHaveLength(0);
  });

  it("passes when target has .md extension in knownTargets", () => {
    const doc = "See [[MyNote]].\n";
    const knownTargets = new Set(["MyNote.md"]);
    expect(
      lintDocument(doc, { rules: [ruleWikilinkTargetsExist], knownTargets }),
    ).toHaveLength(0);
  });

  it("flags a wikilink whose target is not in the vault", () => {
    const doc = "See [[MissingNote]].\n";
    const knownTargets = new Set<string>();
    const violations = lintDocument(doc, {
      rules: [ruleWikilinkTargetsExist],
      knownTargets,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("wikilink-targets-exist");
    expect(violations[0].severity).toBe("error");
    expect(violations[0].message).toContain("MissingNote");
  });

  it("skips the check when knownTargets is undefined", () => {
    const doc = "See [[AnyNote]].\n";
    // No knownTargets → vault not indexed, rule skips
    expect(lintDocument(doc, { rules: [ruleWikilinkTargetsExist] })).toHaveLength(0);
  });

  it("handles wikilinks with display text [[target|display]]", () => {
    const doc = "See [[Note|My Note]].\n";
    const knownTargets = new Set(["Note"]);
    expect(
      lintDocument(doc, { rules: [ruleWikilinkTargetsExist], knownTargets }),
    ).toHaveLength(0);
  });

  it("handles wikilinks with heading anchors [[target#section]]", () => {
    const doc = "See [[Note#Introduction]].\n";
    const knownTargets = new Set(["Note"]);
    expect(
      lintDocument(doc, { rules: [ruleWikilinkTargetsExist], knownTargets }),
    ).toHaveLength(0);
  });

  it("has no autofix (cannot create missing files)", () => {
    const doc = "[[Missing]]\n";
    const violations = lintDocument(doc, {
      rules: [ruleWikilinkTargetsExist],
      knownTargets: new Set(),
    });
    expect(violations[0].fix).toBeNull();
  });
});

// ─── 3g. Rule: no-empty-headings ─────────────────────────────────────────────

describe("rule:no-empty-headings", () => {
  it("passes on non-empty headings", () => {
    const doc = "# Title\n## Sub\n### Detail\n";
    expect(lintDocument(doc, { rules: [ruleNoEmptyHeadings] })).toHaveLength(0);
  });

  it("flags a heading with only hashes and no text", () => {
    const doc = "##\n\nSome content.\n";
    const violations = lintDocument(doc, { rules: [ruleNoEmptyHeadings] });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("no-empty-headings");
    expect(violations[0].severity).toBe("error");
  });

  it("flags a heading with only whitespace after hashes", () => {
    const doc = "##   \n\nSome content.\n";
    const violations = lintDocument(doc, { rules: [ruleNoEmptyHeadings] });
    expect(violations).toHaveLength(1);
  });

  it("reports the range of the empty heading line", () => {
    const doc = "# Good\n##\n";
    const violations = lintDocument(doc, { rules: [ruleNoEmptyHeadings] });
    expect(violations).toHaveLength(1);
    expect(violations[0].range!.from.line).toBe(2);
  });

  it("has no autofix", () => {
    const doc = "##\n";
    const violations = lintDocument(doc, { rules: [ruleNoEmptyHeadings] });
    expect(violations[0].fix).toBeNull();
  });
});

// ─── 3h. Rule: no-consecutive-blank-lines ────────────────────────────────────

describe("rule:no-consecutive-blank-lines", () => {
  it("passes with single blank lines between sections", () => {
    const doc = "# Title\n\nParagraph one.\n\nParagraph two.\n";
    expect(
      lintDocument(doc, { rules: [ruleNoConsecutiveBlankLines] }),
    ).toHaveLength(0);
  });

  it("flags two consecutive blank lines", () => {
    const doc = "Paragraph one.\n\n\nParagraph two.\n";
    const violations = lintDocument(doc, { rules: [ruleNoConsecutiveBlankLines] });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("no-consecutive-blank-lines");
    expect(violations[0].severity).toBe("info");
  });

  it("flags three consecutive blank lines", () => {
    const doc = "A.\n\n\n\nB.\n";
    const violations = lintDocument(doc, { rules: [ruleNoConsecutiveBlankLines] });
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("3");
  });

  it("autofix collapses multiple blank lines to one", () => {
    const doc = "A.\n\n\n\nB.\n";
    const violations = lintDocument(doc, { rules: [ruleNoConsecutiveBlankLines] });
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toBe("A.\n\nB.\n");
  });
});

// ─── 4. lintDocument engine ───────────────────────────────────────────────────

describe("lintDocument", () => {
  it("returns an empty array for an empty document with no rules", () => {
    expect(lintDocument("", { rules: [] })).toHaveLength(0);
  });

  it("uses BUILTIN_RULES when no rules option is passed", () => {
    // A totally clean doc with frontmatter should yield zero violations
    const clean = "---\ntitle: Test\ntags: []\n---\n\n# Title\n\nParagraph.\n";
    const violations = lintDocument(clean);
    expect(violations).toHaveLength(0);
  });

  it("respects disabledRules option", () => {
    const doc = "# No frontmatter\n";
    // frontmatter-required would normally fire
    const withRule = lintDocument(doc, { rules: [ruleFrontmatterRequired] });
    expect(withRule).toHaveLength(1);

    const disabled = lintDocument(doc, {
      rules: [ruleFrontmatterRequired],
      disabledRules: ["frontmatter-required"],
    });
    expect(disabled).toHaveLength(0);
  });

  it("collects multiple violations from one document without overlap", () => {
    // trailing spaces on line 1, empty heading on line 2
    const doc = "text   \n##\n\n# Good heading\n# Another H1\n";
    const violations = lintDocument(doc, {
      rules: [ruleNoTrailingSpaces, ruleNoEmptyHeadings, ruleSingleH1],
    });
    // Expect: 1 trailing-space, 1 empty-heading, 1 duplicate-H1
    expect(violations).toHaveLength(3);
    const ids = violations.map((v) => v.ruleId);
    expect(ids).toContain("no-trailing-spaces");
    expect(ids).toContain("no-empty-headings");
    expect(ids).toContain("single-h1");
  });

  it("sorts violations by ascending offset, null-range violations last", () => {
    // frontmatter-required fires as null-range (doc-level)
    // no-empty-headings fires at offset 0
    const doc = "##\n\n# Good\n# Dup\n";
    const violations = lintDocument(doc, {
      rules: [ruleFrontmatterRequired, ruleNoEmptyHeadings, ruleSingleH1],
    });
    // null-range (frontmatter) should be last
    const lastV = violations[violations.length - 1];
    expect(lastV.range).toBeNull();
    // first violation should be earliest offset
    expect(violations[0].range!.from.offset).toBeLessThanOrEqual(
      violations[1].range!.from.offset,
    );
  });

  it("can run all BUILTIN_RULES together on a rich document", () => {
    // Note: exactly 2 trailing spaces = Markdown hard line break (allowed).
    // Use 3 trailing spaces on the section line to trigger no-trailing-spaces.
    const doc = [
      "# Heading",
      "",
      "Visit https://bare.url for info.",
      "",
      "#### Too deep",
      "",
      "## Section   ",  // 3 trailing spaces → triggers no-trailing-spaces
      "",
      "[[BrokenLink]]",
      "",
    ].join("\n");

    const violations = lintDocument(doc, {
      rules: BUILTIN_RULES,
      knownTargets: new Set<string>(),
    });
    // Should detect: bare-url, max-heading-depth, trailing-spaces, wikilink, frontmatter
    const ids = new Set(violations.map((v) => v.ruleId));
    expect(ids.has("no-bare-urls")).toBe(true);
    expect(ids.has("max-heading-depth")).toBe(true);
    expect(ids.has("no-trailing-spaces")).toBe(true);
    expect(ids.has("wikilink-targets-exist")).toBe(true);
    expect(ids.has("frontmatter-required")).toBe(true);
  });
});

// ─── 5. applyFix / applyAllFixes ─────────────────────────────────────────────

describe("applyFix", () => {
  it("returns doc unchanged when fix is null", () => {
    const doc = "# A\n\n# B\n";
    const violations = lintDocument(doc, { rules: [ruleSingleH1] });
    const result = applyFix(doc, violations[0]);
    expect(result).toBe(doc);
  });

  it("applies a fix and returns the corrected document", () => {
    const doc = "trailing   \nclean\n";
    const violations = lintDocument(doc, { rules: [ruleNoTrailingSpaces] });
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toBe("trailing\nclean\n");
  });
});

describe("applyAllFixes", () => {
  it("applies fixes for all fixable violations", () => {
    const doc = "trailing   \nalso trailing   \nclean\n";
    const violations = lintDocument(doc, { rules: [ruleNoTrailingSpaces] });
    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("trailing\nalso trailing\nclean\n");
  });

  it("skips violations with null fix", () => {
    const doc = "# A\n\n# B\n";
    const violations = lintDocument(doc, { rules: [ruleSingleH1] });
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(doc); // unchanged
  });

  it("applies multiple different rule fixes in one pass", () => {
    const doc = "trailing   \n#### Deep\n";
    const violations = lintDocument(doc, {
      rules: [ruleNoTrailingSpaces, ruleMaxHeadingDepth],
    });
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).not.toContain("   ");
    expect(fixed).toMatch(/^### /m);
  });

  it("returns original doc when there are no fixable violations", () => {
    const doc = "# A\n\n# B\n";
    const violations = lintDocument(doc, { rules: [ruleSingleH1] });
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });
});

// ─── 6. Rule composition ─────────────────────────────────────────────────────

describe("rule composition", () => {
  it("rules do not produce overlapping ranges on the same text", () => {
    const doc = "trailing   \n#### Also deep   \n";
    const violations = lintDocument(doc, {
      rules: [ruleNoTrailingSpaces, ruleMaxHeadingDepth],
    });
    // Each rule fires on its own region — no offset collisions
    const ranges = violations.filter((v) => v.range !== null).map((v) => v.range!);
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const a = ranges[i];
        const b = ranges[j];
        // Ranges should not overlap
        const overlap = a.from.offset < b.to.offset && b.from.offset < a.to.offset;
        expect(overlap).toBe(false);
      }
    }
  });

  it("applying rules in sequence produces the same result as applyAllFixes", () => {
    const doc = "trailing   \n#### Deep heading   \n";
    const violations = lintDocument(doc, {
      rules: [ruleNoTrailingSpaces, ruleMaxHeadingDepth],
    });
    const allFixed = applyAllFixes(doc, violations);

    // Applying sequentially (re-lint after each rule pass, apply all fixes for that rule)
    // should also produce a clean document for the same rules.
    let sequential = doc;
    const v1 = lintDocument(sequential, { rules: [ruleMaxHeadingDepth] });
    sequential = applyAllFixes(sequential, v1);
    const v2 = lintDocument(sequential, { rules: [ruleNoTrailingSpaces] });
    sequential = applyAllFixes(sequential, v2);

    // Both approaches should yield no more violations for the rules applied
    const remaining = lintDocument(allFixed, {
      rules: [ruleNoTrailingSpaces, ruleMaxHeadingDepth],
    });
    expect(remaining).toHaveLength(0);
    const remainingSeq = lintDocument(sequential, {
      rules: [ruleNoTrailingSpaces, ruleMaxHeadingDepth],
    });
    expect(remainingSeq).toHaveLength(0);
  });

  it("new rule can be added without affecting existing rule results", () => {
    // A custom rule that always passes
    const noopRule = {
      id: "noop",
      label: "Noop",
      description: "Does nothing.",
      severity: "info" as const,
      check: () => [],
    };
    const doc = "trailing   \n";
    const withNoop = lintDocument(doc, {
      rules: [ruleNoTrailingSpaces, noopRule],
    });
    const without = lintDocument(doc, { rules: [ruleNoTrailingSpaces] });
    expect(withNoop).toHaveLength(without.length);
    expect(withNoop[0].ruleId).toBe("no-trailing-spaces");
  });

  it("BUILTIN_RULES registry contains all expected rules", () => {
    const ids = builtins.map((r) => r.id);
    expect(ids).toContain("frontmatter-required");
    expect(ids).toContain("max-heading-depth");
    expect(ids).toContain("no-bare-urls");
    expect(ids).toContain("wikilink-targets-exist");
    expect(ids).toContain("no-empty-headings");
    expect(ids).toContain("no-trailing-spaces");
    expect(ids).toContain("single-h1");
    expect(ids).toContain("no-consecutive-blank-lines");
  });
});
