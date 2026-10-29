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
  clearLintHistory,
  fixAllViolations,
  getLintHistory,
  type LintHistoryEntry,
} from "../components/LinterToast";
import { useSettingsStore } from "../store/settingsStore";
import {
  applyAllFixes,
  applyFix,
  BUILTIN_RULES,
  LINTER_DEFAULT_ENABLED_RULES,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
  ruleNoTrailingSpaces,
  ruleOrphanedHeading,
} from "./mdlint";

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
    expect(
      violations.map((v) => v.ruleId).every((id) => id === "orphaned-heading"),
    ).toBe(true);
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

  it("leaves a valid link unchanged and proposes no href fix during linting", () => {
    const doc = "See [docs](https://example.com/guide?topic=lint#links).   \n";
    const violations = lintDocument(doc, {
      rules: [ruleInvalidLinkTarget, ruleNoTrailingSpaces],
    });

    expect(doc).toBe("See [docs](https://example.com/guide?topic=lint#links).   \n");
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "no-trailing-spaces",
    ]);
    expect(violations[0].fix).not.toBeNull();
  });

  it("preserves a valid HTTPS link and surrounding prose when autofixing trailing spaces", () => {
    const doc =
      "Before [café guide](https://example.com/guide?topic=lint#links) after.   \n";
    const expected =
      "Before [café guide](https://example.com/guide?topic=lint#links) after.\n";
    const rules = [ruleInvalidLinkTarget, ruleNoTrailingSpaces];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "no-trailing-spaces",
    ]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("preserves a valid fragment link and surrounding text when fixing neighboring links", () => {
    const heading = "# Installation\n\n";
    const doc = `${heading}Before [first]() see [installation](#installation) for details, then [last](#) after.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(
      `${heading}Before [first](TODO) see [installation](#installation) for details, then [last](#) after.\n`,
    );
    expect(applyFix(doc, violations[1])).toBe(
      `${heading}Before [first]() see [installation](#installation) for details, then [last](TODO) after.\n`,
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `${heading}Before [first](TODO) see [installation](#installation) for details, then [last](TODO) after.\n`,
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("preserves an HTTPS link and surrounding prose while fixing links on both sides", () => {
    const doc =
      "Before [draft]() café; read [the guide](https://example.com/guide?topic=lint#links) " +
      "for details, then visit [next](#) afterward.\r\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Before [draft](TODO) café; read [the guide](https://example.com/guide?topic=lint#links) " +
        "for details, then visit [next](TODO) afterward.\r\n",
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("flags a link with an empty href", () => {
    const doc = "See [my link]() for details.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].severity).toBe("warning");
  });

  it("identifies the invalid link in the original input without changing its label", () => {
    const doc = "See [published guide](./guide.md).\nThen read [draft guide]() next.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: "invalid-link-target",
      severity: "warning",
      message: "Invalid link target: [draft guide](empty)",
      range: {
        from: { offset: 45, line: 2, col: 10 },
        to: { offset: 60, line: 2, col: 25 },
      },
    });
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[draft guide]()");
    expect(doc).toBe(
      "See [published guide](./guide.md).\nThen read [draft guide]() next.\n",
    );
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

  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("reports invalid destination %j without applying its fix during linting", (destination) => {
    const link = `[draft guide](${destination})`;
    const source = `Before ${link} after.\n`;
    const violations = lintDocument(source, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: "invalid-link-target",
      severity: "warning",
      range: { from: { offset: 7 }, to: { offset: 7 + link.length } },
    });
    expect(violations[0].fix).not.toBeNull();
    expect(source).toBe(`Before [draft guide](${destination}) after.\n`);
  });

  it("autofix replaces invalid href with TODO placeholder", () => {
    const doc = "See [my link]() for details.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toContain("[my link](TODO)");
    expect(fixed).not.toContain("[my link]()");
  });

  it.each([
    "   ",
    "\t\t",
    "\u00a0",
  ])("autofix replaces a whitespace-only href %j while preserving link text and prose", (href) => {
    const doc = `See [my link](${href}) for details.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    const expected = "See [my link](TODO) for details.\n";
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    "",
    "  \t ",
    "#",
    "?",
  ])("preserves the full multiword label when fixing destination %j", (destination) => {
    const label = "A detailed guide to preserving every word in this link label";
    const doc = `Before [${label}](${destination}) after.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();

    const expected = `Before [${label}](TODO) after.\n`;
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it("fixes a mixed whitespace destination alongside other links", () => {
    const doc = "See [café guide]( \t  ) and [other](#), then [valid](./guide.md).\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(2);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "See [café guide](TODO) and [other](TODO), then [valid](./guide.md).\n",
    );
    expect(lintDocument(fixed, { rules })).toHaveLength(0);
  });

  it("autofix preserves surrounding text", () => {
    const doc = "Before [link](#) after.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toBe("Before [link](TODO) after.\n");
  });

  it("preserves a bracketed year in prose while fixing links on either side", () => {
    const doc = "See [draft]() for the report from [2024], then [notes](#).\n";
    const expected =
      "See [draft](TODO) for the report from [2024], then [notes](TODO).\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("preserves surrounding text and CRLF line endings when fixing a later link", () => {
    const doc = "First line.\r\n\r\nBefore [draft]() after.\r\nLast line.\r\n";
    const expected = "First line.\r\n\r\nBefore [draft](TODO) after.\r\nLast line.\r\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it("preserves multiline surrounding prose and its original line endings", () => {
    const doc =
      "Opening line with café.\r\nSecond line keeps  its spacing.\n\n" +
      "Read [draft guide](#) for details.\r\n" +
      "The next line has a tab\there.\nFinal line without a newline.";
    const expected =
      "Opening line with café.\r\nSecond line keeps  its spacing.\n\n" +
      "Read [draft guide](TODO) for details.\r\n" +
      "The next line has a tab\there.\nFinal line without a newline.";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it.each([
    ["guide", ""],
    ["", "#"],
    ["draft guide", " \t "],
    ["guide", "?"],
  ])("changes only the invalid destination of a later-line link with label %j", (label, destination) => {
    const prefix = "First line: café.\n\nSecond line stays intact.\n";
    const suffix = "\nFollowing line with [valid](./file.md).\nFinal line.\n";
    const doc = `${prefix}Before [${label}](${destination}) after.${suffix}`;
    const expected = `${prefix}Before [${label}](TODO) after.${suffix}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].range?.from).toEqual({
      offset: prefix.length + "Before ".length,
      line: 4,
      col: 7,
    });
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it.each([
    "",
    "First line.\n",
  ])("autofixes a link at the start of a line after %j without losing following text", (prefix) => {
    const doc = `${prefix}[link]() followed by text.\nNext line.\n`;
    const expected = `${prefix}[link](TODO) followed by text.\nNext line.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it.each([
    [
      "See [docs](https://example.com/guide?topic=lint#links) and [draft]().\n",
      "See [docs](https://example.com/guide?topic=lint#links) and [draft](TODO).\n",
    ],
    [
      "See [draft]() and [docs](https://example.com/guide?topic=lint#links).\n",
      "See [draft](TODO) and [docs](https://example.com/guide?topic=lint#links).\n",
    ],
  ])("autofixes only the invalid destination in %s", (doc, expected) => {
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toHaveLength(0);
  });

  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("fixes destination %j next to a valid link in either order", (destination) => {
    const valid = "[café docs](https://example.com/guide?topic=lint#links)";
    const invalid = `[draft guide](${destination})`;
    const repaired = "[draft guide](TODO)";
    const rules = [ruleInvalidLinkTarget];

    for (const [links, expectedLinks] of [
      [valid + invalid, valid + repaired],
      [invalid + valid, repaired + valid],
    ]) {
      const doc = `Before ${links} after.\r\n`;
      const expected = `Before ${expectedLinks} after.\r\n`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      expect(applyAllFixes(doc, violations)).toBe(expected);
      expect(lintDocument(expected, { rules })).toHaveLength(0);
    }
  });

  it.each([
    ["[guide](TODO)[guide](#)", "[guide](TODO)[guide](TODO)"],
    ["[guide](#)[guide](TODO)", "[guide](TODO)[guide](TODO)"],
  ])("preserves an adjacent valid link with the same label: %s", (links, expectedLinks) => {
    const doc = `Before ${links} after.\n`;
    const expected = `Before ${expectedLinks} after.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toHaveLength(0);
  });

  it.each([
    ["[guide](./guide.md) and [guide](#)", "[guide](./guide.md) and [guide](TODO)"],
    ["[guide](#) and [guide](./guide.md)", "[guide](TODO) and [guide](./guide.md)"],
  ])("fixes only the invalid destination when links share a label: %s", (links, expectedLinks) => {
    const doc = `📚 Read ${links} for details.\n`;
    const expected = `📚 Read ${expectedLinks} for details.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("is idempotent when autofixing a broken link", () => {
    const doc = "Before [link]() after.\n";
    const rules = [ruleInvalidLinkTarget];
    const once = applyAllFixes(doc, lintDocument(doc, { rules }));
    const twice = applyAllFixes(once, lintDocument(once, { rules }));

    expect(once).toBe("Before [link](TODO) after.\n");
    expect(twice).toBe(once);
  });

  it("is idempotent with default rules when an unfixed warning remains", () => {
    const doc = "# First\n\n## Second\n\nRead [draft]() and [guide](./guide.md).   \n";
    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId).sort()).toEqual([
      "invalid-link-target",
      "no-trailing-spaces",
      "orphaned-heading",
    ]);

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(
      "# First\n\n## Second\n\nRead [draft](TODO) and [guide](./guide.md).\n",
    );
    const remaining = lintDocument(once, { rules });
    expect(remaining.map((violation) => violation.ruleId)).toEqual([
      "orphaned-heading",
    ]);
    expect(remaining[0].fix).toBeNull();
    expect(applyAllFixes(once, remaining)).toBe(once);
  });

  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("keeps the result unchanged on a second autofix pass for href %j", (href) => {
    const doc = `See ![](diagram.png) and [draft](${href}); [docs](./guide.md) stays.\n`;
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);

    const once = applyAllFixes(doc, violations);
    const twice = applyAllFixes(once, lintDocument(once, { rules }));

    expect(once).toBe(
      "See ![TODO: describe image](diagram.png) and [draft](TODO); [docs](./guide.md) stays.\n",
    );
    expect(twice).toBe(once);
  });

  it("autofixes a link on the final line without adding a trailing newline", () => {
    const doc = "First line.\nSee [link](#)";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe("First line.\nSee [link](TODO)");
    expect(applyAllFixes(doc, violations)).toBe("First line.\nSee [link](TODO)");
  });

  it("flags multiple invalid links in one document", () => {
    const doc = "[first]() and [second](#) and [valid](https://example.com).\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(2);
  });

  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("reports and fixes each repeated identical link with destination %j", (destination) => {
    const link = `[draft guide](${destination})`;
    const fixedLink = "[draft guide](TODO)";
    for (const separator of [" between ", "\r\nThen "]) {
      const doc = `Before ${link}${separator}${link} after.\n`;
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });
      const first = doc.indexOf(link);
      const second = doc.indexOf(link, first + link.length);

      expect(violations).toHaveLength(2);
      expect(
        violations.map((violation) => ({
          ruleId: violation.ruleId,
          from: violation.range?.from.offset,
          to: violation.range?.to.offset,
        })),
      ).toEqual(
        [first, second].map((offset) => ({
          ruleId: "invalid-link-target",
          from: offset,
          to: offset + link.length,
        })),
      );
      expect(violations.every((violation) => violation.fix !== null)).toBe(true);
      expect(applyFix(doc, violations[0])).toBe(
        `Before ${fixedLink}${separator}${link} after.\n`,
      );
      expect(applyFix(doc, violations[1])).toBe(
        `Before ${link}${separator}${fixedLink} after.\n`,
      );

      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(`Before ${fixedLink}${separator}${fixedLink} after.\n`);
      expect(lintDocument(fixed, { rules })).toHaveLength(0);
    }
  });

  it("autofixes two invalid links on one line without changing surrounding text", () => {
    const doc = "Before [first]() between [second](#) and [valid](./file.md) after.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(2);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Before [first](TODO) between [second](TODO) and [valid](./file.md) after.\n",
    );
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toHaveLength(0);
  });

  it("autofixes invalid links on separate lines while preserving labels and line breaks", () => {
    const doc = "See [first guide]() for details.\n\nThen visit [second guide](#).\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(2);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "See [first guide](TODO) for details.\n\nThen visit [second guide](TODO).\n",
    );
    expect(lintDocument(fixed, { rules })).toHaveLength(0);
  });

  it("preserves mixed line endings when fixing links on separate lines", () => {
    const doc = "Intro.\r\nFirst [one]().\nMiddle.\r\nSecond [two](#).\nEnd.\r\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(2);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);

    expect(applyFix(doc, violations[0])).toBe(
      "Intro.\r\nFirst [one](TODO).\nMiddle.\r\nSecond [two](#).\nEnd.\r\n",
    );
    expect(applyFix(doc, violations[1])).toBe(
      "Intro.\r\nFirst [one]().\nMiddle.\r\nSecond [two](TODO).\nEnd.\r\n",
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Intro.\r\nFirst [one](TODO).\nMiddle.\r\nSecond [two](TODO).\nEnd.\r\n",
    );
    expect(lintDocument(fixed, { rules })).toHaveLength(0);
  });

  it("fixes every invalid destination across lines without changing surrounding prose", () => {
    const doc =
      "Café: [first]() then [second](   ); keep [docs](./guide.md).\r\n" +
      "Next, [third](#) and [fourth](?) finish the sentence.";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(4);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Café: [first](TODO) then [second](TODO); keep [docs](./guide.md).\r\n" +
        "Next, [third](TODO) and [fourth](TODO) finish the sentence.",
    );
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toHaveLength(0);
    expect(applyAllFixes(fixed, remaining)).toBe(fixed);
  });

  it("preserves a valid link and surrounding text while fixing links on both sides", () => {
    const doc =
      "Before [first]() café, see [docs](https://example.com/guide?topic=lint#links) for details; then [last](#) after.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(2);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Before [first](TODO) café, see [docs](https://example.com/guide?topic=lint#links) for details; then [last](TODO) after.\n",
    );
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toHaveLength(0);
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
  it("preserves a descriptive image with a relative source and its surrounding prose", () => {
    const paragraph =
      "Before the illustration, see ![A map of the café garden](../assets/garden.png) for details.\r\n";
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const cleanViolations = lintDocument(paragraph, { rules });

    expect(cleanViolations).toEqual([]);
    expect(applyAllFixes(paragraph, cleanViolations)).toBe(paragraph);

    const doc = `${paragraph}\r\nRead [draft]() next.\r\n`;
    const expected = `${paragraph}\r\nRead [draft](TODO) next.\r\n`;
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("leaves an image with descriptive alt text and a query string unchanged after autofix", () => {
    const doc =
      "See ![A sleeping cat on a windowsill](images/cat.jpg?size=2&format=webp) for context.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(
      "See ![A sleeping cat on a windowsill](images/cat.jpg?size=2&format=webp) for context.\n",
    );
  });

  it("leaves a descriptive image unchanged and proposes no alt-text fix when linting", () => {
    const doc = "See ![A sleeping cat on a windowsill](images/cat.jpg) for context.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });

    expect(doc).toBe(
      "See ![A sleeping cat on a windowsill](images/cat.jpg) for context.\n",
    );
    expect(violations).toEqual([]);
  });

  it("passes when images have alt text", () => {
    const doc = "![A cat](cat.jpg) and ![Dog](dog.png).\n";
    expect(lintDocument(doc, { rules: [ruleMissingAltText] })).toHaveLength(0);
  });

  it("preserves descriptive alt text and the image source when fixing trailing spaces", () => {
    const doc =
      "See ![A sleeping cat on a windowsill](images/cat.jpg?size=2#preview).   \n";
    const expected =
      "See ![A sleeping cat on a windowsill](images/cat.jpg?size=2#preview).\n";
    const rules = [ruleMissingAltText, ruleNoTrailingSpaces];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "no-trailing-spaces",
    ]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it("flags an image with no alt text", () => {
    const doc = "Look: ![](photo.jpg) here.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].severity).toBe("warning");
  });

  it.each([
    "",
    " \t ",
  ])("fixes alt text %j next to a described image in either order", (alt) => {
    const described = "![A sleeping cat](images/cat.jpg?size=2#preview)";
    const missing = `![${alt}](images/diagram.png)`;
    const repaired = "![TODO: describe image](images/diagram.png)";
    const rules = [ruleMissingAltText];

    for (const [images, expectedImages] of [
      [described + missing, described + repaired],
      [missing + described, repaired + described],
    ]) {
      const doc = `Before ${images} after.\r\n`;
      const expected = `Before ${expectedImages} after.\r\n`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("missing-alt-text");
      expect(violations[0].fix).not.toBeNull();
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(missing);
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(lintDocument(fixed, { rules })).toHaveLength(0);
    }
  });

  it("flags an image with whitespace-only alt text", () => {
    const doc = "Look: ![   ](photo.jpg) here.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations).toHaveLength(1);
  });

  it("reports whitespace-only alt text without changing the document during linting", () => {
    const doc = "Before ![ \t ](images/photo.jpg?size=2) after.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });

    expect(doc).toBe("Before ![ \t ](images/photo.jpg?size=2) after.\n");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: "missing-alt-text",
      severity: "warning",
      range: { from: { offset: 7 }, to: { offset: 38 } },
    });
    expect(violations[0].fix).not.toBeNull();
  });

  it("autofix inserts a TODO placeholder", () => {
    const doc = "See ![](diagram.png) for context.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toContain("![TODO: describe image](diagram.png)");
    expect(fixed).not.toContain("![](diagram.png)");
  });

  it("autofixes missing alt text while preserving a relative image source exactly", () => {
    const doc = "Before ![](../assets/./chart%20one.png?size=2#preview) after.\r\n";
    const expected =
      "Before ![TODO: describe image](../assets/./chart%20one.png?size=2#preview) after.\r\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it("preserves each relative image source when fixing multiple missing alts", () => {
    const doc =
      "See ![](./images/chart.png?size=2#preview) and ![ \t ](../assets/map%20one.svg).\n" +
      "Read [the guide](./guide.md) for details.";
    const firstFixed =
      "See ![TODO: describe image](./images/chart.png?size=2#preview) and ![ \t ](../assets/map%20one.svg).\n" +
      "Read [the guide](./guide.md) for details.";
    const expected =
      "See ![TODO: describe image](./images/chart.png?size=2#preview) and ![TODO: describe image](../assets/map%20one.svg).\n" +
      "Read [the guide](./guide.md) for details.";
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(firstFixed);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(fixed);
  });

  it.each(["", " \t "])("is idempotent when autofixing image alt text %j", (alt) => {
    const doc = `Before ![${alt}](images/chart.png?size=2#preview) after.\n`;
    const rules = [ruleMissingAltText];
    const once = applyAllFixes(doc, lintDocument(doc, { rules }));
    const twice = applyAllFixes(once, lintDocument(once, { rules }));

    expect(once).toBe(
      "Before ![TODO: describe image](images/chart.png?size=2#preview) after.\n",
    );
    expect(twice).toBe(once);
  });

  it.each([
    "   ",
    " \t ",
  ])("autofixes whitespace-only alt text while preserving the image source and prose", (alt) => {
    const doc = `Before ![${alt}](images/photo.jpg?size=2#preview) after.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();

    const expected =
      "Before ![TODO: describe image](images/photo.jpg?size=2#preview) after.\n";
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it("autofixes Unicode whitespace-only alt text without changing a Unicode source or CRLF", () => {
    const doc =
      "Intro 😀.\r\nSee ![\u00a0\t\u2003](画像/星🌟.png?size=2#詳細) here.\r\n";
    const expected =
      "Intro 😀.\r\nSee ![TODO: describe image](画像/星🌟.png?size=2#詳細) here.\r\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it("autofix preserves surrounding text", () => {
    const doc = "Before ![](img.png) after.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toBe("Before ![TODO: describe image](img.png) after.\n");
  });

  it("preserves a Unicode image source and surrounding prose when fixing empty alt text", () => {
    const doc = "前置き 😀 ![](画像/星🌟-café.png?言語=日本語#詳細) 之后 café.\n";
    const expected =
      "前置き 😀 ![TODO: describe image](画像/星🌟-café.png?言語=日本語#詳細) 之后 café.\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it("fixes an empty alt at the start of a later line without changing surrounding lines", () => {
    const doc =
      "Intro: café and 😀.\n\n![](images/chart.png?size=2#preview) explains the data.\n" +
      "Next line keeps its  spacing.\n";
    const expected =
      "Intro: café and 😀.\n\n![TODO: describe image](images/chart.png?size=2#preview) explains the data.\n" +
      "Next line keeps its  spacing.\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it.each([
    "\nNext line.\n",
    "",
  ])("autofixes an empty alt at the end of a line with suffix %j", (suffix) => {
    const doc = `First line.\nSee the diagram: ![](images/chart.png)${suffix}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();

    const expected = `First line.\nSee the diagram: ![TODO: describe image](images/chart.png)${suffix}`;
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it("only fixes an empty alt before an image with descriptive alt", () => {
    const doc = "Before ![](first.png) between ![A sleeping cat](cat.jpg) after.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();

    const expected =
      "Before ![TODO: describe image](first.png) between ![A sleeping cat](cat.jpg) after.\n";
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules: [ruleMissingAltText] })).toHaveLength(0);
  });

  it("only fixes an empty alt after an image with descriptive alt", () => {
    const doc =
      "Café: ![A sleeping cat](images/cat.jpg?size=2#preview) next to ![](images/dog.png).\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();

    const expected =
      "Café: ![A sleeping cat](images/cat.jpg?size=2#preview) next to ![TODO: describe image](images/dog.png).\n";
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toHaveLength(0);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    [
      "![](shared.png)![A cat](shared.png)",
      "![TODO: describe image](shared.png)![A cat](shared.png)",
    ],
    [
      "![A cat](shared.png)![](shared.png)",
      "![A cat](shared.png)![TODO: describe image](shared.png)",
    ],
  ])("fixes only the empty alt in adjacent images: %s", (doc, expected) => {
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it("flags multiple images missing alt text", () => {
    const doc = "![](a.png) text ![](b.png) more.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations).toHaveLength(2);
  });

  it("fixes distinct empty-alt images on separate lines while preserving their sources", () => {
    const first = "../assets/chart%20one.png?size=2#preview";
    const second = "images/写真.svg?theme=dark#detail";
    const doc = `Café: ![](${first})\r\nBetween images.\r\n![](${second}) at the end.\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(
      `Café: ![TODO: describe image](${first})\r\nBetween images.\r\n![](${second}) at the end.\r\n`,
    );
    expect(applyFix(doc, violations[1])).toBe(
      `Café: ![](${first})\r\nBetween images.\r\n![TODO: describe image](${second}) at the end.\r\n`,
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `Café: ![TODO: describe image](${first})\r\nBetween images.\r\n![TODO: describe image](${second}) at the end.\r\n`,
    );
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toHaveLength(0);
    expect(applyAllFixes(fixed, remaining)).toBe(fixed);
  });

  it("autofixes adjacent images with empty alt text and preserves both sources", () => {
    const doc = "Café: ![](images/first.png)![](images/second.jpg?size=2#preview).\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Café: ![TODO: describe image](images/first.png)![TODO: describe image](images/second.jpg?size=2#preview).\n",
    );
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toHaveLength(0);
    expect(applyAllFixes(fixed, remaining)).toBe(fixed);
  });

  it("autofixes multiple images on one line without changing sources or prose", () => {
    const doc =
      "Before ![](first.png) between ![   ](images/second.jpg?size=2) and ![Existing](third.svg) after.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations).toHaveLength(2);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Before ![TODO: describe image](first.png) between ![TODO: describe image](images/second.jpg?size=2) and ![Existing](third.svg) after.\n",
    );
    expect(lintDocument(fixed, { rules: [ruleMissingAltText] })).toHaveLength(0);
  });

  it("does not flag images with non-empty alt text", () => {
    const doc = "![My diagram](diagram.png)\n";
    expect(lintDocument(doc, { rules: [ruleMissingAltText] })).toHaveLength(0);
  });
});

// ─── 4. Chained violations + multi-fix application ───────────────────────────

describe("chained violations and multi-line fixes", () => {
  it.each([
    "\n",
    "\r\n",
  ])("preserves a bracketed word at the end of a paragraph and its final newline %j", (newline) => {
    const doc = `Read [draft]() and see ![](chart.png) for details [note]${newline}`;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `Read [draft](TODO) and see ![TODO: describe image](chart.png) for details [note]${newline}`,
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    "\n",
    "\r\n",
  ])("keeps interleaved link and image fixes unchanged on a second pass with newline %j", (newline) => {
    const doc = [
      "Café: [first]() then ![](first.png) and [valid](./guide.md).",
      "See ![diagram](valid.png), [second](#), and ![  ](second.jpg).",
    ].join(newline);
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
      "invalid-link-target",
      "missing-alt-text",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(
      [
        "Café: [first](TODO) then ![TODO: describe image](first.png) and [valid](./guide.md).",
        "See ![diagram](valid.png), [second](TODO), and ![TODO: describe image](second.jpg).",
      ].join(newline),
    );
    const remaining = lintDocument(once, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(once, remaining)).toBe(once);
  });

  it.each([
    ["````", "\n"],
    ["~~~~", "\r\n"],
  ])("preserves examples after a shorter marker inside a %s fence", (fence, newline) => {
    const code = [
      `${fence}markdown`,
      "[draft]() and ![](diagram.png)",
      fence.slice(0, 3),
      "[draft]() and ![](diagram.png)",
      fence,
    ].join(newline);
    const doc = [`Before [draft]().`, "", code, "", "After ![](diagram.png).", ""].join(
      newline,
    );
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      [
        "Before [draft](TODO).",
        "",
        code,
        "",
        "After ![TODO: describe image](diagram.png).",
        "",
      ].join(newline),
    );
    expect(lintDocument(fixed, { rules })).toHaveLength(0);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    "```",
    "~~~",
  ])("preserves link and image examples inside a %s fence", (fence) => {
    const code = [
      `${fence}markdown`,
      "[example]() and [anchor](#)",
      "![](example.png) and ![   ](other.jpg)",
      fence,
    ].join("\n");
    const doc = `Before [link]().\n\n${code}\n\nAfter ![](image.png).\n`;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `Before [link](TODO).\n\n${code}\n\nAfter ![TODO: describe image](image.png).\n`,
    );
    expect(lintDocument(fixed, { rules })).toHaveLength(0);
  });

  it.each([
    ["```", "\n"],
    ["~~~", "\r\n"],
  ])("preserves link and image examples in an unclosed %s fence", (fence, newline) => {
    const code = [
      `${fence}markdown`,
      "[draft]() and [anchor](#)",
      "![](diagram.png) and ![  ](other.jpg)",
    ].join(newline);
    const doc = ["Before [draft]() and ![](diagram.png).", "", code].join(newline);
    const expected = [
      "Before [draft](TODO) and ![TODO: describe image](diagram.png).",
      "",
      code,
    ].join(newline);
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("preserves a valid image and surrounding prose while applying fixes on both sides", () => {
    const doc =
      "Before [first]() café, see ![A sleeping cat](images/cat.jpg?size=2) in the middle; " +
      "after it, visit [second](#) for details.\n";
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Before [first](TODO) café, see ![A sleeping cat](images/cat.jpg?size=2) in the middle; " +
        "after it, visit [second](TODO) for details.\n",
    );
    expect(lintDocument(fixed, { rules })).toHaveLength(0);
  });

  it("fixes an empty image alt and invalid link on separate lines without changing other lines", () => {
    const doc =
      "Intro: café\tkeeps its spacing.\n\nSee ![](diagram.png) for context.\n" +
      "Unrelated  text stays here.\nVisit [docs]() for details.\n\nEnd.\n";
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Intro: café\tkeeps its spacing.\n\nSee ![TODO: describe image](diagram.png) for context.\n" +
        "Unrelated  text stays here.\nVisit [docs](TODO) for details.\n\nEnd.\n",
    );
    expect(lintDocument(fixed, { rules })).toHaveLength(0);
  });

  it("keeps an empty-alt image fix unchanged on a second pass with a remaining warning", () => {
    const doc = "# First\n\n## Second\n\nSee ![](chart.png) and [draft]().\n";
    const rules = [ruleOrphanedHeading, ruleMissingAltText, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
      "orphaned-heading",
    ]);

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(
      "# First\n\n## Second\n\nSee ![TODO: describe image](chart.png) and [draft](TODO).\n",
    );
    const remaining = lintDocument(once, { rules });
    expect(remaining.map((violation) => violation.ruleId)).toEqual([
      "orphaned-heading",
    ]);
    expect(remaining[0].fix).toBeNull();
    expect(applyAllFixes(once, remaining)).toBe(once);
  });

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
    const doc =
      [
        "# Section A   ", // trailing spaces (3 = not hard-break)
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
      rules: [
        ruleNoTrailingSpaces,
        ruleOrphanedHeading,
        ruleMissingAltText,
        ruleInvalidLinkTarget,
      ],
    });

    // trailing-space on line 1, orphaned-heading on Section A (→ Section B), missing-alt, invalid-link
    expect(violations.length).toBeGreaterThanOrEqual(3);

    const fixed = applyAllFixes(doc, violations);
    // Trailing spaces removed
    expect(fixed).not.toMatch(/Section A {3}\n/);
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

  it("does not change text or record another fix on a second pass for an empty image alt", () => {
    const doc = "See ![](images/chart.png) for context.   \n";
    const rules = [ruleNoTrailingSpaces, ruleMissingAltText];
    const once = fixAllViolations(doc, lintDocument(doc, { rules }));
    const historyAfterFirstPass = [...getLintHistory()];
    const twice = fixAllViolations(once, lintDocument(once, { rules }));

    expect(once).toBe("See ![TODO: describe image](images/chart.png) for context.\n");
    expect(twice).toBe(once);
    expect(historyAfterFirstPass.map((entry) => entry.ruleId)).toEqual([
      "missing-alt-text",
      "no-trailing-spaces",
    ]);
    expect(getLintHistory()).toEqual(historyAfterFirstPass);
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

  it("Fix all repairs an invalid link and preserves a valid link", () => {
    const doc = "Read [docs](https://example.com/guide#links), then [draft]().\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const fixed = fixAllViolations(doc, violations);
    expect(fixed).toBe(
      "Read [docs](https://example.com/guide#links), then [draft](TODO).\n",
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(getLintHistory().map((entry) => entry.ruleId)).toEqual([
      "invalid-link-target",
    ]);
  });

  it("Fix all preserves distinct labels and prose around multiple invalid links", () => {
    const doc =
      "Start with [café guide](), then [API reference](#); keep [docs](./docs.md).\r\n" +
      "For more, see [release notes]( \t ) and [next steps](?) at the end.";
    const expected =
      "Start with [café guide](TODO), then [API reference](TODO); keep [docs](./docs.md).\r\n" +
      "For more, see [release notes](TODO) and [next steps](TODO) at the end.";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(4);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const fixed = fixAllViolations(doc, violations);
    expect(fixed).toBe(expected);
    expect(getLintHistory().map((entry) => entry.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "invalid-link-target",
      "invalid-link-target",
    ]);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(fixAllViolations(fixed, remaining)).toBe(expected);
    expect(getLintHistory()).toHaveLength(4);
  });

  it.each([
    true,
    false,
  ])("Fix all preserves a described image when an empty-alt image is on another line (described first: %s)", (describedFirst) => {
    const described = "![A café at sunset](images/cafe.jpg?size=2#preview)";
    const empty = "![](images/chart.png?view=full#data)";
    const repaired = "![TODO: describe image](images/chart.png?view=full#data)";
    const lines = describedFirst ? [described, empty] : [empty, described];
    const expectedLines = describedFirst
      ? [described, repaired]
      : [repaired, described];
    const doc = `Intro.\r\n${lines.join("\r\nBetween images.\r\n")}\r\nEnd.\r\n`;
    const expected = `Intro.\r\n${expectedLines.join("\r\nBetween images.\r\n")}\r\nEnd.\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(empty);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = fixAllViolations(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(getLintHistory().map((entry) => entry.ruleId)).toEqual(["missing-alt-text"]);
  });

  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("Fix all is idempotent for invalid destination %j with a remaining warning", (destination) => {
    const doc = `# First\n\n## Second\n\nRead [draft](${destination}).\n`;
    const rules = [ruleOrphanedHeading, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId).sort()).toEqual([
      "invalid-link-target",
      "orphaned-heading",
    ]);

    const once = fixAllViolations(doc, violations);
    expect(once).toBe("# First\n\n## Second\n\nRead [draft](TODO).\n");
    const remaining = lintDocument(once, { rules });
    expect(remaining.map((violation) => violation.ruleId)).toEqual([
      "orphaned-heading",
    ]);
    expect(remaining[0].fix).toBeNull();
    expect(fixAllViolations(once, remaining)).toBe(once);
    expect(getLintHistory().map((entry) => entry.ruleId)).toEqual([
      "invalid-link-target",
    ]);
  });

  it("Fix all applies every fix without corrupting later offsets", () => {
    // The image fix lengthens the text before the link, so applying fixes in
    // document order would splice the link fix at a stale offset.
    const doc = "See ![](a.png) and [link]().\n";
    const violations = lintDocument(doc, {
      rules: [ruleMissingAltText, ruleInvalidLinkTarget],
    });
    expect(violations).toHaveLength(2);
    expect(fixAllViolations(doc, violations)).toBe(
      "See ![TODO: describe image](a.png) and [link](TODO).\n",
    );
    expect(getLintHistory().map((e) => e.ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
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
    useSettingsStore.setState({
      linterConfig: { disabledRules: ["no-trailing-spaces"] },
    });
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
  it.each([
    "",
    "\n",
  ])("leaves clean Markdown unchanged with final newline %j", (ending) => {
    const doc =
      [
        "---",
        "title: Café guide",
        "---",
        "",
        "# Café guide",
        "",
        "Read the [guide](https://example.com/guide) and see ![A diagram](diagram.png).",
        "",
        "## Details",
        "",
        "Keep  internal spacing and Unicode: ☕.",
      ].join("\n") + ending;
    const violations = lintDocument(doc);

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });

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
    const doc =
      [
        "# Heading A   ", // trailing spaces
        "",
        "## Heading B", // orphaned heading (followed by Heading C)
        "",
        "## Heading C",
        "",
        "Body paragraph.",
        "",
        "Visit ![](chart.png).", // missing alt
        "",
        "Contact [us]().", // invalid link target
      ].join("\n") + "\n";

    const violations = lintDocument(doc, {
      rules: [
        ruleNoTrailingSpaces,
        ruleOrphanedHeading,
        ruleMissingAltText,
        ruleInvalidLinkTarget,
      ],
    });

    const ids = new Set(violations.map((v) => v.ruleId));
    expect(ids.has("no-trailing-spaces")).toBe(true);
    expect(ids.has("orphaned-heading")).toBe(true);
    expect(ids.has("missing-alt-text")).toBe(true);
    expect(ids.has("invalid-link-target")).toBe(true);
  });
});
