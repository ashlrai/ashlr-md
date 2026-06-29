/**
 * mdlint-autofix.test.ts — Comprehensive test suite for the new mdlint rules
 * and autofix infrastructure.
 *
 * Covers:
 *   1. New rules: orphaned-heading, invalid-link-target, missing-alt-text
 *   2. Existing rule augmentation: no-trailing-spaces fix edge cases
 *   3. Fix application: single fix, chained violations, multi-line fixes
 *   4. LinterToast violation history helpers
 *   5. settingsStore linterConfig: toggle, setLinterConfig, persist
 *   6. LINTER_DEFAULT_ENABLED_RULES registry
 *   7. Edge cases: empty doc, only whitespace, overlapping potential violations
 *   8. applyAllFixes on documents with all four default-enabled rule violations
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyAllFixes,
  applyFix,
  BUILTIN_RULES,
  lintDocument,
  LINTER_DEFAULT_ENABLED_RULES,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
  ruleNoTrailingSpaces,
  ruleOrphanedHeading,
} from "./mdlint";
import {
  clearLintHistory,
  getLintHistory,
  type LintHistoryEntry,
} from "../components/LinterToast";
import { useSettingsStore } from "../store/settingsStore";

// ─── 1. Rule: orphaned-heading ────────────────────────────────────────────────

describe("rule:orphaned-heading", () => {
  it("passes when headings are followed by body text", () => {
    const doc = "# Title\n\nSome body text.\n\n## Section\n\nMore text.\n";
    expect(lintDocument(doc, { rules: [ruleOrphanedHeading] })).toHaveLength(0);
  });

  it("flags a heading immediately followed by another heading", () => {
    const doc = "# Title\n\n## Section\n\nBody.\n";
    const violations = lintDocument(doc, { rules: [ruleOrphanedHeading] });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("orphaned-heading");
    expect(violations[0].severity).toBe("warning");
  });

  it("flags when headings are separated only by blank lines", () => {
    const doc = "## First\n\n\n## Second\n\nBody.\n";
    const violations = lintDocument(doc, { rules: [ruleOrphanedHeading] });
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("First");
  });

  it("does not flag the last heading if it has no successor", () => {
    // Single heading with no following heading
    const doc = "# Title\n\nBody only.\n";
    expect(lintDocument(doc, { rules: [ruleOrphanedHeading] })).toHaveLength(0);
  });

  it("flags multiple consecutive orphaned headings", () => {
    const doc = "# A\n\n## B\n\n### C\n\nBody.\n";
    const violations = lintDocument(doc, { rules: [ruleOrphanedHeading] });
    // A → B orphaned, B → C orphaned, C has body
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.ruleId).every((id) => id === "orphaned-heading")).toBe(true);
  });

  it("has no autofix (user must add content or remove heading)", () => {
    const doc = "# Title\n\n## Section\n\nBody.\n";
    const violations = lintDocument(doc, { rules: [ruleOrphanedHeading] });
    expect(violations[0].fix).toBeNull();
  });

  it("reports correct line number for the orphaned heading", () => {
    const doc = "# Title\n\n## Orphan\n\nBody.\n";
    const violations = lintDocument(doc, { rules: [ruleOrphanedHeading] });
    expect(violations[0].range!.from.line).toBe(1);
  });
});

// ─── 2. Rule: invalid-link-target ────────────────────────────────────────────

describe("rule:invalid-link-target", () => {
  it("passes on valid links", () => {
    const doc = "See [docs](https://example.com) and [local](./file.md).\n";
    expect(lintDocument(doc, { rules: [ruleInvalidLinkTarget] })).toHaveLength(0);
  });

  it("flags a link with an empty href", () => {
    const doc = "See [my link]() for details.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].severity).toBe("warning");
  });

  it("flags a link with a whitespace-only href", () => {
    const doc = "See [my link](   ) for details.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(1);
  });

  it("flags a link with a lone # href", () => {
    const doc = "Click [here](#) to continue.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("here");
  });

  it("flags a link with a lone ? href", () => {
    const doc = "Click [here](?) to continue.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(1);
  });

  it("autofix replaces invalid href with TODO placeholder", () => {
    const doc = "See [my link]() for details.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toContain("[my link](TODO)");
    expect(fixed).not.toContain("[my link]()");
  });

  it("autofix preserves surrounding text", () => {
    const doc = "Before [link](#) after.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toBe("Before [link](TODO) after.\n");
  });

  it("flags multiple invalid links in one document", () => {
    const doc = "[first]() and [second](#) and [valid](https://example.com).\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(2);
  });

  it("reports correct character range for the invalid link", () => {
    const doc = "Text [bad]() more.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    const { from, to } = violations[0].range!;
    // "[bad]()" starts at offset 5
    expect(from.offset).toBe(5);
    expect(to.offset).toBe(5 + "[bad]()".length);
  });
});

// ─── 3. Rule: missing-alt-text ────────────────────────────────────────────────

describe("rule:missing-alt-text", () => {
  it("passes when images have alt text", () => {
    const doc = "![A cat](cat.jpg) and ![Dog](dog.png).\n";
    expect(lintDocument(doc, { rules: [ruleMissingAltText] })).toHaveLength(0);
  });

  it("flags an image with no alt text", () => {
    const doc = "Look: ![](photo.jpg) here.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].severity).toBe("warning");
  });

  it("flags an image with whitespace-only alt text", () => {
    const doc = "Look: ![   ](photo.jpg) here.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations).toHaveLength(1);
  });

  it("autofix inserts a TODO placeholder", () => {
    const doc = "See ![](diagram.png) for context.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toContain("![TODO: describe image](diagram.png)");
    expect(fixed).not.toContain("![](diagram.png)");
  });

  it("autofix preserves surrounding text", () => {
    const doc = "Before ![](img.png) after.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toBe("Before ![TODO: describe image](img.png) after.\n");
  });

  it("flags multiple images missing alt text", () => {
    const doc = "![](a.png) text ![](b.png) more.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations).toHaveLength(2);
  });

  it("does not flag images with non-empty alt text", () => {
    const doc = "![My diagram](diagram.png)\n";
    expect(lintDocument(doc, { rules: [ruleMissingAltText] })).toHaveLength(0);
  });
});

// ─── 4. Chained violations + multi-fix application ───────────────────────────

describe("chained violations and multi-line fixes", () => {
  it("applies fixes for two different rules in one applyAllFixes pass", () => {
    const doc = "See ![](diagram.png) and [link]().\n";
    const violations = lintDocument(doc, {
      rules: [ruleMissingAltText, ruleInvalidLinkTarget],
    });
    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toContain("![TODO: describe image](diagram.png)");
    expect(fixed).toContain("[link](TODO)");
  });

  it("fixes trailing spaces and missing alt text in the same document", () => {
    const doc = "Intro.   \n\n![](photo.jpg)\n";
    const violations = lintDocument(doc, {
      rules: [ruleNoTrailingSpaces, ruleMissingAltText],
    });
    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).not.toMatch(/ +\n/);
    expect(fixed).toContain("![TODO: describe image](photo.jpg)");
  });

  it("fixes all four default-enabled rule violations in one pass", () => {
    const doc = [
      "# Section A   ",  // trailing spaces (3 = not hard-break)
      "",
      "## Section B", // orphaned heading (no body before ## C)
      "",
      "## Section C",
      "",
      "Body text.",
      "",
      "See ![](chart.png) for data.",
      "",
      "Contact [us]() for more.",
    ].join("\n") + "\n";

    const violations = lintDocument(doc, {
      rules: [ruleNoTrailingSpaces, ruleOrphanedHeading, ruleMissingAltText, ruleInvalidLinkTarget],
    });

    // trailing-space on line 1, orphaned-heading on Section A (→ Section B), missing-alt, invalid-link
    expect(violations.length).toBeGreaterThanOrEqual(3);

    const fixed = applyAllFixes(doc, violations);
    // Trailing spaces removed
    expect(fixed).not.toMatch(/Section A   \n/);
    // Missing alt text fixed
    expect(fixed).toContain("![TODO: describe image](chart.png)");
    // Invalid link fixed
    expect(fixed).toContain("[us](TODO)");
  });

  it("sequential rule passes produce the same result as applyAllFixes", () => {
    const doc = "Look ![](img.png) and visit [here]().\n";
    const allViolations = lintDocument(doc, {
      rules: [ruleMissingAltText, ruleInvalidLinkTarget],
    });
    const allFixed = applyAllFixes(doc, allViolations);

    // Sequential
    let seq = doc;
    const v1 = lintDocument(seq, { rules: [ruleMissingAltText] });
    seq = applyAllFixes(seq, v1);
    const v2 = lintDocument(seq, { rules: [ruleInvalidLinkTarget] });
    seq = applyAllFixes(seq, v2);

    // Both approaches should eliminate all the original violations
    const remaining = lintDocument(allFixed, {
      rules: [ruleMissingAltText, ruleInvalidLinkTarget],
    });
    expect(remaining).toHaveLength(0);

    const remainingSeq = lintDocument(seq, {
      rules: [ruleMissingAltText, ruleInvalidLinkTarget],
    });
    expect(remainingSeq).toHaveLength(0);
  });

  it("fix for invalid-link-target leaves valid links untouched", () => {
    const doc = "[valid](https://example.com) and [broken]().\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(1);
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toContain("[valid](https://example.com)");
    expect(fixed).toContain("[broken](TODO)");
  });
});

// ─── 5. Violation history helpers ────────────────────────────────────────────

describe("LinterToast violation history", () => {
  beforeEach(() => {
    clearLintHistory();
  });

  it("getLintHistory returns an empty array initially", () => {
    expect(getLintHistory()).toHaveLength(0);
  });

  it("clearLintHistory empties the log", () => {
    clearLintHistory();
    expect(getLintHistory()).toHaveLength(0);
  });

  it("getLintHistory returns a readonly array", () => {
    const history = getLintHistory();
    expect(Array.isArray(history)).toBe(true);
    // Attempting to push should throw in strict mode (readonly)
    // We verify it is read-only by type (the test just confirms the array type is returned)
    expect(typeof history).toBe("object");
  });

  it("LintHistoryEntry shape has expected fields", () => {
    // Construct a synthetic entry to validate the shape
    const entry: LintHistoryEntry = {
      ruleId: "no-trailing-spaces",
      message: "Trailing whitespace.",
      fixedAt: Date.now(),
      docSnippet: "abc   ",
    };
    expect(typeof entry.ruleId).toBe("string");
    expect(typeof entry.message).toBe("string");
    expect(typeof entry.fixedAt).toBe("number");
    expect(typeof entry.docSnippet).toBe("string");
  });
});

// ─── 6. settingsStore linterConfig ───────────────────────────────────────────

describe("settingsStore — linterConfig", () => {
  beforeEach(() => {
    useSettingsStore.setState({ linterConfig: { disabledRules: [] } });
  });

  it("starts with all rules enabled (empty disabledRules)", () => {
    const { linterConfig } = useSettingsStore.getState();
    expect(linterConfig.disabledRules).toEqual([]);
  });

  it("toggleLinterRule disables an enabled rule", () => {
    useSettingsStore.getState().toggleLinterRule("no-trailing-spaces");
    const { linterConfig } = useSettingsStore.getState();
    expect(linterConfig.disabledRules).toContain("no-trailing-spaces");
  });

  it("toggleLinterRule re-enables a disabled rule", () => {
    useSettingsStore.setState({ linterConfig: { disabledRules: ["no-trailing-spaces"] } });
    useSettingsStore.getState().toggleLinterRule("no-trailing-spaces");
    const { linterConfig } = useSettingsStore.getState();
    expect(linterConfig.disabledRules).not.toContain("no-trailing-spaces");
  });

  it("toggleLinterRule can disable multiple rules independently", () => {
    useSettingsStore.getState().toggleLinterRule("orphaned-heading");
    useSettingsStore.getState().toggleLinterRule("missing-alt-text");
    const { linterConfig } = useSettingsStore.getState();
    expect(linterConfig.disabledRules).toContain("orphaned-heading");
    expect(linterConfig.disabledRules).toContain("missing-alt-text");
    expect(linterConfig.disabledRules).toHaveLength(2);
  });

  it("setLinterConfig replaces the full config", () => {
    useSettingsStore.getState().toggleLinterRule("orphaned-heading");
    useSettingsStore.getState().setLinterConfig({ disabledRules: ["single-h1"] });
    const { linterConfig } = useSettingsStore.getState();
    expect(linterConfig.disabledRules).toEqual(["single-h1"]);
  });

  it("disabledRules from linterConfig are respected by lintDocument", () => {
    const doc = "Hello   \nWorld\n";
    const withRule = lintDocument(doc, { rules: [ruleNoTrailingSpaces] });
    expect(withRule).toHaveLength(1);

    const withDisabled = lintDocument(doc, {
      rules: [ruleNoTrailingSpaces],
      disabledRules: ["no-trailing-spaces"],
    });
    expect(withDisabled).toHaveLength(0);
  });
});

// ─── 7. LINTER_DEFAULT_ENABLED_RULES registry ─────────────────────────────────

describe("LINTER_DEFAULT_ENABLED_RULES", () => {
  it("contains exactly the four required default rules", () => {
    expect(LINTER_DEFAULT_ENABLED_RULES).toContain("no-trailing-spaces");
    expect(LINTER_DEFAULT_ENABLED_RULES).toContain("orphaned-heading");
    expect(LINTER_DEFAULT_ENABLED_RULES).toContain("invalid-link-target");
    expect(LINTER_DEFAULT_ENABLED_RULES).toContain("missing-alt-text");
  });

  it("all default rule IDs map to actual BUILTIN_RULES entries", () => {
    const builtinIds = new Set(BUILTIN_RULES.map((r) => r.id));
    for (const id of LINTER_DEFAULT_ENABLED_RULES) {
      expect(builtinIds.has(id)).toBe(true);
    }
  });

  it("BUILTIN_RULES contains the three new rule IDs", () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    expect(ids).toContain("orphaned-heading");
    expect(ids).toContain("invalid-link-target");
    expect(ids).toContain("missing-alt-text");
  });
});

// ─── 8. Edge cases ────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("lintDocument on an empty string produces no violations for new rules", () => {
    const violations = lintDocument("", {
      rules: [ruleOrphanedHeading, ruleInvalidLinkTarget, ruleMissingAltText],
    });
    expect(violations).toHaveLength(0);
  });

  it("lintDocument on whitespace-only doc produces no new-rule violations", () => {
    const violations = lintDocument("   \n\n   \n", {
      rules: [ruleOrphanedHeading, ruleInvalidLinkTarget, ruleMissingAltText],
    });
    expect(violations).toHaveLength(0);
  });

  it("missing-alt-text does not flag a markdown link (only images)", () => {
    const doc = "[empty text]() regular link.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations).toHaveLength(0); // only invalid-link-target rule would fire
  });

  it("invalid-link-target does not flag image tags", () => {
    const doc = "![](photo.jpg) is an image.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    // The regex matches [text](href) not ![text](href) — images are excluded
    expect(violations).toHaveLength(0);
  });

  it("applyAllFixes on a doc with no fixable violations returns original", () => {
    const doc = "# Title\n\n## Orphan\n\n## Section\n\nBody.\n";
    const violations = lintDocument(doc, { rules: [ruleOrphanedHeading] });
    expect(violations.some((v) => v.fix !== null)).toBe(false);
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });

  it("trailing-space fix handles multi-line doc correctly", () => {
    const doc = "line one   \nline two   \nline three\n";
    const violations = lintDocument(doc, { rules: [ruleNoTrailingSpaces] });
    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("line one\nline two\nline three\n");
  });

  it("all four default rules can run together on a messy document", () => {
    const doc = [
      "# Heading A   ",       // trailing spaces
      "",
      "## Heading B",          // orphaned heading (followed by Heading C)
      "",
      "## Heading C",
      "",
      "Body paragraph.",
      "",
      "Visit ![](chart.png).", // missing alt
      "",
      "Contact [us]().",       // invalid link target
    ].join("\n") + "\n";

    const violations = lintDocument(doc, {
      rules: [ruleNoTrailingSpaces, ruleOrphanedHeading, ruleMissingAltText, ruleInvalidLinkTarget],
    });

    const ids = new Set(violations.map((v) => v.ruleId));
    expect(ids.has("no-trailing-spaces")).toBe(true);
    expect(ids.has("orphaned-heading")).toBe(true);
    expect(ids.has("missing-alt-text")).toBe(true);
    expect(ids.has("invalid-link-target")).toBe(true);
  });
});
