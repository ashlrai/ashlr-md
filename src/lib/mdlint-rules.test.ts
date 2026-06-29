/**
 * mdlint-rules.test.ts — tests for the markdownlint-parity rules added to
 * mdlint.ts (fenced-code-language / no-hard-tabs / final-newline), plus the
 * offset-drift hardening of positional fixes (`spliceIfMatch`) and the
 * descending-order `applyAllFixes` guarantee.
 */

import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  BUILTIN_RULES,
  lintDocument,
  ruleFencedCodeLanguage,
  ruleFinalNewline,
  ruleNoBareUrls,
  ruleNoHardTabs,
  spliceIfMatch,
} from "./mdlint";

// ─── fenced-code-language (MD040) ─────────────────────────────────────────────

describe("rule:fenced-code-language", () => {
  it("flags a fence with no language", () => {
    const doc = "Intro\n\n```\ncode\n```\n";
    const v = lintDocument(doc, { rules: [ruleFencedCodeLanguage] });
    expect(v).toHaveLength(1);
    expect(v[0].ruleId).toBe("fenced-code-language");
  });

  it("passes when the fence declares a language", () => {
    const doc = "```ts\nconst x = 1;\n```\n";
    expect(lintDocument(doc, { rules: [ruleFencedCodeLanguage] })).toHaveLength(0);
  });

  it("autofix annotates the opening fence with `text`", () => {
    const doc = "```\nhello\n```\n";
    const v = lintDocument(doc, { rules: [ruleFencedCodeLanguage] });
    expect(v[0].fix!(doc)).toBe("```text\nhello\n```\n");
  });

  it("does not flag the closing fence", () => {
    const doc = "```js\na\n```\n\n```py\nb\n```\n";
    expect(lintDocument(doc, { rules: [ruleFencedCodeLanguage] })).toHaveLength(0);
  });

  it("handles tilde fences and content that looks like a fence", () => {
    const doc = "~~~\nplain\n~~~\n";
    const v = lintDocument(doc, { rules: [ruleFencedCodeLanguage] });
    expect(v).toHaveLength(1);
    expect(v[0].fix!(doc)).toBe("~~~text\nplain\n~~~\n");
  });

  it("does not treat a backtick line inside a tilde fence as a new opener", () => {
    // The ``` lines are content of the ~~~ block, not fences.
    const doc = "~~~md\n```\nnested\n```\n~~~\n";
    expect(lintDocument(doc, { rules: [ruleFencedCodeLanguage] })).toHaveLength(0);
  });
});

// ─── no-hard-tabs (MD010) ─────────────────────────────────────────────────────

describe("rule:no-hard-tabs", () => {
  it("flags a hard tab in prose", () => {
    const doc = "a\tb\n";
    const v = lintDocument(doc, { rules: [ruleNoHardTabs] });
    expect(v).toHaveLength(1);
    expect(v[0].ruleId).toBe("no-hard-tabs");
  });

  it("autofix expands tabs to two spaces", () => {
    const doc = "a\tb\n";
    const v = lintDocument(doc, { rules: [ruleNoHardTabs] });
    expect(v[0].fix!(doc)).toBe("a  b\n");
  });

  it("leaves tabs inside fenced code blocks untouched", () => {
    const doc = "```go\nfunc x() {\n\treturn\n}\n```\n";
    expect(lintDocument(doc, { rules: [ruleNoHardTabs] })).toHaveLength(0);
  });

  it("flags one tab per line (first occurrence carries a whole-line fix)", () => {
    const doc = "\tone\n\ttwo\n";
    const v = lintDocument(doc, { rules: [ruleNoHardTabs] });
    expect(v).toHaveLength(2);
  });
});

// ─── final-newline (MD047) ────────────────────────────────────────────────────

describe("rule:final-newline", () => {
  it("flags a file with no trailing newline", () => {
    const v = lintDocument("hello", { rules: [ruleFinalNewline] });
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/does not end/);
    expect(v[0].fix!("hello")).toBe("hello\n");
  });

  it("flags a file ending in multiple blank lines and collapses them", () => {
    const v = lintDocument("hello\n\n\n", { rules: [ruleFinalNewline] });
    expect(v).toHaveLength(1);
    expect(v[0].fix!("hello\n\n\n")).toBe("hello\n");
  });

  it("passes a file ending with exactly one newline", () => {
    expect(lintDocument("hello\n", { rules: [ruleFinalNewline] })).toHaveLength(0);
  });

  it("ignores an empty document", () => {
    expect(lintDocument("", { rules: [ruleFinalNewline] })).toHaveLength(0);
  });
});

// ─── registry ─────────────────────────────────────────────────────────────────

describe("BUILTIN_RULES registry", () => {
  it("includes the three new rules", () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    expect(ids).toContain("fenced-code-language");
    expect(ids).toContain("no-hard-tabs");
    expect(ids).toContain("final-newline");
  });

  it("has unique rule ids", () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── spliceIfMatch — offset-drift hardening ───────────────────────────────────

describe("spliceIfMatch", () => {
  it("splices in place when the offset still matches", () => {
    expect(spliceIfMatch("abcXYZdef", 3, 6, "XYZ", "!!")).toBe("abc!!def");
  });

  it("falls back to first-occurrence when the offset has drifted", () => {
    // Offsets point past where text now lives (doc was prepended to).
    const doc = "PREFIX abcXYZdef";
    expect(spliceIfMatch(doc, 3, 6, "XYZ", "!!")).toBe("PREFIX abc!!def");
  });

  it("returns the doc unchanged when the expected text is gone", () => {
    expect(spliceIfMatch("abcdef", 0, 3, "XYZ", "!!")).toBe("abcdef");
  });
});

// ─── applyAllFixes — no offset corruption with mixed fixes ─────────────────────

describe("applyAllFixes — offset safety", () => {
  it("fixes multiple bare URLs without corrupting later offsets", () => {
    const doc = "See https://a.example and https://b.example for details.\n";
    const v = lintDocument(doc, { rules: [ruleNoBareUrls] });
    expect(v).toHaveLength(2);
    const fixed = applyAllFixes(doc, v);
    expect(fixed).toBe(
      "See [https://a.example](https://a.example) and [https://b.example](https://b.example) for details.\n",
    );
  });

  it("composes a positional fix with a document-level fix correctly", () => {
    // no-bare-urls (positional) + final-newline (doc-level). Running the
    // doc-level fix first would shift the URL offset; applyAllFixes orders
    // positional-before-document so this is stable.
    const doc = "Visit https://x.example now";
    const v = lintDocument(doc, {
      rules: [ruleNoBareUrls, ruleFinalNewline],
    });
    const fixed = applyAllFixes(doc, v);
    expect(fixed).toBe("Visit [https://x.example](https://x.example) now\n");
  });

  it("is idempotent — re-linting the fixed doc yields no fixable bare URLs", () => {
    const doc = "a https://one.example b https://two.example c";
    const fixed = applyAllFixes(doc, lintDocument(doc, { rules: [ruleNoBareUrls] }));
    expect(lintDocument(fixed, { rules: [ruleNoBareUrls] })).toHaveLength(0);
  });
});
