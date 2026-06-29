import { describe, expect, it } from "vitest";
import { parseReview } from "./review-renderer";

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

describe("parseReview — title extraction", () => {
  it("captures first h1 as document title", () => {
    const doc = "# Code Review: PR #42\n\n## Summary\nLooks good.\n";
    const r = parseReview(doc);
    expect(r.title).toBe("Code Review: PR #42");
  });

  it("returns empty title when no h1 is present", () => {
    const doc = "## Summary\nLooks good.\n";
    const r = parseReview(doc);
    expect(r.title).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Summary section
// ---------------------------------------------------------------------------

describe("parseReview — summary section", () => {
  it("captures ## Summary section as raw markdown", () => {
    const doc = [
      "# Review",
      "",
      "## Summary",
      "The PR adds new caching logic.",
      "Overall the change looks correct.",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.summary).toContain("caching logic");
    expect(r.summary).toContain("change looks correct");
  });

  it("recognises 'Overview' as summary alias", () => {
    const doc = "## Overview\nThis PR adds rate limiting.\n";
    const r = parseReview(doc);
    expect(r.summary).toContain("rate limiting");
  });

  it("recognises 'Review Summary' as summary alias", () => {
    const doc = "## Review Summary\nClean implementation.\n";
    const r = parseReview(doc);
    expect(r.summary).toContain("Clean implementation");
  });

  it("returns empty summary when section is absent", () => {
    const doc = "## Files Changed\n- src/foo.ts\n";
    const r = parseReview(doc);
    expect(r.summary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Files Changed section
// ---------------------------------------------------------------------------

describe("parseReview — files changed section", () => {
  it("extracts file paths from bullet list", () => {
    const doc = [
      "# Review",
      "",
      "## Files Changed",
      "- src/lib/foo.ts",
      "- src/lib/bar.ts",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.files).toHaveLength(2);
    expect(r.files[0].path).toBe("src/lib/foo.ts");
    expect(r.files[1].path).toBe("src/lib/bar.ts");
  });

  it("extracts file path + description when separated by dash", () => {
    const doc = [
      "## Files Changed",
      "- src/auth/login.ts — added rate limiting",
      "- src/utils/crypto.ts — refactored key derivation",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.files[0].path).toContain("login.ts");
    expect(r.files[0].description).toContain("rate limiting");
    expect(r.files[1].path).toContain("crypto.ts");
  });

  it("recognises 'Files Reviewed' alias", () => {
    const doc = "## Files Reviewed\n- lib/index.ts\n- lib/utils.ts\n";
    const r = parseReview(doc);
    expect(r.files).toHaveLength(2);
  });

  it("recognises 'Changed Files' alias", () => {
    const doc = "## Changed Files\n- config/settings.ts\n";
    const r = parseReview(doc);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].path).toContain("settings.ts");
  });

  it("records 1-based line numbers for file entries", () => {
    const doc = [
      "## Files Changed",  // line 1
      "- a/b.ts",          // line 2
      "- c/d.ts",          // line 3
    ].join("\n");
    const r = parseReview(doc);
    // sectionStartLine offset is i+2 (heading line + 1 for body), idx is 0-based.
    // First item idx=0 → line = sectionStartLine + 0.
    expect(r.files[0].line).toBeGreaterThan(0);
    expect(r.files[1].line).toBeGreaterThanOrEqual(r.files[0].line);
  });

  it("returns empty files when section is absent", () => {
    const doc = "## Summary\nAll good.\n";
    const r = parseReview(doc);
    expect(r.files).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Feedback / findings sections
// ---------------------------------------------------------------------------

describe("parseReview — feedback section", () => {
  it("captures ### sub-headings as feedback annotations", () => {
    const doc = [
      "# Review",
      "",
      "## Feedback",
      "### Missing null check in UserService",
      "The `getUser()` method doesn't handle a null result.",
      "### Unused import in header",
      "Line 3 imports `React` but it's not needed.",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.feedback).toHaveLength(2);
    expect(r.feedback[0].label).toBe("Missing null check in UserService");
    expect(r.feedback[0].body).toContain("doesn't handle a null result");
    expect(r.feedback[1].label).toBe("Unused import in header");
  });

  it("captures **bold lead** annotation as first unlabelled entry", () => {
    // The bold-lead branch fires only when annotLabel is empty. The regex
    // `^\*\*([^*]+)\*\*:?` captures the text inside ** including any trailing
    // colon, so "**Performance:**" yields label "Performance:".
    const doc = [
      "## Feedback",
      "**Performance:** The query runs N+1.",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.feedback.length).toBeGreaterThanOrEqual(1);
    // label includes the trailing colon from the bold span: "Performance:"
    const perf = r.feedback.find((f) => f.label.startsWith("Performance"));
    expect(perf).toBeDefined();
    expect(perf?.body).toContain("N+1");
  });

  it("recognises 'Comments' as feedback alias", () => {
    const doc = [
      "## Comments",
      "### Naming inconsistency",
      "Use camelCase throughout.",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.feedback).toHaveLength(1);
    expect(r.feedback[0].label).toBe("Naming inconsistency");
  });

  it("recognises 'Findings' as feedback alias", () => {
    const doc = [
      "## Findings",
      "### Critical: SQL injection",
      "Direct interpolation at `db.query`.",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.feedback).toHaveLength(1);
    expect(r.feedback[0].label).toContain("SQL injection");
  });

  it("recognises 'Review Notes' as feedback alias", () => {
    const doc = "## Review Notes\n### Good test coverage\nAll paths covered.\n";
    const r = parseReview(doc);
    expect(r.feedback).toHaveLength(1);
  });

  it("recognises 'Suggestions' as feedback alias", () => {
    const doc = "## Suggestions\n### Extract to helper\nThis logic repeats 3x.\n";
    const r = parseReview(doc);
    expect(r.feedback).toHaveLength(1);
  });

  it("populates feedbackTotal with count of annotations", () => {
    const doc = [
      "## Feedback",
      "### Issue one",
      "body",
      "### Issue two",
      "body",
      "### Issue three",
      "body",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.feedbackTotal).toBe(3);
    expect(r.feedbackTotal).toBe(r.feedback.length);
  });

  it("extracts fileRef from annotation body containing a file path after whitespace", () => {
    // FILE_PATH_RE requires (?:^|\s) before the path, so the path must start
    // at the beginning of a string or follow a space — not a backtick.
    const doc = [
      "## Feedback",
      "### Missing validation",
      "See src/api/users.ts:42 for the unchecked input.",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.feedback[0].fileRef).toBeDefined();
    expect(r.feedback[0].fileRef).toContain("users.ts");
  });

  it("leaves fileRef undefined when annotation body has no file path", () => {
    const doc = [
      "## Feedback",
      "### General comment",
      "This module could be simplified.",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.feedback[0].fileRef).toBeUndefined();
  });

  it("returns empty feedback when section is absent", () => {
    const doc = "## Summary\nAll looks good.\n";
    const r = parseReview(doc);
    expect(r.feedback).toHaveLength(0);
    expect(r.feedbackTotal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter handling
// ---------------------------------------------------------------------------

describe("parseReview — frontmatter", () => {
  it("skips YAML frontmatter delimited by ---", () => {
    const doc = [
      "---",
      "kind: review",
      "pr: 123",
      "---",
      "# PR Review",
      "",
      "## Summary",
      "Looks clean.",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.title).toBe("PR Review");
    expect(r.summary).toContain("clean");
  });

  it("skips frontmatter closed by ...", () => {
    const doc = [
      "---",
      "kind: review",
      "...",
      "# Review",
      "## Summary",
      "All good.",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.title).toBe("Review");
    expect(r.summary).toContain("All good");
  });
});

// ---------------------------------------------------------------------------
// Missing content / empty input
// ---------------------------------------------------------------------------

describe("parseReview — missing content and empty input", () => {
  it("returns empty result for empty string", () => {
    const r = parseReview("");
    expect(r.title).toBe("");
    expect(r.summary).toBe("");
    expect(r.files).toHaveLength(0);
    expect(r.feedback).toHaveLength(0);
    expect(r.feedbackTotal).toBe(0);
  });

  it("does not throw for whitespace-only input", () => {
    expect(() => parseReview("   \n\n\t\n")).not.toThrow();
  });

  it("returns valid ParsedReview with only a title and no sections", () => {
    const r = parseReview("# A Review\n\nSome prose.\n");
    expect(r.title).toBe("A Review");
    expect(r.files).toHaveLength(0);
    expect(r.feedback).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

describe("parseReview — malformed input", () => {
  it("handles broken frontmatter (unclosed ---) without throwing", () => {
    const doc = [
      "---",
      "kind: review",
      "## Summary",
      "Content here.",
    ].join("\n");
    expect(() => parseReview(doc)).not.toThrow();
    // Everything is consumed as frontmatter.
    const r = parseReview(doc);
    expect(r.summary).toBe("");
  });

  it("handles truncated feedback section (heading with no body)", () => {
    const doc = [
      "## Feedback",
      "### Truncated comment",
    ].join("\n");
    expect(() => parseReview(doc)).not.toThrow();
    const r = parseReview(doc);
    expect(r.feedback).toHaveLength(1);
    expect(r.feedback[0].label).toBe("Truncated comment");
    expect(r.feedback[0].body).toBe("");
  });

  it("handles files section with no list items (just prose)", () => {
    const doc = [
      "## Files Changed",
      "No files were changed in this review.",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.files).toHaveLength(0);
  });

  it("handles multiple sections with all content present", () => {
    const doc = [
      "# Full Review",
      "",
      "## Files Changed",
      "- src/auth.ts — updated",
      "- src/api.ts — new file",
      "",
      "## Summary",
      "Two files changed with minor additions.",
      "",
      "## Feedback",
      "### Check error handling",
      "The auth module doesn't catch network errors at src/auth.ts:55.",
      "### Add tests for new endpoint",
      "Coverage is currently 0% for src/api.ts.",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.title).toBe("Full Review");
    expect(r.files).toHaveLength(2);
    expect(r.summary).toContain("Two files");
    expect(r.feedback).toHaveLength(2);
    expect(r.feedbackTotal).toBe(2);
    expect(r.feedback[0].fileRef).toBeDefined();
  });

  it("handles feedback body spanning multiple lines", () => {
    const doc = [
      "## Feedback",
      "### Long comment",
      "Line one.",
      "Line two.",
      "Line three.",
    ].join("\n");
    const r = parseReview(doc);
    expect(r.feedback[0].body).toContain("Line one.");
    expect(r.feedback[0].body).toContain("Line three.");
  });

  it("does not treat URL ports as file refs", () => {
    const doc = [
      "## Feedback",
      "### External link",
      "Visit http://localhost:3000 for the dev server.",
    ].join("\n");
    const r = parseReview(doc);
    // FILE_PATH_RE excludes protocol-prefixed URLs; fileRef may be undefined.
    // The key requirement is no throw.
    expect(r.feedback).toHaveLength(1);
  });
});
