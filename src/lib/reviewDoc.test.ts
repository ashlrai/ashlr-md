import { describe, expect, it } from "vitest";
import { detectReviewDoc } from "./reviewDoc";

describe("detectReviewDoc — positive cases", () => {
  it("detects a heading-style review with severities + confidence + file refs", () => {
    const doc = [
      "# Code Review: auth module",
      "",
      "## [Critical] SQL injection in login query",
      "`src/auth/login.ts:42` builds SQL by string concatenation.",
      "Confidence: 95",
      "",
      "## [High] Missing rate limit on token endpoint",
      "See `src/auth/token.ts:88`.",
      "Confidence: 80",
      "",
      "## [Low] Inconsistent error message casing",
      "Minor wording issue in `src/auth/errors.ts:12`.",
    ].join("\n");
    const r = detectReviewDoc(doc);
    expect(r).not.toBeNull();
    expect(r?.total).toBe(3);
    expect(r?.counts).toEqual({ critical: 1, high: 1, low: 1 });
    expect(r?.averageConfidence).toBe(88); // round((95+80)/2)
    expect(r?.fileRefs).toBeGreaterThanOrEqual(3);
    expect(r?.findings[0].severity).toBe("critical");
    expect(r?.findings[0].title).toMatch(/SQL injection/);
  });

  it("detects a bold-lead list review", () => {
    const doc = [
      "Findings:",
      "",
      "- **Blocker:** data loss on concurrent save",
      "- **Major:** unbounded memory growth in cache",
      "- **Nit:** trailing whitespace in config",
    ].join("\n");
    const r = detectReviewDoc(doc);
    expect(r).not.toBeNull();
    expect(r?.total).toBe(3);
    expect(r?.counts.blocker).toBe(1);
    expect(r?.counts.major).toBe(1);
    expect(r?.counts.nit).toBe(1);
  });

  it("reads findings after an indented `---`, which opens no front matter", () => {
    // The page shows `  ---` as a thematic break, not front matter. The
    // first line used to be trimmed, so these findings were skipped.
    const doc = [
      "  ---",
      "- **Blocker:** data loss on concurrent save",
      "- **Major:** unbounded memory growth in cache",
      "---",
    ].join("\n");
    expect(detectReviewDoc(doc)?.total).toBe(2);
    expect(detectReviewDoc(doc.trimStart())).toBeNull();
  });

  it("detects bracketed list items with em-dash titles", () => {
    const doc = [
      "* [High] — race condition in scheduler",
      "* [Medium] — missing null check",
    ].join("\n");
    const r = detectReviewDoc(doc);
    expect(r).not.toBeNull();
    expect(r?.total).toBe(2);
    expect(r?.findings[0].title).toMatch(/race condition/);
  });

  it("normalises synonyms (moderate→medium, nitpick→nit, informational→info)", () => {
    const doc = [
      "- **Moderate:** thing one",
      "- **Nitpick:** thing two",
      "- **Informational:** thing three",
    ].join("\n");
    const r = detectReviewDoc(doc);
    expect(r?.counts).toEqual({ medium: 1, nit: 1, info: 1 });
  });

  it("parses 0–1 confidence fractions as percentages", () => {
    const doc = [
      "## [High] one",
      "Confidence: 0.9",
      "## [High] two",
      "Confidence: 0.7",
    ].join("\n");
    const r = detectReviewDoc(doc);
    expect(r?.averageConfidence).toBe(80); // round((90+70)/2)
  });

  it("ignores severity words inside fenced code blocks", () => {
    const doc = [
      "## [Critical] real finding",
      "## [High] another real finding",
      "",
      "```md",
      "## [Critical] this is example output, not a finding",
      "- **High:** also not counted",
      "```",
    ].join("\n");
    const r = detectReviewDoc(doc);
    expect(r?.total).toBe(2);
  });

  it("counts a table-style severity column", () => {
    const doc = [
      "| Severity | Issue |",
      "| --- | --- |",
      "| Critical | broken auth |",
      "| Low | typo |",
    ].join("\n");
    // The header/separator rows don't lead with a severity word; the two data
    // rows do.
    const r = detectReviewDoc(doc);
    expect(r).not.toBeNull();
    expect(r?.counts.critical).toBe(1);
    expect(r?.counts.low).toBe(1);
  });
});

describe("detectReviewDoc — negative cases (must return null)", () => {
  it("returns null for empty / whitespace input", () => {
    expect(detectReviewDoc("")).toBeNull();
    expect(detectReviewDoc("   \n  \n")).toBeNull();
  });

  it("returns null for ordinary prose that uses 'critical' once", () => {
    const doc = [
      "# Project Update",
      "",
      "This release is critical for our Q3 goals. The team has made high",
      "quality progress and we expect a low number of regressions.",
      "It is important to ship on time.",
    ].join("\n");
    expect(detectReviewDoc(doc)).toBeNull();
  });

  it("returns null for a single severity-tagged finding (below threshold)", () => {
    const doc = [
      "# Note",
      "",
      "- **Critical:** the one and only flagged thing",
      "- A normal bullet with no severity",
      "- Another normal bullet",
    ].join("\n");
    expect(detectReviewDoc(doc)).toBeNull();
  });

  it("returns null for a normal GFM task list", () => {
    const doc = [
      "# Plan",
      "",
      "- [ ] set up the project",
      "- [x] write the parser",
      "- [ ] add tests",
    ].join("\n");
    expect(detectReviewDoc(doc)).toBeNull();
  });

  it("does not match words that merely START with a severity word", () => {
    const doc = [
      "- Highlight the main entry point",
      "- Lowercase all the headers",
      "- Information architecture review",
      "- Minority report reference",
    ].join("\n");
    expect(detectReviewDoc(doc)).toBeNull();
  });

  it("returns null for prose paragraphs mentioning severities mid-sentence", () => {
    const doc = [
      "The bug is high severity and the fix is low effort.",
      "We consider this a critical milestone with major implications.",
      "A minor detail: the info banner needs tweaking.",
    ].join("\n");
    // Severity words appear, but never as a structural lead token.
    expect(detectReviewDoc(doc)).toBeNull();
  });

  it("returns null for a changelog-style doc", () => {
    const doc = [
      "## [1.2.0] — 2026-01-01",
      "",
      "### Added",
      "- New export format",
      "- Faster startup",
      "",
      "### Fixed",
      "- A crash on launch",
    ].join("\n");
    expect(detectReviewDoc(doc)).toBeNull();
  });

  it("ignores http:// URLs as file references and stays null without findings", () => {
    const doc = [
      "Visit http://example.com:8080 for details.",
      "Also https://api.test.io:443/path here.",
    ].join("\n");
    expect(detectReviewDoc(doc)).toBeNull();
  });

  it("returns null for hyphenated compounds (High-level / Low-level / Medium-sized)", () => {
    // The classic false positive: a severity word joined into a compound by a
    // hyphen must NOT read as a tagged finding.
    const doc = [
      "# Architecture",
      "",
      "## High-level overview",
      "The system has three layers.",
      "",
      "## Low-level details",
      "Internals live here.",
      "",
      "## Medium-sized modules",
      "Some notes about Low-hanging fruit and High-priority work.",
    ].join("\n");
    expect(detectReviewDoc(doc)).toBeNull();
  });
});

describe("detectReviewDoc — file reference parsing", () => {
  it("counts path:line refs but not bare URLs", () => {
    const doc = [
      "## [High] one — `src/a/b.ts:10`",
      "## [Low] two — `lib/c.js:200:5` and see http://x.com:80",
    ].join("\n");
    const r = detectReviewDoc(doc);
    expect(r).not.toBeNull();
    expect(r?.fileRefs).toBe(2);
  });
});
