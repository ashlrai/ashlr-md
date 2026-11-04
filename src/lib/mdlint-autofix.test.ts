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
  type LintViolation,
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

describe("autofix: undescribed image at the start of a line", () => {
  it.each([
    "\n",
    "\r\n",
  ])("preserves the complete trailing text with %j line endings", (nl) => {
    const doc = `Intro.${nl}${nl}![](images/chart.png "Chart") followed by *details* and [notes](./notes.md).${nl}Next line.${nl}`;
    const expected = `Intro.${nl}${nl}![TODO: describe image](images/chart.png "Chart") followed by *details* and [notes](./notes.md).${nl}Next line.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    [
      "no title, prose after",
      "![](a.png) then *prose* here.",
      "![TODO: describe image](a.png) then *prose* here.",
    ],
    ["image alone on its line", "![](a.png)", "![TODO: describe image](a.png)"],
    [
      "two line-start images, each with prose",
      "![](a.png) one.\n![](b.png) two.",
      "![TODO: describe image](a.png) one.\n![TODO: describe image](b.png) two.",
    ],
  ])("fills the placeholder and keeps following prose (%s)", (_name, line, expectedLine) => {
    const rules = [ruleMissingAltText];
    const doc = `Intro.\n\n${line}\nTail.\n`;
    const fixed = applyAllFixes(doc, lintDocument(doc, { rules }));

    expect(fixed).toBe(`Intro.\n\n${expectedLine}\nTail.\n`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

// ─── 2. Rule: invalid-link-target ────────────────────────────────────────────

describe("rule:invalid-link-target", () => {
  it("passes on valid links", () => {
    const doc = "See [docs](https://example.com) and [local](./file.md).\n";
    expect(lintDocument(doc, { rules: [ruleInvalidLinkTarget] })).toHaveLength(0);
  });

  it("fills an empty link destination with TODO and preserves the surrounding prose", () => {
    const doc = "Before the link, read [the guide]() carefully, then continue.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(1);
    expect(applyAllFixes(doc, violations)).toBe(
      "Before the link, read [the guide](TODO) carefully, then continue.\n",
    );
  });

  it("replaces a whitespace-only link destination and preserves surrounding text", () => {
    const doc = "Before, read [the guide]( \t ) carefully; then continue.\r\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(applyFix(doc, violations[0])).toBe(
      "Before, read [the guide](TODO) carefully; then continue.\r\n",
    );
  });

  it("reports no invalid-link-target diagnostic for titled, angle-bracket and reference links", () => {
    const doc = [
      '[titled](./guide.md "Guide")',
      "[angle](<./my guide.md>)",
      "[ref][guide]",
      "",
      "[guide]: https://example.com/guide",
      "",
    ].join("\n");
    // Full default rule set: no diagnostic of this rule may appear.
    const ids = lintDocument(doc).map((v) => v.ruleId);
    expect(ids).not.toContain("invalid-link-target");
    expect(lintDocument(doc, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it.each([
    "https://example.com/guide?topic=lint#links",
    "./guide.md",
    "#section",
    "mailto:team@example.com",
  ])("control: autofix leaves a link with nonempty destination %j unchanged", (destination) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `---${nl}title: Guide${nl}---${nl}${nl}Read [guide](${destination}) today.${nl}`;
      const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

      expect(violations).toEqual([]);
      expect(applyAllFixes(doc, violations)).toBe(doc);
      // The full default rule set must not rewrite the destination either.
      expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
    }
  });

  it.each([
    ["bare filename", "Setup Guide", "setup.md"],
    ["subdirectory path", "API reference", "docs/api/index.md"],
    ["parent traversal", "Changelog", "../CHANGELOG.md"],
    ["percent-encoded space", "My notes", "notes/my%20notes.md"],
    ["trailing slash directory", "Docs home", "./docs/"],
  ])("preserves a valid relative link's href and text exactly (%s)", (_name, text, href) => {
    const link = `[${text}](${href})`;
    const doc = `# Links\n\nSee ${link} for details.\n`;
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toEqual([]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(doc);
    expect(fixed).toContain(link);
    // The full default rule set must not rewrite the href or the text either.
    expect(applyAllFixes(doc, lintDocument(doc))).toContain(link);
  });

  it.each([
    ["relative path with fragment", "Install", "./guide.md#install"],
    ["relative path with query", "Search", "../search.md?q=lint"],
  ])("preserves a relative link with CRLF endings (%s)", (_name, text, href) => {
    const link = `[${text}](${href})`;
    const doc = `# Links\r\n\r\nSee ${link} for details.\r\n`;

    expect(lintDocument(doc, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
    expect(applyAllFixes(doc, lintDocument(doc))).toContain(link);
  });

  it("preserves a valid fragment link [section](#section) alongside its target heading", () => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `---${nl}title: Guide${nl}---${nl}${nl}# Guide${nl}${nl}Jump to [section](#section) first.${nl}${nl}## Section${nl}${nl}Body text.${nl}`;
      const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

      expect(violations).toEqual([]);
      expect(applyAllFixes(doc, violations)).toBe(doc);
      expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
    }
  });

  it("leaves a [section](#section) link unchanged while autofix repairs an unrelated violation", () => {
    const link = "[section](#section)";
    const doc = `# Guide\n\nJump to ${link} first.   \n\n## Section\n\nBody.\n`;
    const violations = lintDocument(doc, {
      rules: [ruleNoTrailingSpaces, ruleInvalidLinkTarget],
    });

    expect(violations.map((v) => v.ruleId)).toEqual(["no-trailing-spaces"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(doc.replace("first.   ", "first."));
    expect(fixed).toContain(link);
  });

  it.each([
    ["no matching heading in the document", "#nowhere"],
    ["underscores and digits", "#step_2-of-3"],
    ["raw Unicode", "#einführung-概要"],
    ["percent-encoded characters", "#caf%C3%A9"],
    ["a single character", "#a"],
  ])("leaves a link to a nonempty fragment unchanged (%s)", (_name, fragment) => {
    for (const nl of ["\n", "\r\n"]) {
      const link = `[jump](${fragment})`;
      const doc = `Intro text.${nl}${nl}See ${link} for more.${nl}`;
      const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

      expect(violations).toEqual([]);
      expect(applyAllFixes(doc, violations)).toBe(doc);
      expect(applyAllFixes(doc, lintDocument(doc))).toContain(link);
    }
  });

  it.each([
    "./guide.md#install-steps",
    "../docs/guide.md?view=full#install-steps",
    "https://example.com/docs/guide#install-steps",
    "#install-steps",
  ])("preserves the link and fragment %j exactly while fixing a sibling empty link", (destination) => {
    for (const nl of ["\n", "\r\n"]) {
      const valid = `[install](${destination})`;
      const doc = `Start at ${valid}, then fix [broken]().${nl}`;
      const expected = `Start at ${valid}, then fix [broken](TODO).${nl}`;
      const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

      // Only the empty link is reported; the fragment link is never touched.
      expect(violations).toHaveLength(1);
      expect(applyAllFixes(doc, violations)).toBe(expected);
      expect(applyAllFixes(doc, violations)).toContain(valid);
      // A valid-only document is a fixed point under the full default rule set.
      const clean = `---${nl}title: Guide${nl}---${nl}${nl}Start at ${valid} today.${nl}`;
      expect(lintDocument(clean, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
      expect(applyAllFixes(clean, lintDocument(clean))).toBe(clean);
    }
  });

  it.each([
    ["a title", '[install](./guide.md#install-steps "Install steps")'],
    ["an angle-bracket destination", "[install](<./my guide.md#install steps>)"],
    ["emphasis in the text", "[**install** _now_](./guide.md#install-steps)"],
    ["a query before the fragment", "[install](./guide.md?v=2#install-steps)"],
  ])("leaves a valid fragment link with %s byte-identical under autofix", (_name, link) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `# Guide${nl}${nl}Start: ${link}${nl}${nl}Then [broken]() and trailing   ${nl}`;
      const fixed = applyAllFixes(doc, lintDocument(doc));

      expect(fixed).toContain(link);
      expect(fixed).toContain("[broken](TODO)");
      // The valid link also survives a second autofix pass.
      expect(applyAllFixes(fixed, lintDocument(fixed))).toContain(link);
    }
  });

  describe("preserves valid mailto links", () => {
    it.each([
      ["plain address", "[contact](mailto:team@example.com)"],
      ["with subject", "[help](mailto:support@example.com?subject=Help)"],
      [
        "with body and cc",
        "[reply](mailto:author@example.com?subject=Feedback&body=Great%20article&cc=editor@example.com)",
      ],
    ])("autofix leaves %s mailto link unchanged", (_name, link) => {
      for (const nl of ["\n", "\r\n"]) {
        const doc = `---${nl}title: Contact${nl}---${nl}${nl}Email ${link} for details.${nl}`;
        const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
        expect(violations).toEqual([]);
        expect(applyAllFixes(doc, violations)).toBe(doc);
        expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
      }
    });

    it("leaves mailto links and their surrounding text unchanged in lists, quotes and repeats", () => {
      const doc = [
        "---",
        "title: Contact",
        "---",
        "",
        "Ask [sales](mailto:sales@example.com) or [support](mailto:support@example.com?subject=Hi), thanks.",
        "",
        "- Mail [me](MAILTO:me@example.com) today (really).",
        "> **Note:** write to [the team](mailto:team@example.com) _soon_.",
        "",
      ].join("\n");
      const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
      expect(violations).toEqual([]);
      expect(applyAllFixes(doc, violations)).toBe(doc);
      expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
    });
  });

  it.each([
    "Guide: setup, usage & tips!",
    'What\'s new? (v2.0) - see "notes"; ok...',
    "100% done @ home #1 *yes* ~maybe~ <b>",
  ])("autofix leaves a valid link with punctuation in its label %j unchanged", (label) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `---${nl}title: Guide${nl}---${nl}${nl}Read [${label}](./guide.md) today.${nl}`;
      const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

      expect(violations).toEqual([]);
      expect(applyAllFixes(doc, violations)).toBe(doc);
      expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
    }
  });

  it.each([
    ["CJK and emoji", "日本語ガイド 🧭", "./guides/intro.md"],
    ["RTL scripts", "مرحبا بالعالم — שלום", "https://example.com/welcome?lang=ar#top"],
    ["decomposed accents", "cafe\u0301 re\u0301sume\u0301", "#overview"],
    ["ZWJ emoji family", "👩🏽‍💻 family 👨‍👩‍👧‍👦", "mailto:team@example.com"],
    ["mixed scripts", "Руководство · मार्गदर्शिका", "<./my guide.md>"],
  ])("autofix leaves a valid link with Unicode text unchanged (%s)", (_name, label, href) => {
    for (const nl of ["\n", "\r\n"]) {
      const link = `[${label}](${href})`;
      const doc = `---${nl}title: Guide${nl}---${nl}${nl}Read ${link} today.${nl}`;
      const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

      expect(violations).toEqual([]);
      expect(applyAllFixes(doc, violations)).toBe(doc);
      // The full default rule set must not rewrite the link or its text either.
      expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
    }
  });

  it("fixes a neighboring empty link without touching a valid link with Unicode text", () => {
    for (const nl of ["\n", "\r\n"]) {
      const link = "[日本語ガイド 🧭](./guides/intro.md)";
      const doc = `---${nl}title: Guide${nl}---${nl}${nl}Read ${link} then [broken]() now.${nl}`;
      const expected = `---${nl}title: Guide${nl}---${nl}${nl}Read ${link} then [broken](TODO) now.${nl}`;
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // The Unicode link occupies the same span after the fix, byte for byte.
      expect(fixed.indexOf(link)).toBe(doc.indexOf(link));
      expect(lintDocument(fixed)).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed))).toBe(expected);
    }
  });

  it.each([
    ["Cyrillic", "Руководство"],
    ["Greek with accents", "Οδηγός χρήσης"],
    ["Devanagari and Thai", "मार्गदर्शिका คู่มือ"],
    ["decomposed (NFD) accents", "cafe\u0301 re\u0301sume\u0301"],
  ])("replaces a whitespace-only href with TODO and keeps a Unicode label byte-for-byte (%s)", (_name, label) => {
    const doc = `Intro.\n\nOpen [${label}](  ) now, then [ok](./a.md).\n`;
    const expected = `Intro.\n\nOpen [${label}](TODO) now, then [ok](./a.md).\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`[${label}](  )`);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["emoji", "Ship it 🚀👩‍💻"],
    ["parentheses and entity", "Guide (v2) &amp; notes"],
    ["underscores and angle text", "snake_case <b>bold</b> *x*"],
  ])("replaces a whitespace-only href with TODO and keeps a label with %s unchanged", (_name, label) => {
    const doc = `Status: [${label}](  \t ) and [ok](./a.md).\n`;
    const expected = `Status: [${label}](TODO) and [ok](./a.md).\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("mixed valid and invalid links: autofix rewrites only the invalid destinations", () => {
    const doc =
      "[docs](./docs.md) and [empty]() then [web](https://example.com/a?b=1#c) and [hash](#) and [anchor](#top).\n";
    const expected =
      "[docs](./docs.md) and [empty](TODO) then [web](https://example.com/a?b=1#c) and [hash](TODO) and [anchor](#top).\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(
      violations.map((v) => doc.slice(v.range!.from.offset, v.range!.to.offset)),
    ).toEqual(["[empty]()", "[hash](#)"]);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["both empty", "", ""],
    ["fragment and query markers", "#", "?"],
    ["whitespace-only hrefs", "  ", "\t "],
    ["one empty, one marker", "", "#"],
  ])("fixes two invalid links in one paragraph and keeps every other byte (%s)", (_name, first, second) => {
    for (const nl of ["\n", "\r\n"]) {
      // Two soft-wrapped lines with no blank line between them are one
      // paragraph; the invalid links sit on separate lines of it.
      const paragraph = [
        `Opening clause cites [first](${first}) for background,`,
        `then points at [second](${second}) for the details — done.`,
      ];
      const doc = [
        "Leading paragraph stays.",
        "",
        ...paragraph,
        "",
        "Closing paragraph stays.",
        "",
      ].join(nl);
      const expected = [
        "Leading paragraph stays.",
        "",
        "Opening clause cites [first](TODO) for background,",
        "then points at [second](TODO) for the details — done.",
        "",
        "Closing paragraph stays.",
        "",
      ].join(nl);
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations.map((v) => v.ruleId)).toEqual([
        "invalid-link-target",
        "invalid-link-target",
      ]);
      expect(
        violations.map((v) => doc.slice(v.range!.from.offset, v.range!.to.offset)),
      ).toEqual([`[first](${first})`, `[second](${second})`]);
      // Each fix repairs only its own destination.
      expect(applyFix(doc, violations[0])).toBe(
        doc.replace(`[first](${first})`, "[first](TODO)"),
      );
      expect(applyFix(doc, violations[1])).toBe(
        doc.replace(`[second](${second})`, "[second](TODO)"),
      );
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
      // Both destinations became TODO.
      expect(fixed).toContain("[first](TODO)");
      expect(fixed).toContain("[second](TODO)");
      // Everything outside the two link spans is byte-identical.
      const outside = (s: string, spans: string[]) =>
        spans
          .map((span) => [s.indexOf(span), s.indexOf(span) + span.length])
          .sort((a, b) => b[0] - a[0])
          .reduce((acc, [from, to]) => acc.slice(0, from) + acc.slice(to), s);
      expect(outside(fixed, ["[first](TODO)", "[second](TODO)"])).toBe(
        outside(doc, [`[first](${first})`, `[second](${second})`]),
      );
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it.each([
    [
      "valid first",
      '[good](./good.md "Good title")[bad]() end.\n',
      '[good](./good.md "Good title")[bad](TODO) end.\n',
      "[bad]()",
    ],
    [
      "invalid first",
      '[bad]()[good](https://example.com/a?b=1#c "T") end.\n',
      '[bad](TODO)[good](https://example.com/a?b=1#c "T") end.\n',
      "[bad]()",
    ],
  ])("adjacent valid and invalid links (%s): replaces only the invalid destination", (_name, doc, expected, invalid) => {
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe(invalid);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \t "],
    ["bare fragment", "#"],
    ["bare query", "?"],
  ])("valid link next to an invalid link: only the %s destination changes", (_name, destination) => {
    const valid = '[guide](./guide.md "Guide")';
    const invalid = `[draft](${destination})`;
    const repaired = "[draft](TODO)";
    const rules = [ruleInvalidLinkTarget];

    for (const nl of ["\n", "\r\n"]) {
      // "Next to" in both geometries: touching, and across a soft line break.
      for (const separator of ["", nl]) {
        for (const validFirst of [true, false]) {
          const links = validFirst ? [valid, invalid] : [invalid, valid];
          const doc = `See ${links.join(separator)} end.${nl}`;
          const expected = `See ${(validFirst ? [valid, repaired] : [repaired, valid]).join(separator)} end.${nl}`;
          const violations = lintDocument(doc, { rules });

          // Only the invalid link is reported, spanning exactly that link.
          expect(violations).toHaveLength(1);
          expect(violations[0].ruleId).toBe("invalid-link-target");
          const { from, to } = violations[0].range!;
          expect(doc.slice(from.offset, to.offset)).toBe(invalid);

          expect(applyFix(doc, violations[0])).toBe(expected);
          const fixed = applyAllFixes(doc, violations);
          expect(fixed).toBe(expected);
          // Every byte outside the invalid link's span is unchanged.
          expect(
            fixed.slice(0, from.offset) + fixed.slice(from.offset + repaired.length),
          ).toBe(doc.slice(0, from.offset) + doc.slice(to.offset));
          expect(lintDocument(fixed, { rules })).toEqual([]);
        }
      }
    }
  });

  it.each([
    ".",
    ",",
    ";",
    ":",
    "!",
    "?",
    ")",
    "...",
    ".)",
    "?!",
    "—",
    "。",
  ])("invalid link followed by punctuation %j: destination becomes TODO and the punctuation is unchanged", (punct) => {
    for (const target of ["", "  ", "#"]) {
      for (const nl of ["\n", "\r\n"]) {
        const link = `[broken](${target})`;
        const doc = `See ${link}${punct} Next line.${nl}`;
        const expected = `See [broken](TODO)${punct} Next line.${nl}`;
        const rules = [ruleInvalidLinkTarget];
        const violations = lintDocument(doc, { rules });

        expect(violations).toHaveLength(1);
        expect(
          doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
        ).toBe(link);
        expect(applyFix(doc, violations[0])).toBe(expected);
        expect(applyAllFixes(doc, violations)).toBe(expected);
        expect(lintDocument(expected, { rules })).toEqual([]);
      }
    }
  });

  it.each([
    ".",
    ",",
    "?!",
    "。",
  ])("preserves terminal punctuation %j after an invalid link without a final newline", (punct) => {
    const doc = `Read [draft](#)${punct}`;
    const expected = `Read [draft](TODO)${punct}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["parentheses", "(", ")"],
    ["straight double quotes", '"', '"'],
    ["straight single quotes", "'", "'"],
    ["curly single quotes", "‘", "’"],
    ["guillemets", "«", "»"],
    ["single guillemets", "‹", "›"],
    ["low-high quotes", "„", "“"],
    ["em dashes", "—", "—"],
    ["asterisk emphasis", "*", "*"],
    ["inverted marks", "¡", "!"],
  ])("invalid link wrapped in %s: destination becomes TODO and the punctuation around it is unchanged", (_name, open, close) => {
    for (const target of ["", "  ", "#", "?"]) {
      for (const nl of ["\n", "\r\n"]) {
        const link = `[draft](${target})`;
        const doc = `See ${open}${link}${close} next.${nl}`;
        const expected = `See ${open}[draft](TODO)${close} next.${nl}`;
        const rules = [ruleInvalidLinkTarget];
        const violations = lintDocument(doc, { rules });

        expect(violations).toHaveLength(1);
        expect(violations[0].ruleId).toBe("invalid-link-target");
        const { from, to } = violations[0].range!;
        expect(doc.slice(from.offset, to.offset)).toBe(link);
        expect(applyFix(doc, violations[0])).toBe(expected);
        const fixed = applyAllFixes(doc, violations);
        expect(fixed).toBe(expected);
        expect(fixed).toContain(`${open}[draft](TODO)${close}`);
        expect(lintDocument(fixed, { rules })).toEqual([]);
      }
    }
  });

  it("inserts the TODO placeholder without changing sentence punctuation abutting the link", () => {
    for (const nl of ["\n", "\r\n"]) {
      // A sentence-final "." and a "," touch the link's brackets with no
      // space — not a matched open/close pair — so the fix may only rewrite
      // the href bytes between the parentheses.
      const doc = `Next.[draft](), then [ok](./ok.md); end.${nl}`;
      const expected = `Next.[draft](TODO), then [ok](./ok.md); end.${nl}`;
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      const { from, to } = violations[0].range!;
      // The reported range covers the link only, not the abutting punctuation.
      expect(doc.slice(from.offset, to.offset)).toBe("[draft]()");
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // Undoing the placeholder restores the input byte-for-byte, so no
      // punctuation was added, removed or moved.
      expect(fixed.replaceAll("(TODO)", "()")).toBe(doc);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it("preserves bracketed prose beside an invalid link while repairing only the link", () => {
    const doc =
      "Note [see below] and [sic] stay as written, but [broken]() is fixed; also [1] and [ ] remain.\n";
    const expected =
      "Note [see below] and [sic] stay as written, but [broken](TODO) is fixed; also [1] and [ ] remain.\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe("[broken]()");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    for (const prose of ["[see below]", "[sic]", "[1]", "[ ]"])
      expect(fixed).toContain(prose);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    [
      "before the link",
      "As shown in [1], see [broken]() for details.",
      "As shown in [1], see [broken](TODO) for details.",
    ],
    [
      "after the link",
      "See [broken]() for details, as in [1].",
      "See [broken](TODO) for details, as in [1].",
    ],
    [
      "both sides",
      "Prior work [1] cites [broken]() and [1] again.",
      "Prior work [1] cites [broken](TODO) and [1] again.",
    ],
    ["adjacent to the link", "Refs [1][broken]() end.", "Refs [1][broken](TODO) end."],
  ])("repairs the invalid link and keeps a bracketed number [1] verbatim (%s)", (_name, line, expectedLine) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `${line}${nl}`;
      const expected = `${expectedLine}${nl}`;
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(applyFix(doc, violations[0])).toBe(expected);
      expect(fixed.split("[1]")).toHaveLength(doc.split("[1]").length);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it("fixes only the invalid link when [1] is prose beside it and also the link's own label", () => {
    for (const nl of ["\n", "\r\n"]) {
      // [1] shows up three ways: a prose citation, a citation in a list, and
      // the label of an invalid link — only the link may change.
      const doc = [
        "Prior work [1] shows the pattern; see [draft](#) for ours.",
        "- compare [1] against [ref](?), [gap](  ) and [1]() inline",
        "ends with [1].",
        "",
      ].join(nl);
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(4);
      expect(
        violations.map((v) => doc.slice(v.range!.from.offset, v.range!.to.offset)),
      ).toEqual(["[draft](#)", "[ref](?)", "[gap](  )", "[1]()"]);
      expect(applyFix(doc, violations[3])).toBe(doc.replace("[1]()", "[1](TODO)"));

      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(
        [
          "Prior work [1] shows the pattern; see [draft](TODO) for ours.",
          "- compare [1] against [ref](TODO), [gap](TODO) and [1](TODO) inline",
          "ends with [1].",
          "",
        ].join(nl),
      );
      // Three bare "[1]" citations survive; the only "[1](" is the repair.
      expect(fixed.match(/\[1\](?!\()/g)).toHaveLength(3);
      expect(fixed.match(/\[1\]\(TODO\)/g)).toHaveLength(1);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it("keeps [1] prose and a [draft]() literal in the frontmatter while repairing the same link in the body", () => {
    for (const nl of ["\n", "\r\n"]) {
      // Frontmatter lines are masked whole, so their "[1]" strings — and even
      // a "[draft]()" literal — are property text there, not links. Only the
      // body's copy of that same link is a violation, and only it is fixed.
      const frontmatter = [
        "---",
        'title: "Study [1] notes"',
        'refs: ["[1]", "[2]"]',
        'draft: "[draft]() placeholder"',
        "---",
      ];
      const doc = [
        ...frontmatter,
        "",
        "Prior work [1] agrees; see [draft]() for ours.",
        "",
      ].join(nl);
      const expected = [
        ...frontmatter,
        "",
        "Prior work [1] agrees; see [draft](TODO) for ours.",
        "",
      ].join(nl);
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
      expect(violations[0].range!.from.offset).toBe(doc.lastIndexOf("[draft]()"));
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // Two "[draft]()" literals went in; the frontmatter one survives.
      expect(doc.match(/\[draft\]\(\)/g)).toHaveLength(2);
      expect(fixed.match(/\[draft\]\(\)/g)).toHaveLength(1);
      expect(fixed.match(/\[draft\]\(TODO\)/g)).toHaveLength(1);
      expect(fixed.match(/\[1\]/g)).toHaveLength(3);
      // The full default rule set flags only the body's link too.
      expect(applyAllFixes(doc, lintDocument(doc))).toBe(expected);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it("replaces an invalid href while preserving punctuation and surrounding text", () => {
    const doc =
      'Read it (see [guide]()), "[quote]()"; then [next](), — done! Really [end]()?\n';
    const expected =
      'Read it (see [guide](TODO)), "[quote](TODO)"; then [next](TODO), — done! Really [end](TODO)?\n';
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(4);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Only the empty href changed: stripping the placeholder restores the input.
    expect(fixed.replaceAll("(TODO)", "()")).toBe(doc);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("gives every invalid href its own TODO placeholder across several lines and keeps all surrounding text (%s)", (_name, nl) => {
    const doc = [
      "# Links",
      "",
      "First [one]() and second [two](#) on a line, **bold [three](  )** done.",
      "",
      "- item with [four](?) and trailing text",
      "> quote [five]() end",
      "",
    ].join(nl);
    const expected = [
      "# Links",
      "",
      "First [one](TODO) and second [two](TODO) on a line, **bold [three](TODO)** done.",
      "",
      "- item with [four](TODO) and trailing text",
      "> quote [five](TODO) end",
      "",
    ].join(nl);
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(5);
    expect(violations.every((v) => v.ruleId === "invalid-link-target")).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/\]\(TODO\)/g)).toHaveLength(5);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes an invalid href in a CRLF document without changing its line endings", () => {
    const doc = "# Title\r\n\r\nSee [guide]() now.\r\n\r\nLast line.\r\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("# Title\r\n\r\nSee [guide](TODO) now.\r\n\r\nLast line.\r\n");
    // Every newline is still CRLF: no bare LF or CR appeared, and the count is unchanged.
    expect(fixed.match(/\r\n/g)).toHaveLength(5);
    expect(fixed.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("replaces each of two invalid destinations with TODO and preserves both link labels", () => {
    const doc = "Read [First Guide]() and [Second *Guide*](#) today.\n";
    const expected = "Read [First Guide](TODO) and [Second *Guide*](TODO) today.\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("[First Guide]");
    expect(fixed).toContain("[Second *Guide*]");
    expect(fixed.match(/\]\(TODO\)/g)).toHaveLength(2);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("applyFix on the single invalid link in a list and table row leaves the valid links beside it untouched", () => {
    const doc =
      "- [good](./good.md)\n- [bad]()\n\n| a | b |\n| - | - |\n| [ok](https://example.com) | [bad2](?) |\n";
    const expected =
      "- [good](./good.md)\n- [bad](TODO)\n\n| a | b |\n| - | - |\n| [ok](https://example.com) | [bad2](?) |\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(2);
    // Applying just the first fix changes only that href.
    expect(applyFix(doc, violations[0])).toBe(expected);
    // Applying both fixes also leaves both valid links byte-for-byte intact.
    const all = applyAllFixes(doc, violations);
    expect(all).toContain("[good](./good.md)");
    expect(all).toContain("[ok](https://example.com)");
    expect(all).toContain("[bad2](TODO)");
    expect(lintDocument(all, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("preserves valid links and surrounding text when the document has no violations with %j line endings", (nl) => {
    const doc = [
      "---",
      "title: Getting Started",
      "---",
      "",
      "# Getting Started",
      "",
      "Welcome to the guide. Visit [the docs](./guide.md?view=full) or jump to #quick-start.",
      "",
      "## Quick start",
      "",
      "Run `mdopener init` then read the [reference](./reference.md). Questions? Email us at [support](mailto:support@example.com).",
      "",
      "That's everything.",
      "",
    ].join(nl);
    // Linting with the full default rule set reports no violations.
    const violations = lintDocument(doc);
    expect(violations).toEqual([]);
    // applyAllFixes with zero violations returns the document byte-for-byte identical.
    expect(applyAllFixes(doc, violations)).toBe(doc);
    // Same result through the full lint-and-fix pipeline.
    expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("leaves the complete input unchanged for a lone valid link with no other findings (%s)", (_name, nl) => {
    const doc = `---${nl}title: Links${nl}---${nl}${nl}# Links${nl}${nl}See [the guide](./guide.md) for details.${nl}`;
    const violations = lintDocument(doc);

    // No finding from any default rule, so there is nothing to fix.
    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
    expect(
      applyAllFixes(doc, lintDocument(doc, { rules: [ruleInvalidLinkTarget] })),
    ).toBe(doc);
    // Repeated autofix stays stable.
    expect(applyAllFixes(applyAllFixes(doc, violations), lintDocument(doc))).toBe(doc);
  });

  it("leaves the complete input unchanged for a bare valid link line without a trailing newline", () => {
    const doc = "[guide](https://example.com/guide)";

    expect(lintDocument(doc, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
    expect(
      applyAllFixes(doc, lintDocument(doc, { rules: [ruleInvalidLinkTarget] })),
    ).toBe(doc);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("leaves a valid link in a document without a final newline unchanged under every default rule (%s)", (_name, nl) => {
    const doc = `---${nl}title: Guide${nl}---${nl}${nl}# Guide${nl}${nl}Read [the guide](./guide.md#intro) now`;

    for (const violations of [
      lintDocument(doc),
      lintDocument(doc, { rules: [ruleInvalidLinkTarget] }),
    ]) {
      expect(applyAllFixes(doc, violations)).toBe(doc);
    }
    // No final newline is added, and a second pass is stable.
    expect(applyAllFixes(doc, lintDocument(doc)).endsWith("now")).toBe(true);
    expect(lintDocument(doc, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it("leaves a valid link byte-identical when autofix repairs another violation on the same line", () => {
    const link = "[guide](https://example.com/a_(b)?q=1#top)";
    const doc = `See ${link} and **[bold](./bold.md)** here.   \n`;
    const violations = lintDocument(doc, {
      rules: [ruleNoTrailingSpaces, ruleInvalidLinkTarget],
    });

    expect(violations.map((v) => v.ruleId)).toEqual(["no-trailing-spaces"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`See ${link} and **[bold](./bold.md)** here.\n`);
    expect(fixed).not.toContain("TODO");
  });

  it("autofix leaves a valid image-wrapping link and its surrounding text unchanged", () => {
    const link = "[![Build status](./badge.svg)](https://example.com/ci)";
    const doc = `---\ntitle: Project\n---\n\n# Project\n\nBefore ${link} after, with *emphasis*.\n`;
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
    expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
  });

  it("autofix leaves an HTTPS image and its surrounding text unchanged", () => {
    const image =
      '![Architecture diagram](https://example.com/img/arch_(v2).png?w=640&dpi=2#top "Architecture")';
    const doc = `---\ntitle: Project\n---\n\n# Project\n\nBefore ${image} after, with *emphasis* and [local](./local.md).\n`;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
    expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
  });

  it.each([
    ["titled link", 'Read [the guide](./guide.md "Guide title") first.'],
    ["fragment-only link", "Jump to [setup](#setup) first."],
    ["link with angle-bracket href", "Read [the guide](<./my guide.md>) first."],
    ["reference-style link", "Read [the guide][g] first.\n\n[g]: ./guide.md"],
    ["autolink", "Visit <https://example.com/guide> first."],
  ])("autofix leaves a valid %s and its surrounding prose unchanged", (_name, body) => {
    const doc = `---\ntitle: Intro\n---\n\n# Intro\n\nBefore text. ${body} After text.\n`;
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
    expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
  });

  it("preserves a valid fragment-only link and surrounding prose under autofix", () => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `---${nl}title: Setup${nl}---${nl}${nl}# Setup${nl}${nl}Before the [setup steps](#setup) begin. Read the [quick start](#quick-start) too.${nl}${nl}## Setup${nl}${nl}Follow these instructions.${nl}${nl}## Quick Start${nl}${nl}Get up and running.${nl}`;
      const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

      // No violations -- fragment-only links are valid targets.
      expect(violations).toEqual([]);
      // applyAllFixes with empty violations returns the unchanged document.
      expect(applyAllFixes(doc, violations)).toBe(doc);
      // Full default rule set: document is a fixed point, prose is untouched.
      expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
    }
  });

  it("preserves a link with empty text and a valid destination, and changes no surrounding text", () => {
    const doc =
      "---\ntitle: Links\n---\n\n# Links\n\nBefore [](https://example.com/page) and [named](docs/guide.md) after.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
    expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
  });

  it.each([
    [
      "an IPv4 host, port and userinfo",
      "https://ops@192.168.1.20:8443/releases/v2.4?channel=stable#notes",
    ],
    ["raw Unicode path segments", "https://example.com/guides/日本語/入門#概要"],
    [
      "a subdomain chain and deep path",
      "https://docs.api.eu-west-1.example.com/v3/reference/endpoints/list",
    ],
  ])("autofix leaves a valid HTTPS link with %s and its surrounding text unchanged", (_name, href) => {
    for (const nl of ["\n", "\r\n"]) {
      const link = `[status](${href})`;
      const doc = [
        "---",
        "title: Status",
        "---",
        "",
        "# Status",
        "",
        `Check ${link} before deploying; outages are rare.`,
        "",
        `- On-call reads ${link} daily.`,
        `> **Note:** ${link} refreshes hourly.`,
        "",
      ].join(nl);
      const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

      expect(violations).toEqual([]);
      expect(applyAllFixes(doc, violations)).toBe(doc);
      // The full default rule set must not rewrite the link or the prose either.
      expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
    }
  });

  it("replaces an invalid href at offset 0 of the document with TODO and preserves the following prose", () => {
    const doc =
      "[start link]() opens the doc, then **prose** and [ok](./a.md) follow.\n";
    const expected =
      "[start link](TODO) opens the doc, then **prose** and [ok](./a.md) follow.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(from.offset).toBe(0);
    expect(doc.slice(from.offset, to.offset)).toBe("[start link]()");
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the TODO placeholder for a punctuated-label link that opens the document and keeps the label and later paragraphs (%s)", (_name, nl) => {
    const rest = ["", "Second paragraph with **bold** and [ok](./a.md).", "- item", ""];
    const doc = ["[Start here, now: 1]()", ...rest].join(nl);
    const expected = ["[Start here, now: 1](TODO)", ...rest].join(nl);
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(violations[0].range!.from.offset).toBe(0);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(
      applyAllFixes(fixed, lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })),
    ).toBe(fixed);
  });

  it.each([
    ["lone #", "#"],
    ["lone ?", "?"],
    ["whitespace only", "   "],
    ["tab only", "\t"],
  ])("replaces a %s href at document start with TODO and preserves the following text", (_name, href) => {
    const tail = " then *emphasis* and [ok](./a.md) follow.\n";
    const doc = `[first](${href})${tail}`;
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(1);
    expect(violations[0].range!.from.offset).toBe(0);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`[first](TODO)${tail}`);
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("turns an empty href at offset 0 into TODO and keeps the following prose, hard break and tabs exactly (%s)", (_name, nl) => {
    const tail = [
      " opens the file, then *emphasis*  ",
      "\tindented\ttext with café — “quotes”; <b>html</b> &amp; [ref]: not a def.",
      "",
    ].join(nl);
    const doc = `[start]()${tail}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const { from, to } = violations[0].range!;
    expect(from.offset).toBe(0);
    expect(doc.slice(from.offset, to.offset)).toBe("[start]()");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`[start](TODO)${tail}`);
    expect(fixed.slice("[start](TODO)".length)).toBe(tail);
    expect(applyFix(doc, violations[0])).toBe(fixed);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes only the start-of-document link with applyFix and leaves a later invalid link and inline code for the next pass", () => {
    const doc = "[head]() then `[code]()` and [later](#) end.\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations[0].range!.from.offset).toBe(0);

    const once = applyFix(doc, violations[0]);
    expect(once).toBe("[head](TODO) then `[code]()` and [later](#) end.\n");
    expect(lintDocument(once, { rules })).toHaveLength(1);
    expect(applyAllFixes(doc, violations)).toBe(
      "[head](TODO) then `[code]()` and [later](TODO) end.\n",
    );
  });

  it("inserts the TODO placeholder when the whole document is one invalid link with no trailing newline", () => {
    const doc = "[only link]()";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(1);
    expect(applyAllFixes(doc, violations)).toBe("[only link](TODO)");
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("replaces the invalid href when the whole document is one invalid link and keeps the single final newline (%s)", (_name, nl) => {
    const doc = `[only link]()${nl}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`[only link](TODO)${nl}`);
    expect(applyFix(doc, violations[0])).toBe(fixed);
    expect(fixed.endsWith(nl)).toBe(true);
    expect(fixed.endsWith(`${nl}${nl}`)).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("replaces an invalid href at column 1 of a later line with TODO and keeps the following text unchanged (%s)", (_name, nl) => {
    const before = "Intro line with a [valid](./ok.md) link.";
    const tail = " then *emphasis*, `code` and [ok](./a.md) follow.";
    const doc = [before, "", `[line start]()${tail}`, "Next line.", ""].join(nl);
    const expected = [before, "", `[line start](TODO)${tail}`, "Next line.", ""].join(
      nl,
    );
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const { from, to } = violations[0].range!;
    expect(from.line).toBe(3);
    expect(from.col).toBe(0);
    expect(doc.slice(from.offset, to.offset)).toBe("[line start]()");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.split(nl)[2].endsWith(tail)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("replaces an invalid href that starts a paragraph with TODO and preserves the prose that follows, including the wrapped line (%s)", (_name, nl) => {
    const first = "First paragraph ends with a [valid](./ok.md) link.";
    const doc = [
      first,
      "",
      "[Paragraph opener]() continues with *emphasis*, `code` and a [web](https://example.com/a?b=1) link,",
      "then a wrapped line with café — punctuation; and more.",
      "",
      "Closing paragraph is untouched.",
      "",
    ].join(nl);
    const expected = doc.replace("[Paragraph opener]()", "[Paragraph opener](TODO)");
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const { from, to } = violations[0].range!;
    expect(from.line).toBe(3);
    expect(from.col).toBe(0);
    expect(doc.slice(from.offset, to.offset)).toBe("[Paragraph opener]()");
    // The character before the link is the blank-line break, i.e. a paragraph start.
    expect(doc.slice(0, from.offset).endsWith(`${nl}${nl}`)).toBe(true);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyFix(doc, violations[0])).toBe(expected);
    // Everything after the rewritten href is byte-for-byte the original prose.
    expect(fixed.slice(from.offset + "[Paragraph opener](TODO)".length)).toBe(
      doc.slice(to.offset),
    );
    expect(fixed.startsWith(`${first}${nl}${nl}`)).toBe(true);
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it.each([
    "-",
    "*",
    "+",
  ])("replaces an invalid destination in an unordered list item with TODO and keeps the %s marker", (marker) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = `${marker} first\n${marker} [broken link]()\n${marker} [ok](./a.md)\n`;
    const expected = `${marker} first\n${marker} [broken link](TODO)\n${marker} [ok](./a.md)\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    [
      "-",
      "- [ ] See [spec]() for details, then [ok](./ok.md) done.",
      "- [ ] See [spec](TODO) for details, then [ok](./ok.md) done.",
    ],
    ["*", "* Before [spec]( ) after", "* Before [spec](TODO) after"],
    ["+", "+ [spec]()", "+ [spec](TODO)"],
  ])("sets the href to TODO in a one-item unordered list (marker %s) and keeps the marker, checkbox and text before and after", (_marker, line, expectedLine) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = `Intro\n\n${line}\n\nOutro\n`;
    const expected = `Intro\n\n${expectedLine}\n\nOutro\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["-", "\n"],
    ["*", "\r\n"],
    ["+", "\n"],
  ])("replaces lone # and ? destinations in a nested unordered list (marker %s) and keeps indentation, markers and text (line ending %j)", (marker, nl) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = [
      `${marker} Top [one](#) text`,
      `  ${marker} Child [two](?) text, [ok](./ok.md)`,
      `    ${marker} Grandchild plain`,
      "",
    ].join(nl);
    const expected = [
      `${marker} Top [one](TODO) text`,
      `  ${marker} Child [two](TODO) text, [ok](./ok.md)`,
      `    ${marker} Grandchild plain`,
      "",
    ].join(nl);
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["blockquote", "> Quote [a b](  ) end\n", "> Quote [a b](TODO) end\n", "[a b](  )"],
    [
      "table cell",
      "| h |\n|---|\n| [a b](  ) |\n",
      "| h |\n|---|\n| [a b](TODO) |\n",
      "[a b](  )",
    ],
    [
      "newline inside the parentheses",
      "See [a b](\n) x\n",
      "See [a b](TODO) x\n",
      "[a b](\n)",
    ],
  ])("inserts the TODO destination for a whitespace-only href in a %s and keeps the label", (_name, doc, expected, slice) => {
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(slice);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the TODO placeholder for an empty href inside a multi-line nested blockquote and keeps every quote prefix and the surrounding text (%s)", (_name, nl) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = [
      "> Intro with [ok](./a.md) link.",
      "> Quote **bold** then [broken link]() and `code` after.",
      ">> Nested [other](#) tail.",
      "> End.",
      "",
    ].join(nl);
    const expected = [
      "> Intro with [ok](./a.md) link.",
      "> Quote **bold** then [broken link](TODO) and `code` after.",
      ">> Nested [other](TODO) tail.",
      "> End.",
      "",
    ].join(nl);
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe("[broken link]()");
    // A single fix touches only its own link; the other stays for the next pass.
    expect(applyFix(doc, violations[0])).toBe(
      doc.replace("[broken link]()", "[broken link](TODO)"),
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    for (const line of fixed.split(nl).slice(0, 4))
      expect(line.startsWith(">")).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("replaces a whitespace-only href with TODO while preserving the link text", () => {
    const doc =
      "---\ntitle: Guide\n---\n\nRead [café guide](   ) and [reference](./guide.md).\n";
    const expected =
      "---\ntitle: Guide\n---\n\nRead [café guide](TODO) and [reference](./guide.md).\n";
    const violations = lintDocument(doc);

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[café guide](   )");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected)).toEqual([]);
  });

  it("replaces a whitespace-only destination with TODO and keeps a label that has emphasis and punctuation", () => {
    const label = "the **bold** and _italic_ guide, v2";
    const doc = `Read [${label}](  \t ) now, then [ok](./a.md).\n`;
    const expected = `Read [${label}](TODO) now, then [ok](./a.md).\n`;
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`[${label}]`);
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it("replaces a whitespace-only destination with TODO and preserves the surrounding prose", () => {
    const before = "As the guide explains, see";
    const after = "for the full setup steps; the rest is unchanged.";
    const doc = `${before} [the walkthrough](   ) ${after}\n`;
    const expected = `${before} [the walkthrough](TODO) ${after}\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[the walkthrough](   )");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(before);
    expect(fixed).toContain(after);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("replaces every kind of invalid destination (empty, lone # and lone ?) with TODO and keeps the labels in order", () => {
    const doc = "Go [alpha]() then [beta](#) then [gamma](?) done.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(3);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("Go [alpha](TODO) then [beta](TODO) then [gamma](TODO) done.\n");
    expect([...fixed.matchAll(/\[(\w+)\]/g)].map((m) => m[1])).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it("turns both hrefs into TODO when a document has exactly two invalid links and leaves the link text intact", () => {
    const doc = "Read [first guide]() and then [second guide](#) today.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Read [first guide](TODO) and then [second guide](TODO) today.\n",
    );
    expect(fixed).toContain("[first guide]");
    expect(fixed).toContain("[second guide]");
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it("rewrites an invalid link that sits alone between two paragraphs to TODO and keeps both paragraphs intact", () => {
    const before = "First paragraph, with *emphasis* and a [valid](./ok.md) link.";
    const after = "Last paragraph stays exactly as written.";
    const doc = `${before}\n\nSee [broken target]().\n\n${after}\n`;
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`${before}\n\nSee [broken target](TODO).\n\n${after}\n`);
    expect(fixed).toContain(before);
    expect(fixed).toContain(after);
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts TODO for an invalid link that is the last thing in a paragraph and keeps the prose before it (%s)", (_name, nl) => {
    const prose = `First line of the paragraph with *emphasis* and a [valid](./ok.md) link,${nl}then more words before the broken one: `;
    const next = "Next paragraph stays exactly as written.";
    const doc = `${prose}[broken target]()${nl}${nl}${next}${nl}`;
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`${prose}[broken target](TODO)${nl}${nl}${next}${nl}`);
    expect(fixed.startsWith(prose)).toBe(true);
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it("sets the href to TODO for a paragraph-ending invalid link in a mid-document paragraph and preserves the prose before and after it", () => {
    const lead = "Intro paragraph with a [valid](./ok.md) link.\n\n";
    const prose =
      "Second paragraph: **bold** words, `code`, and finally see [the guide]";
    const tail = "\n\nThird paragraph is untouched.";
    const doc = `${lead}${prose}( )${tail}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`${lead}${prose}(TODO)${tail}`);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes the destination of an invalid link in the second paragraph and leaves the first paragraph byte-for-byte unchanged (%j)", (nl) => {
    const first = `First paragraph with a [valid](./ok.md) link,${nl}wrapped over two lines.`;
    const second = `Second paragraph, see [the guide](`;
    const doc = `${first}${nl}${nl}${second}  ) now.${nl}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`${first}${nl}${nl}${second}TODO) now.${nl}`);
    expect(fixed.startsWith(`${first}${nl}${nl}`)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("gives two invalid links in one document a TODO href each and keeps both labels", () => {
    const fm = "---\ntitle: Guide\n---\n\n";
    const doc = `${fm}See [first label]() and [second label](  ) for details.\n`;
    const expected = `${fm}See [first label](TODO) and [second label](TODO) for details.\n`;
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.ruleId === "invalid-link-target")).toBe(true);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected)).toEqual([]);
  });

  it("rewrites two invalid links in separate paragraphs to TODO and keeps all surrounding prose intact", () => {
    const intro = "Intro with a [valid](./ok.md) link and `code`.";
    const middle = "Middle paragraph, untouched, with **bold** words.";
    const outro = "Closing words stay exactly as written.";
    const doc = `${intro}\n\nFirst: [alpha guide]() here.\n\n${middle}\n\nSecond: [beta guide](  ) there.\n\n${outro}\n`;
    const expected = `${intro}\n\nFirst: [alpha guide](TODO) here.\n\n${middle}\n\nSecond: [beta guide](TODO) there.\n\n${outro}\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    for (const prose of [intro, middle, outro]) expect(fixed).toContain(prose);
    // Fixing one at a time (re-linting between) reaches the same result.
    const stepwise = applyFix(doc, violations[0]);
    expect(applyFix(stepwise, lintDocument(stepwise, { rules })[0])).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("replaces both invalid hrefs in a blockquote and keeps both labels, with no trailing newline", () => {
    const doc = "> [alpha *one*]()\n> [beta **two**](?)";
    const expected = "> [alpha *one*](TODO)\n> [beta **two**](TODO)";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("[alpha *one*]");
    expect(fixed).toContain("[beta **two**]");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("keeps a valid link unchanged and turns the invalid href into TODO when both share one line", () => {
    const valid = '[docs](https://example.com/docs "Docs")';
    const doc = `Read ${valid}, then [broken]() and [more](./more.md).\n`;
    const expected = `Read ${valid}, then [broken](TODO) and [more](./more.md).\n`;
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(1);
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe("[broken]()");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(valid);
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("replaces the invalid href on a line between two unaffected lines and preserves both neighbors (%s)", (_name, nl) => {
    const before = "Line before has *emphasis* and a [valid](./ok.md) link.";
    const after = "Line after has `code` and trailing text.";
    const doc = [before, "Read [guide](  ) here.", after, ""].join(nl);
    const expected = [before, "Read [guide](TODO) here.", after, ""].join(nl);
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(violations[0].range!.from.line).toBe(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.split(nl)[0]).toBe(before);
    expect(fixed.split(nl)[2]).toBe(after);
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it("fixes two invalid hrefs on separate lines around a valid link and leaves all surrounding text unchanged", () => {
    const doc =
      "# Notes\n\nFirst, read [alpha]() before *anything* else.\n\nThen [kept](./kept.md) stays.\n\nLast, open [beta](   ) and `code` too.\n";
    const expected =
      "# Notes\n\nFirst, read [alpha](TODO) before *anything* else.\n\nThen [kept](./kept.md) stays.\n\nLast, open [beta](TODO) and `code` too.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.ruleId === "invalid-link-target")).toBe(true);
    const slices = violations.map((v) =>
      doc.slice(v.range!.from.offset, v.range!.to.offset),
    );
    expect(slices).toEqual(["[alpha]()", "[beta](   )"]);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    // Each fix alone touches only its own link.
    expect(applyFix(doc, violations[0])).toBe(
      doc.replace("[alpha]()", "[alpha](TODO)"),
    );
    expect(applyFix(doc, violations[1])).toBe(
      doc.replace("[beta](   )", "[beta](TODO)"),
    );
    expect(lintDocument(expected, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("is idempotent: applying the invalid-link fix twice yields the same complete output as once (%s)", (_name, nl) => {
    const doc = [
      "# Notes",
      "",
      "First, read [alpha]() before *anything* else.",
      "Then [kept](./kept.md) stays.",
      "Last, open [beta](   ) and `code` too.",
      "",
    ].join(nl);
    const expected = [
      "# Notes",
      "",
      "First, read [alpha](TODO) before *anything* else.",
      "Then [kept](./kept.md) stays.",
      "Last, open [beta](TODO) and `code` too.",
      "",
    ].join(nl);
    const opts = { rules: [ruleInvalidLinkTarget] };
    const fixOnce = (text: string) => applyAllFixes(text, lintDocument(text, opts));

    const once = fixOnce(doc);
    const twice = fixOnce(once);

    expect(once).toBe(expected);
    expect(twice).toBe(once);
    expect(lintDocument(once, opts)).toEqual([]);
  });

  it("a second autofix leaves the first result unchanged for empty, lone # and lone ? destinations", () => {
    const doc = "Go [alpha]() then [beta](#) then [gamma](?) and [ok](./ok.md).\n";
    const opts = { rules: [ruleInvalidLinkTarget] };
    const fixOnce = (text: string) => applyAllFixes(text, lintDocument(text, opts));

    const first = fixOnce(doc);
    expect(first).toBe(
      "Go [alpha](TODO) then [beta](TODO) then [gamma](TODO) and [ok](./ok.md).\n",
    );
    // The second pass finds nothing to report and returns the first result byte for byte.
    expect(lintDocument(first, opts)).toEqual([]);
    expect(fixOnce(first)).toBe(first);
  });

  it.each([
    ["-"],
    ["*"],
    ["+"],
    ["  -"],
    ["1."],
  ])("gives the invalid href in a list item with marker %j a TODO destination and keeps the marker and surrounding text", (marker) => {
    const doc = `Intro line.\n${marker} Before [the guide](  ) after, see [ok](./ok.md).\n${marker} Next item.\n`;
    const expected = `Intro line.\n${marker} Before [the guide](TODO) after, see [ok](./ok.md).\n${marker} Next item.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(fixed).toContain(`${marker} Before [the guide](TODO) after,`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["single", ">", " "],
    ["nested", "> >", " "],
    ["no space", ">", ""],
  ])("gives the invalid href in a blockquote (%s) a TODO destination and keeps the marker and label", (_name, marker, sep) => {
    const doc = `Intro.\n${marker}${sep}See [the guide](  ) now, and [ok](./ok.md).\n${marker}${sep}Next line.\n`;
    const expected = `Intro.\n${marker}${sep}See [the guide](TODO) now, and [ok](./ok.md).\n${marker}${sep}Next line.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(fixed).toContain(`${marker}${sep}See [the guide](TODO)`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes two invalid hrefs inside list items and emphasis, keeping markers, nesting and a valid neighbour intact", () => {
    const doc =
      "- **[bold one]()** then [ok](./ok.md)\n- _see [second](  )_ and done\n";
    const expected =
      "- **[bold one](TODO)** then [ok](./ok.md)\n- _see [second](TODO)_ and done\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.ruleId === "invalid-link-target")).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("[ok](./ok.md)");
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it("replaces only the invalid destination inside multi-sentence prose and leaves the surrounding text untouched", () => {
    const before =
      "Intro with *emphasis*, a `code span` and a [bracketed note] that is not a link. Then see ";
    const after =
      " (really!) — thanks; see you soon.\n\nSecond paragraph stays exactly as written.\n";
    const doc = `${before}[the guide]()${after}`;
    const expected = `${before}[the guide](TODO)${after}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[the guide]()");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Prose on both sides of the link is byte-for-byte identical.
    expect(fixed.startsWith(before)).toBe(true);
    expect(fixed.endsWith(after)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["ellipsis", "..."],
    ["interrobang", "?!"],
    ["closing quote and period", '".'],
    ["closing paren, colon and dash", "): —"],
    ["unicode ellipsis", "…"],
  ])("replaces an invalid href with TODO and keeps stacked trailing punctuation (%s)", (_name, punctuation) => {
    const doc = `Is it [ready]()${punctuation} Yes, see [done](./done.md).\n`;
    const expected = `Is it [ready](TODO)${punctuation} Yes, see [done](./done.md).\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    // The reported range stops at the closing paren, excluding the punctuation.
    expect(doc.slice(from.offset, to.offset)).toBe("[ready]()");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`(TODO)${punctuation} Yes`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["CJK, combining mark and ZWJ emoji", "日本語ガイド café 👩🏽‍💻"],
    ["right-to-left script", "دليل المستخدم"],
  ])("replaces an empty href with TODO and keeps a Unicode label byte-for-byte (%s)", (_name, label) => {
    const doc = `---\ntitle: Guide\n---\n\nSee [${label}]() and [reference](./guide.md).\n`;
    const expected = `---\ntitle: Guide\n---\n\nSee [${label}](TODO) and [reference](./guide.md).\n`;
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`[${label}]()`);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected)).toEqual([]);
  });

  it.each([
    ["=== underline", "==="],
    ["--- underline", "---"],
  ])("replaces an empty href in a setext heading (%s) with TODO and keeps the heading text and underline", (_name, underline) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `Intro.${nl}${nl}See [the guide]() now${nl}${underline}${nl}${nl}Body [ok](./a.md).${nl}`;
      const expected = `Intro.${nl}${nl}See [the guide](TODO) now${nl}${underline}${nl}${nl}Body [ok](./a.md).${nl}`;
      const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

      expect(violations).toHaveLength(1);
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe("[the guide]()");
      expect(applyAllFixes(doc, violations)).toBe(expected);
      expect(lintDocument(expected, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
    }
  });

  it.each([
    ["Korean and Hebrew", "안내서 מדריך"],
    ["astral math letters", "𝐆𝐮𝐢𝐝𝐞 𝟏"],
    ["fullwidth brackets and CJK punctuation", "【ガイド】（初級）"],
    ["precomposed and decomposed forms side by side", "é é ß İ"],
  ])("fixes an invalid link whose label is Unicode (%s) after astral characters and before a second invalid link", (_name, label) => {
    const lead = "😀 𝄞 ";
    const doc = `${lead}[${label}]() then [Ünï second]( ) end.\n`;
    const expected = `${lead}[${label}](TODO) then [Ünï second](TODO) end.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.ruleId === "invalid-link-target")).toBe(true);
    // Offsets stay correct after surrogate pairs earlier on the line.
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`[${label}]()`);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`[${label}](TODO)`);
    expect(fixed.normalize("NFC")).toBe(expected.normalize("NFC"));
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("mixed valid and invalid links: autofix changes only the invalid href and keeps every valid link (%j)", (nl) => {
    const valid = [
      "[docs](https://example.com/guide?topic=lint#links)",
      "[local](./file.md)",
      '[titled](./guide.md "Guide")',
      "[angle](<./my guide.md>)",
      "[anchor](#section)",
      "[ref][guide]",
    ];
    const [v0, v1, v2, v3, v4, v5] = valid;
    const before = `Start ${v0}, ${v1}, ${v2}.${nl}${nl}`;
    const middle = `Then ${v3} and `;
    const after = ` plus ${v4} and ${v5}.${nl}${nl}[guide]: https://example.com/guide${nl}`;
    const doc = `${before}${middle}[broken label](   )${after}`;
    const expected = `${before}${middle}[broken label](TODO)${after}`;

    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    // Only the invalid link is reported, and its range covers just that link.
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[broken label](   )");

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyFix(doc, violations[0])).toBe(expected);
    for (const link of valid) expect(fixed).toContain(link);
    // The result is clean and stable under the link rule.
    expect(lintDocument(expected, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it.each([
    "\f",
    "\v",
    " \f\v ",
  ])("replaces a form-feed or vertical-tab-only href %j with TODO while preserving the link text", (href) => {
    const doc = `Read [café guide](${href}) and [reference](./guide.md).\n`;
    const expected = "Read [café guide](TODO) and [reference](./guide.md).\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`[café guide](${href})`);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    "\t",
    "\t\t",
  ])("replaces a tab-only href %j with TODO while preserving the link text", (href) => {
    const doc = `---\ntitle: Guide\n---\n\nRead [café guide](${href}) and [reference](./guide.md).\n`;
    const expected =
      "---\ntitle: Guide\n---\n\nRead [café guide](TODO) and [reference](./guide.md).\n";
    const violations = lintDocument(doc);

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`[café guide](${href})`);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected)).toEqual([]);
  });

  it.each([
    " ",
    "　 ",
    "  \t ",
    "\n  ",
  ])("replaces a Unicode or line-breaking whitespace-only href %j with TODO and keeps the prose", (href) => {
    const doc = `---\ntitle: Guide\n---\n\nIntro café.\n\nRead [café guide](${href}) and [reference](./guide.md).\n`;
    const expected =
      "---\ntitle: Guide\n---\n\nIntro café.\n\nRead [café guide](TODO) and [reference](./guide.md).\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(1);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`[café guide](${href})`);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected)).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("is idempotent: applying the invalid-link autofix twice equals applying it once (%j)", (nl) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = [
      "Read [a]() and [b](   ) and [c](#) and [d](?) here.",
      "Keep [ok](./guide.md) and `[code]()`.",
    ].join(nl);
    const violations = lintDocument(doc, { rules });
    expect(violations.length).toBeGreaterThan(0);

    const once = applyAllFixes(doc, violations);
    expect(once).not.toBe(doc);
    const secondViolations = lintDocument(once, { rules });
    expect(secondViolations).toEqual([]);
    const twice = applyAllFixes(once, secondViolations);
    expect(twice).toBe(once);
    // Re-applying the stale first-pass violations must not corrupt the text either.
    expect(lintDocument(twice, { rules })).toEqual([]);
  });

  it.each([
    " ",
    "　 ",
    "\n  ",
    "#",
    "?",
  ])("is idempotent for a single invalid href %j: the fixed link lints clean and re-fixing is a no-op", (href) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = `Intro café.\n\nRead [guide](${href}) now.\n`;
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);

    const once = applyFix(doc, violations[0]);
    expect(once).toBe("Intro café.\n\nRead [guide](TODO) now.\n");
    expect(lintDocument(once, { rules })).toEqual([]);
    expect(applyAllFixes(once, [])).toBe(once);
    expect(applyAllFixes(once, lintDocument(once, { rules }))).toBe(once);
  });

  it.each([
    "\n",
    "\r\n",
  ])("is idempotent for invalid links in a full document with frontmatter and every default rule (%j)", (nl) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = [
      "---",
      "title: Guide",
      "---",
      "",
      'Read [café *guide*]( ) and [ref [nested]](#) then [ok](./guide.md "Title").',
      "",
      "- item [x](?)",
      "- item [y](<./a b.md>)",
      "",
    ].join(nl);

    // Fix-all converges: a second pass over the first result changes nothing.
    const once = applyAllFixes(doc, lintDocument(doc, { rules }));
    expect(once).not.toBe(doc);
    expect(lintDocument(once, { rules })).toEqual([]);
    expect(applyAllFixes(once, lintDocument(once, { rules }))).toBe(once);

    // Running the full default rule set twice also reaches a fixed point.
    const fullOnce = applyAllFixes(doc, lintDocument(doc));
    const fullTwice = applyAllFixes(fullOnce, lintDocument(fullOnce));
    expect(fullTwice).toBe(fullOnce);

    // Fixing one violation at a time (re-linting between fixes) ends at the same text.
    let stepwise = doc;
    for (let i = 0; i < 10; i++) {
      const [first] = lintDocument(stepwise, { rules });
      if (!first) break;
      stepwise = applyFix(stepwise, first);
    }
    expect(stepwise).toBe(once);
  });

  it("fixes an invalid link immediately before a CRLF line ending", () => {
    const doc = "Opening.\r\nRead [draft]()\r\nNext line.\r\n";
    const expected = "Opening.\r\nRead [draft](TODO)\r\nNext line.\r\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("replaces a whitespace-only href at offset 0 and keeps the remaining %s text byte-identical", (_name, nl) => {
    const rest = ` is the first word of this café note.${nl}${nl}See [ref](./ref.md) and \`[draft](   )\`.${nl}`;
    const doc = `[draft](   )${rest}`;
    const expected = `[draft](TODO)${rest}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(violations[0].range?.from.offset).toBe(0);
    expect(doc.slice(0, violations[0].range!.to.offset)).toBe("[draft](   )");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith(rest)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    [
      "empty",
      "[start]() then more text.\n\n## Next\n\n- item [ok](./a.md)\n",
      "[start](TODO) then more text.\n\n## Next\n\n- item [ok](./a.md)\n",
    ],
    [
      "spaces",
      "[start](  )\nSecond line stays.\n",
      "[start](TODO)\nSecond line stays.\n",
    ],
    ["no trailing text", "[start]()", "[start](TODO)"],
  ])("produces the exact fixed document for an invalid link at the very start (%s)", (_name, doc, expected) => {
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].range?.from.offset).toBe(0);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    "",
    "#",
    "?",
  ])("fixes an invalid href %j at the start while preserving a matching code example", (href) => {
    const suffix = ` continues with café and  spacing.\r\n\r\nExample: \`[draft](${href})\`.`;
    const doc = `[draft](${href})${suffix}`;
    const expected = `[draft](TODO)${suffix}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].range?.from.offset).toBe(0);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["mixed", "\n\r\n"],
  ])("preserves blank lines and line breaks around a fixed link with %s endings", (_name, nl) => {
    const doc = `Intro line.${nl}${nl}${nl}Read [draft]() now.${nl}Next line.${nl}${nl}End.${nl}`;
    const expected = doc.replace("[draft]()", "[draft](TODO)");
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.split(/\r\n|\n/)).toHaveLength(doc.split(/\r\n|\n/).length);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "> ",
    ">",
    "> > ",
  ])("fixes a link inside a blockquote (prefix %j) keeping the prefix and label", (prefix) => {
    const doc = `Before.\n\n${prefix}Read [draft]() before publishing.\n${prefix}Next line.\n`;
    const expected = `Before.\n\n${prefix}Read [draft](TODO) before publishing.\n${prefix}Next line.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`${prefix}Read [draft](TODO)`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "-",
    "2.",
  ])("fixes a link within %s list text without changing the surrounding content", (marker) => {
    const doc = `- First item\n${marker} Read [draft]() before publishing.\n- Last item\n`;
    const expected = `- First item\n${marker} Read [draft](TODO) before publishing.\n- Last item\n`;
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

  it.each([
    ["paren-style ordered", "3)", ""],
    ["two-digit ordered", "12)", " "],
    ["checked task", "- [x]", "#"],
  ])("fixes an invalid link in a %s list item and keeps the %j marker intact (invalid href %j)", (_name, marker, href) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `Intro.${nl}${nl}${marker} Read [draft](${href}) today.${nl}${nl}Outro.${nl}`;
      const expected = `Intro.${nl}${nl}${marker} Read [draft](TODO) today.${nl}${nl}Outro.${nl}`;
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      expect(violations[0].fix).not.toBeNull();
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(`[draft](${href})`);
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // The marker keeps its own line and is byte-for-byte intact after the fix.
      expect(fixed).toContain(`${nl}${marker} Read [draft](TODO) today.${nl}`);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes a nested task-list link while preserving its context with %j line endings", (newline) => {
    const doc = [
      "---",
      "title: Release",
      "---",
      "",
      "- Release checklist",
      "  - [ ] Read [draft](?) before [guide](./guide.md); example: `[draft](?)`.",
      "  - [x] Keep this item.",
      "",
    ].join(newline);
    const expected = [
      "---",
      "title: Release",
      "---",
      "",
      "- Release checklist",
      "  - [ ] Read [draft](TODO) before [guide](./guide.md); example: `[draft](?)`.",
      "  - [x] Keep this item.",
      "",
    ].join(newline);
    const violations = lintDocument(doc);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[draft](?)");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed);
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "",
    " ",
    "#",
    "?",
  ])("fixes two identical invalid hrefs %j on one line without changing the text between them", (href) => {
    const doc = `Before [draft](${href}) — \`[example]()\`  café\t& then [draft](${href}) after.\r\n`;
    const expected =
      "Before [draft](TODO) — `[example]()`  café\t& then [draft](TODO) after.\r\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["\n", "\r\n"],
    ["\r\n", "\n"],
  ])("fixes two links on separate lines while preserving mixed line endings %j and %j", (firstBreak, secondBreak) => {
    const doc =
      `Before [first]() — café.${firstBreak}` +
      "Keep  [guide](./guide.md) and `[example](#)`." +
      secondBreak +
      "After [second](?)\tend.";
    const expected =
      `Before [first](TODO) — café.${firstBreak}` +
      "Keep  [guide](./guide.md) and `[example](#)`." +
      secondBreak +
      "After [second](TODO)\tend.";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(
      doc.replace("[first]()", "[first](TODO)"),
    );
    expect(applyFix(doc, violations[1])).toBe(
      doc.replace("[second](?)", "[second](TODO)"),
    );
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("fixes invalid links in different paragraphs of a multi-line document without touching the lines between them", () => {
    const between =
      "\n\nMiddle paragraph with *emphasis*, a [valid](./ok.md) link,\n" +
      "and a fenced block:\n\n```md\n[sample]()\n```\n\n## Heading  \n\n";
    const doc = `First [alpha]( ) line\ncontinues here.${between}Last [beta](#) line.\n`;
    const expected = `First [alpha](TODO) line\ncontinues here.${between}Last [beta](TODO) line.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.map((violation) => violation.range!.from.line)).toEqual([1, 13]);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("fixes an invalid link followed by a valid link", () => {
    const doc =
      "---\ntitle: Guide\n---\n\nRead [draft]() then [guide](https://example.com/guide).\n";
    const expected =
      "---\ntitle: Guide\n---\n\nRead [draft](TODO) then [guide](https://example.com/guide).\n";
    const violations = lintDocument(doc);

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed)).toEqual([]);
  });

  it("preserves bracketed prose like [sic] while replacing an invalid link destination with TODO", () => {
    const doc = "Intro.\n\nHe wrote teh [sic] guide, see [draft]() for more.\n";
    const expected =
      "Intro.\n\nHe wrote teh [sic] guide, see [draft](TODO) for more.\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("[sic]");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("preserves bracketed prose like [1] while replacing an invalid link destination with TODO (line endings %j)", (nl) => {
    const doc = `Results [1] show growth, see [draft]() and note [2].${nl}Also [1] again, [1].${nl}`;
    const expected = `Results [1] show growth, see [draft](TODO) and note [2].${nl}Also [1] again, [1].${nl}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/\[1\]/g)).toHaveLength(3);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("preserves a bracketed numeric citation [42] and its surrounding text exactly while fixing neighbors (line endings %j)", (nl) => {
    const doc = `As shown in prior work [42], see [draft]() and ![](fig.png) too.${nl}Cited again (see [42]); [42].${nl}`;
    const expected = `As shown in prior work [42], see [draft](TODO) and ![TODO: describe image](fig.png) too.${nl}Cited again (see [42]); [42].${nl}`;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/\[42\]/g)).toHaveLength(3);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("leaves a document containing only a [42] citation untouched", () => {
    const doc = "Claim [42].\n";
    expect(
      lintDocument(doc, { rules: [ruleInvalidLinkTarget, ruleMissingAltText] }),
    ).toEqual([]);
  });

  it.each([
    "https://example.com/a_(b)?q=1&r=2#frag",
    "mailto:team@example.com",
    "#install",
    "../docs/guide.md#top",
    '/guide "Quoted title"',
  ])("repairs an invalid link and preserves a valid link exactly (valid destination %j)", (destination) => {
    const valid = `[valid](${destination})`;
    const rules = [ruleInvalidLinkTarget];

    for (const validFirst of [true, false]) {
      const doc = validFirst
        ? `Intro ${valid}, then [broken]().\n`
        : `Intro [broken](), then ${valid}.\n`;
      const expected = validFirst
        ? `Intro ${valid}, then [broken](TODO).\n`
        : `Intro [broken](TODO), then ${valid}.\n`;
      const violations = lintDocument(doc, { rules });

      expect(violations.map((violation) => violation.ruleId)).toEqual([
        "invalid-link-target",
      ]);
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe("[broken]()");
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed).toContain(valid);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it.each([
    true,
    false,
  ])("fixes an adjacent invalid link without changing its valid namesake (valid first: %s)", (validFirst) => {
    const valid = '[guide](./guide.md?next=TODO#links "Guide")';
    const invalid = "[guide](?)";
    const links = validFirst ? [valid, invalid] : [invalid, valid];
    const repaired = validFirst ? [valid, "[guide](TODO)"] : ["[guide](TODO)", valid];
    const doc = `Read ${links.join("")} next.`;
    const expected = `Read ${repaired.join("")} next.`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(invalid);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "",
    "#",
    "?",
    " \t ",
  ])("fixes an invalid link next to a valid image in either order (destination %j)", (destination) => {
    const link = `[draft](${destination})`;
    const image = '![Café diagram](images/caf%C3%A9.png?size=2#preview "Diagram")';
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

    for (const imageFirst of [false, true]) {
      const doc = `See ${imageFirst ? image : link} ${imageFirst ? link : image}.\r\n`;
      const expected = `See ${imageFirst ? image : "[draft](TODO)"} ${imageFirst ? "[draft](TODO)" : image}.\r\n`;
      const violations = lintDocument(doc, { rules });

      expect(violations.map((violation) => violation.ruleId)).toEqual([
        "invalid-link-target",
      ]);
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(link);
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      const remaining = lintDocument(fixed, { rules });
      expect(remaining).toEqual([]);
      expect(applyAllFixes(fixed, remaining)).toBe(expected);
    }
  });

  it.each([
    [
      "touching, image first",
      "![Release chart](chart.png)[notes](#)",
      "![Release chart](chart.png)[notes](TODO)",
    ],
    [
      "touching, link first",
      "[notes](?)![Release chart](chart.png)",
      "[notes](TODO)![Release chart](chart.png)",
    ],
    [
      "angle-bracket image path with a title",
      '[notes]( ) ![Plan *v2*](<img/plan v2.png> "Plan")',
      '[notes](TODO) ![Plan *v2*](<img/plan v2.png> "Plan")',
    ],
  ])("replaces the invalid href and keeps the described image exactly (%s)", (_name, source, expected) => {
    const doc = `Intro café.\n\n${source}\n`;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`Intro café.\n\n${expected}\n`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("leaves a described HTTPS image and the prose around it unchanged with %j line endings", (newline) => {
    const image =
      '![Release chart](https://cdn.example.com/img/chart.png?size=2&v=1#top "Chart")';
    const doc = `Intro café.${newline}${newline}See the ${image} for *details*, then continue.${newline}`;

    for (const rules of [[ruleInvalidLinkTarget, ruleMissingAltText], BUILTIN_RULES]) {
      const violations = lintDocument(doc, { rules }).filter(
        (v) => v.ruleId === "invalid-link-target" || v.ruleId === "missing-alt-text",
      );
      expect(violations).toEqual([]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(doc);
    }
  });

  it.each([
    ["relative SVG with a bare fragment", "![Logo](assets/logo.svg#icon)"],
    ["fragment-only source", "![Figure one](#figure-1)"],
    ["angle-bracket source with a fragment", "![Spaced](<my images/a b.svg#part>)"],
    ["fragment and title", '![Chart](chart.png#top "Chart")'],
  ])("preserves a described image whose source has a fragment (%s)", (_name, image) => {
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    for (const newline of ["\n", "\r\n"]) {
      const doc = `Intro café.${newline}${newline}Before ${image} after.${newline}`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toEqual([]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(doc);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it("preserves a described image with an HTTPS source and its query, fragment and title", () => {
    const image =
      '![Release chart](https://cdn.example.com/img/chart.png?size=2&v=1#top "Chart")';
    const doc = `Intro café.\n\n${image}\n`;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toEqual([]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(doc);
    expect(fixed).toContain(image);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("changes only the link destination for an invalid link and valid image in one wrapped paragraph (%j)", (newline) => {
    const image =
      '![Café *diagram*](images/caf%C3%A9.png?size=2#preview "Diagram (v2)")';
    const prefix = `Intro café, then the ${image} and`;
    const middle = "see the [draft **notes**](";
    const suffix = `) before **done**.  ${newline}Next line stays.${newline}`;
    const doc = `${prefix}${newline}${middle}#${suffix}`;
    const expected = `${prefix}${newline}${middle}TODO${suffix}`;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[draft **notes**](#)");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Image, link text, trailing spaces and line endings are byte-identical.
    expect(fixed).toContain(image);
    expect(fixed.length - doc.length).toBe("TODO".length - "#".length);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    true,
    false,
  ])("fixes an invalid link beside an image missing alt text (image first: %s)", (imageFirst) => {
    const link = "[draft](?)";
    const image = "![](images/chart.png?view=full#data)";
    const repairedLink = "[draft](TODO)";
    const repairedImage = "![TODO: describe image](images/chart.png?view=full#data)";
    const doc = `Before café: ${imageFirst ? image + link : link + image}  after.\r\n`;
    const expected = `Before café: ${imageFirst ? repairedImage + repairedLink : repairedLink + repairedImage}  after.\r\n`;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["\n", [ruleInvalidLinkTarget, ruleMissingAltText]],
    ["\r\n", [ruleMissingAltText, ruleInvalidLinkTarget]],
  ])("applies both fixes in document order for an invalid link followed by an undescribed image (line ending %j)", (newline, rules) => {
    const doc = `Read [draft](#) then see ![](images/a b.png "T") today.${newline}`;
    const expected = `Read [draft](TODO) then see ![TODO: describe image](images/a b.png "T") today.${newline}`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations.map((violation) => violation.ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Link fix lands before the image fix, matching the original order.
    expect(fixed.indexOf("[draft](TODO)")).toBeLessThan(
      fixed.indexOf("![TODO: describe image]"),
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes only the undescribed image beside a described image (%j line endings)", (newline) => {
    const undescribed = '![](images/chart.png?view=full#top "Chart")';
    const described = '![Café diagram](<images/kept chart.svg> "Keep")';
    const repaired = '![TODO: describe image](images/chart.png?view=full#top "Chart")';
    const rules = [ruleMissingAltText];

    for (const undescribedFirst of [true, false]) {
      const images = undescribedFirst
        ? [undescribed, described]
        : [described, undescribed];
      const fixedImages = undescribedFirst
        ? [repaired, described]
        : [described, repaired];
      const doc = `Before ${images.join(" and ")} after.${newline}`;
      const violations = lintDocument(doc, { rules });

      expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(undescribed);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(`Before ${fixedImages.join(" and ")} after.${newline}`);
      expect(lintDocument(fixed, { rules })).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });

  it("fixes two adjacent undescribed images without changing either source", () => {
    const doc =
      'See ![](images/one.png?size=2#top)![  ](<images/two chart.svg> "Chart") here.\n';
    const expected =
      'See ![TODO: describe image](images/one.png?size=2#top)![TODO: describe image](<images/two chart.svg> "Chart") here.\n';
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    "\n",
    "\r\n",
  ])("gives every undescribed image the placeholder and keeps each source (line ending %j)", (newline) => {
    const doc = [
      "![](images/a.png)",
      'Mid ![](images/b c.png?v=2#top "T") and ![](https://example.com/d.svg) end.',
      "![described](images/keep.png)",
      "",
    ].join(newline);
    const expected = [
      "![TODO: describe image](images/a.png)",
      'Mid ![TODO: describe image](images/b c.png?v=2#top "T") and ![TODO: describe image](https://example.com/d.svg) end.',
      "![described](images/keep.png)",
      "",
    ].join(newline);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(3);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/!\[TODO: describe image\]/g)).toHaveLength(3);
    for (const source of [
      "images/a.png",
      "images/b c.png?v=2#top",
      "https://example.com/d.svg",
    ]) {
      expect(fixed).toContain(`(${source}`);
    }
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["a single space", " "],
    ["several spaces", "   "],
    ["a tab", "\t"],
    ["mixed spaces and tabs", " \t \t"],
    ["a non-breaking space", " "],
    ["an ideographic space", "　"],
  ])("replaces a whitespace-only image description (%s) with the placeholder and keeps the source", (_name, alt) => {
    const source = 'images/caf%C3%A9 diagram.png?size=2#preview "Diagram"';
    const doc = `Intro café.\r\n\r\nSee ![${alt}](${source}) now.\r\n`;
    const expected = `Intro café.\r\n\r\nSee ![TODO: describe image](${source}) now.\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`(${source})`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the placeholder for tab-only alt text, leaves tab-padded real alt text alone, and preserves surrounding tabs (%s)", (_name, nl) => {
    const rules = [ruleMissingAltText];
    const doc = [
      "See\t![\t](one.png)\ttail",
      '![\t\t\t](two.png "T")',
      "![\tkept\t](three.png)",
      "",
    ].join(nl);
    const expected = [
      "See\t![TODO: describe image](one.png)\ttail",
      '![TODO: describe image](two.png "T")',
      "![\tkept\t](three.png)",
      "",
    ].join(nl);
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(
      violations.every((v) => v.ruleId === "missing-alt-text" && v.fix !== null),
    ).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("replaces a whitespace-only image description inside a list item and keeps an angle-bracket source (%s)", (_name, nl) => {
    const rules = [ruleMissingAltText];
    const doc = `- ![  ](<my images/a b.png> "T")${nl}- ![kept](b.png)${nl}`;
    const expected = `- ![TODO: describe image](<my images/a b.png> "T")${nl}- ![kept](b.png)${nl}`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("is idempotent: a second autofix pass over undescribed images equals the first pass (line ending %j)", (newline) => {
    const doc = [
      "![](images/a.png)",
      'Mid ![ ](images/b c.png?v=2#top "T") and ![](https://example.com/d.svg) end.',
      "![described](images/keep.png)",
      "",
    ].join(newline);
    const rules = [ruleMissingAltText];

    const first = applyAllFixes(doc, lintDocument(doc, { rules }));
    expect(first.match(/!\[TODO: describe image\]/g)).toHaveLength(3);

    const secondViolations = lintDocument(first, { rules });
    expect(secondViolations).toEqual([]);
    expect(applyAllFixes(first, secondViolations)).toBe(first);
  });

  it.each([
    "\n",
    "\r\n",
  ])("preserves an absolute URL and surrounding text when fixing another link with %j line endings", (newline) => {
    const valid =
      '[café guide](https://example.com/a%20b?tag=one&tag=two&empty=#section "Guide title")';
    const prefix = ["---", "title: Guide", "---", ""].join(newline) + newline;
    const doc =
      prefix + [`Before ${valid} after.`, "Read [draft]() next."].join(newline);
    const expected =
      prefix + [`Before ${valid} after.`, "Read [draft](TODO) next."].join(newline);
    const violations = lintDocument(doc);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed)).toEqual([]);
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

  it.each([
    '"Guide title"',
    "'Guide title'",
    "(Guide title)",
  ])("preserves a valid link with title %s when autofixing its line", (title) => {
    const link = `[guide](./guide.md?view=full#links ${title})`;
    const doc = `Read ${link} for details.   \n`;
    const expected = `Read ${link} for details.\n`;
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
    expect(applyAllFixes(fixed, [])).toBe(expected);
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

  it.each([
    "\n",
    "\r\n",
  ])("preserves a reference link and its definition while fixing neighboring links with %j line endings", (newline) => {
    const doc = [
      "Read [draft]() before [the guide][guide-id] and [notes](#) after.",
      "",
      '[guide-id]: https://example.com/guide?view=full#links "Guide title"',
      "",
    ].join(newline);
    const expected = [
      "Read [draft](TODO) before [the guide][guide-id] and [notes](TODO) after.",
      "",
      '[guide-id]: https://example.com/guide?view=full#links "Guide title"',
      "",
    ].join(newline);
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

  it("fixes a live invalid link while preserving a valid link and a matching code example", () => {
    const doc =
      "Example: `[guide](?)`\n\nRead [guide](?) or [guide](./guide.md#links).\n";
    const expected =
      "Example: `[guide](?)`\n\nRead [guide](TODO) or [guide](./guide.md#links).\n";
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

  it.each([
    "\n",
    "\r\n",
  ])("fixes a later-line link without changing any other line with %j line endings", (newline) => {
    const lines = [
      "# Café guide",
      "",
      "```md",
      "[draft]()",
      "```",
      "",
      "Read [draft]() next.",
      "",
      "Keep  spacing and a tab:\t☕.",
      "",
    ];
    const doc = lines.join(newline);
    const expectedLines = [...lines];
    expectedLines[6] = "Read [draft](TODO) next.";
    const expected = expectedLines.join(newline);
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].range?.from.line).toBe(7);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes a later link while preserving mixed line endings and preceding content", () => {
    const prefix = "# Guide ☕\r\n\n```md\r\n[draft](?)\n```\r\n\n";
    const suffix = "\r\n\nKeep the final paragraph.\r\n";
    const doc = `${prefix}Read [draft](?) next.${suffix}`;
    const expected = `${prefix}Read [draft](TODO) next.${suffix}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].range?.from.line).toBe(7);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("fixes only the invalid destination %j regardless of link order", (destination) => {
    const valid = '[guide](./guide.md?view=full#links "Guide title")';
    const invalid = `[guide](${destination})`;
    const repaired = "[guide](TODO)";
    const rules = [ruleInvalidLinkTarget];

    for (const validFirst of [true, false]) {
      const doc = `Intro.\r\nRead ${validFirst ? valid : invalid} and ${validFirst ? invalid : valid}.\r\n`;
      const expected = `Intro.\r\nRead ${validFirst ? valid : repaired} and ${validFirst ? repaired : valid}.\r\n`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(invalid);
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      const remaining = lintDocument(fixed, { rules });
      expect(remaining).toEqual([]);
      expect(applyAllFixes(fixed, remaining)).toBe(expected);
    }
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
    ["", "."],
    ["   ", ","],
    ["#", ";"],
    ["?", "!"],
  ])("fixes an invalid href %j while preserving following punctuation %j", (href, punctuation) => {
    const doc = `Read [draft](${href})${punctuation} then continue.\n`;
    const expected = `Read [draft](TODO)${punctuation} then continue.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["café / cafe\u0301 — 日本語 👩🏽‍💻", ""],
    ["café / cafe\u0301 — 日本語 👩🏽‍💻", " \t "],
    ["café / cafe\u0301 — 日本語 👩🏽‍💻", "#"],
    ["café / cafe\u0301 — 日本語 👩🏽‍💻", "?"],
    ["مرحبا بالعالم — שלום 🌍", ""],
    ["مرحبا بالعالم — שלום 🌍", " \t "],
    ["مرحبا بالعالم — שלום 🌍", "#"],
    ["مرحبا بالعالم — שלום 🌍", "?"],
  ])("preserves the exact Unicode label %j when fixing destination %j", (label, href) => {
    const doc = `🌍 Read [${label}](${href}) beside [guide](./guide.md).\r\n`;
    const expected = `🌍 Read [${label}](TODO) beside [guide](./guide.md).\r\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`[${label}](${href})`);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "Привет, мир",
    "Καλημέρα κόσμε",
    "नमस्ते दुनिया",
    "สวัสดีชาวโลก",
    "한국어 안내서 🇰🇷",
  ])("keeps the %j label while replacing an empty href under the default rules", (label) => {
    const doc = `---\ntitle: Guide\n---\n\nSee [${label}]() for details.\n`;
    const expected = `---\ntitle: Guide\n---\n\nSee [${label}](TODO) for details.\n`;
    const violations = lintDocument(doc);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected)).toEqual([]);
  });

  it("preserves distinct Unicode normalization forms in neighboring invalid link labels", () => {
    const doc = "Read [café]() and [cafe\u0301](#) beside [guide](./guide.md).\r\n";
    const expected =
      "Read [café](TODO) and [cafe\u0301](TODO) beside [guide](./guide.md).\r\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(applyFix(doc, violations[0])).toBe(
      "Read [café](TODO) and [cafe\u0301](#) beside [guide](./guide.md).\r\n",
    );
    expect(applyFix(doc, violations[1])).toBe(
      "Read [café]() and [cafe\u0301](TODO) beside [guide](./guide.md).\r\n",
    );
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("fixes destination %j at the beginning without changing following content", (destination) => {
    for (const newline of ["\n", "\r\n"]) {
      const link = `[draft](${destination})`;
      const following = ` — read [guide](./guide.md#details).${newline}${newline}Keep café and  spacing.${newline}`;
      const doc = link + following;
      const expected = `[draft](TODO)${following}`;
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        ruleId: "invalid-link-target",
        range: { from: { offset: 0 }, to: { offset: link.length } },
      });
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      const remaining = lintDocument(fixed, { rules });
      expect(remaining).toEqual([]);
      expect(applyAllFixes(fixed, remaining)).toBe(expected);
    }
  });

  it.each([
    "",
    "\r\n",
  ])("preserves CRLF and surrounding document content when fixing an interior link (ending %j)", (ending) => {
    const doc =
      "# Café guide\r\n\r\nBefore [draft]() after.\r\n\r\n" +
      `Keep [published](./guide.md) and  spacing.\r\nLast line.${ending}`;
    const expected =
      "# Café guide\r\n\r\nBefore [draft](TODO) after.\r\n\r\n" +
      `Keep [published](./guide.md) and  spacing.\r\nLast line.${ending}`;
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

  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("preserves punctuation in the link label when fixing destination %j", (destination) => {
    const doc = `Read [What's new: v2.0 (draft), & next steps!](${destination}) today.\n`;
    const expected = "Read [What's new: v2.0 (draft), & next steps!](TODO) today.\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    "   ",
    "\t",
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
    "\u2003",
    "\u3000",
    " \u2003 ",
    " \n ",
    " \t\n\t ",
    " \r\n ",
  ])("replaces the whitespace-only destination %j with TODO, preserving the link text and surrounding prose", (destination) => {
    const doc = `Drafts: see [release notes](${destination}) before [the guide](./guide.md), then publish.\n`;
    const expected =
      "Drafts: see [release notes](TODO) before [the guide](./guide.md), then publish.\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: "invalid-link-target",
      severity: "warning",
      message: `Invalid link target: [release notes](${destination})`,
    });
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`[release notes](${destination})`);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
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

  it.each([
    "\n",
    "\r\n",
  ])("fixes each invalid link in a mixed document while preserving every valid link exactly (%j)", (newline) => {
    const validLocal = '[guide](./guide.md "Guide")';
    const validRemote = "[docs](https://example.com/a%20b?x=1#frag)";
    const doc = [
      "# Mixed",
      "",
      `See ${validLocal}, [a]() and ${validRemote} first.`,
      "Then [b](?) mid-line, `[sample](#)` in code, [ok](mailto:team@example.com).",
      "Last [c](#) stays.",
      "",
    ].join(newline);
    const expected = [
      "# Mixed",
      "",
      `See ${validLocal}, [a](TODO) and ${validRemote} first.`,
      "Then [b](TODO) mid-line, `[sample](#)` in code, [ok](mailto:team@example.com).",
      "Last [c](TODO) stays.",
      "",
    ].join(newline);
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(
      violations.map((violation) =>
        doc.slice(violation.range!.from.offset, violation.range!.to.offset),
      ),
    ).toEqual(["[a]()", "[b](?)", "[c](#)"]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(doc.replace("[a]()", "[a](TODO)"));
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(fixed).toContain(validLocal);
    expect(fixed).toContain(validRemote);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it("autofix preserves surrounding text", () => {
    const doc = "Before [link](#) after.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toBe("Before [link](TODO) after.\n");
  });

  it("fixes a link between unchanged Unicode prose", () => {
    const doc =
      "🚀 Before: keep  this text; read [draft guide](?) now. Keep  this text. 🌱\n";
    const expected =
      "🚀 Before: keep  this text; read [draft guide](TODO) now. Keep  this text. 🌱\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[draft guide](?)");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["", "\n"],
    ["#", "\r\n"],
    ["?", "\n"],
    [" \t ", "\r\n"],
  ])("fixes destination %j between unchanged Unicode prose with %j line endings", (href, newline) => {
    const prefix = "👩🏽‍💻 Café cafe\u0301 日本語: ";
    const suffix = " — مرحبا שלום 🌱 e\u0301";
    const link = `[draft guide](${href})`;
    const doc = `${prefix}${link}${suffix}${newline}`;
    const expected = `${prefix}[draft guide](TODO)${suffix}${newline}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(link);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["CJK", "日本語", "テキスト"],
    ["accented Latin", "café", "naïve"],
    ["decomposed-accent", "cafe\u0301", "re\u0301sume\u0301"],
    ["RTL scripts", "שלום", "مرحبا"],
    ["astral letters", "𠮷野", "字書"],
  ])("fixes an empty href on a link directly between two %s words and keeps both words byte-for-byte", (_name, before, after) => {
    for (const nl of ["\n", "\r\n"]) {
      const link = "[guide]()";
      const doc = `${before}${link}${after}${nl}`;
      const expected = `${before}[guide](TODO)${after}${nl}`;
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      // The reported range is the link alone, wedged between the two words:
      // it starts where the first word ends and stops where the second begins.
      const { from, to } = violations[0].range!;
      expect(from.offset).toBe(before.length);
      expect(to.offset).toBe(before.length + link.length);
      expect(doc.slice(from.offset, to.offset)).toBe(link);
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // The only edit is the placeholder inside the parentheses; taking it
      // back out restores the words and the empty href exactly.
      expect(fixed.replace("(TODO)", "()")).toBe(doc);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it.each([
    "\n",
    "\r\n",
  ])("preserves surrounding text and no final newline when fixing a link with %j line endings", (newline) => {
    const doc = `Opening paragraph.${newline}${newline}Before [draft]() after.`;
    const expected = `Opening paragraph.${newline}${newline}Before [draft](TODO) after.`;
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

  it("keeps the complete source URL, including its query string, when filling a missing description", () => {
    const src = "https://cdn.example.com:8443/img/chart.png?size=2&v=1&token=a-b_c";
    const doc = `![](${src})\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`![TODO: describe image](${src})\n`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["spaces", "   "],
    ["tab", "\t"],
    ["no-break space", " "],
  ])("replaces a whitespace-only description (%s) with the placeholder and keeps the image source", (_name, blank) => {
    const src = 'images/chart.png?size=2#data "Title"';
    const doc = `Before ![${blank}](${src}) after.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`Before ![TODO: describe image](${src}) after.\n`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["described image first", true],
    ["undescribed image first", false],
  ])("inserts the placeholder only for the undescribed image and keeps both sources (%s)", (_name, describedFirst) => {
    const described = '![Chart of sales](images/sales.png?size=2#top "Sales")';
    const undescribedSrc = "images/raw data.png?v=1";
    const undescribed = `![](<${undescribedSrc}>)`;
    const repaired = `![TODO: describe image](<${undescribedSrc}>)`;
    const [a, b] = describedFirst ? [described, undescribed] : [undescribed, described];
    const [expA, expB] = describedFirst ? [described, repaired] : [repaired, described];
    const doc = `Intro.\n\n${a} and ${b} end.\n`;
    const expected = `Intro.\n\n${expA} and ${expB} end.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.split("TODO: describe image")).toHaveLength(2);
    expect(fixed).toContain(described);
    expect(fixed).toContain(undescribedSrc);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("inserts the placeholder for an undescribed image without adding a final newline with %j line endings", (newline) => {
    const doc = `Opening paragraph.${newline}${newline}Before ![](images/chart.png) after.`;
    const expected = `Opening paragraph.${newline}${newline}Before ![TODO: describe image](images/chart.png) after.`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["single level", "> ", "images/chart.png"],
    ["nested levels", "> > ", "images/chart.png?v=2#top"],
    ["no space after marker", ">", "images/a%20b.png"],
    ["with a title", "> ", 'images/chart.png "Chart"'],
  ])("adds the description placeholder to an undescribed image in a blockquote and keeps the marker and destination (%s)", (_name, marker, dest) => {
    const doc = `Intro.\n\n${marker}See ![](${dest}) here.\n${marker}Second line.\n`;
    const expected = `Intro.\n\n${marker}See ![TODO: describe image](${dest}) here.\n${marker}Second line.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fills each undescribed image across the lines of one blockquote and leaves the described one alone with %j line endings", (newline) => {
    const described = "![Chart](images/ok.png)";
    const doc = `> ![](images/a.png)${newline}> > ${described} and ![](images/b.png "B")${newline}>${newline}> end${newline}`;
    const expected = `> ![TODO: describe image](images/a.png)${newline}> > ${described} and ![TODO: describe image](images/b.png "B")${newline}>${newline}> end${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["bare filename", "chart.png"],
    ["dot-slash", "./chart.png"],
    ["parent directory", "../chart.jpeg"],
    ["double extension", "images/archive.tar.gz"],
    ["uppercase extension", "images/Chart.PNG"],
  ])("keeps a relative destination with a filename extension when fixing an empty image description (%s)", (_name, target) => {
    const doc = `Intro.\n\n![](${target})\n`;
    const expected = `Intro.\n\n![TODO: describe image](${target})\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("adds a placeholder to every undescribed image in one paragraph and keeps each destination in order with %j line endings", (newline) => {
    const doc = `Intro.${newline}${newline}First ![](images/a.png) then ![](images/b%20c.png "B") and ![](images/c.png?v=2#top).${newline}`;
    const expected = `Intro.${newline}${newline}First ![TODO: describe image](images/a.png) then ![TODO: describe image](images/b%20c.png "B") and ![TODO: describe image](images/c.png?v=2#top).${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(3);
    expect(
      violations.every((v) => v.ruleId === "missing-alt-text" && v.fix !== null),
    ).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const destinations = [...fixed.matchAll(/\]\(([^)]*)\)/g)].map((m) => m[1]);
    expect(destinations).toEqual([
      "images/a.png",
      'images/b%20c.png "B"',
      "images/c.png?v=2#top",
    ]);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("adds a description only to the undescribed image and keeps the described image exactly with %j line endings", (newline) => {
    const described = '![Quarterly chart](images/q1.png?v=2#top "Q1")';
    const doc = `Intro.${newline}${newline}${described} then ![](images/q2.png) and ![ ](images/q3.png).${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `Intro.${newline}${newline}${described} then ![TODO: describe image](images/q2.png) and ![TODO: describe image](images/q3.png).${newline}`,
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("inserts the placeholder when the undescribed image is the last text of the document with %j line endings", (newline) => {
    const doc = `Intro.${newline}${newline}![](images/chart.png "Chart")`;
    const expected = `Intro.${newline}${newline}![TODO: describe image](images/chart.png "Chart")`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["precomposed accent", "images/café.png"],
    ["decomposed accent", "images/café.png"],
    ["CJK", "images/日本語ガイド.png"],
    ["ZWJ emoji", "images/👩🏽‍💻 diagram.png"],
    ["percent-encoded in angle brackets", "<images/caf%C3%A9 図.png>"],
  ])("inserts the placeholder for an undescribed image and preserves a Unicode filename byte-for-byte (%s)", (_name, target) => {
    const doc = `Intro café.\n\n![](${target} "Título") tail.\n`;
    const expected = `Intro café.\n\n![TODO: describe image](${target} "Título") tail.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(target);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("adds the placeholder to an undescribed image in a sentence and keeps the words, emphasis, inline code and punctuation around it (line endings %j)", (nl) => {
    const doc = `Intro.${nl}${nl}**Note:** the chart ![](images/chart.png), unlike \`![](code.png)\`, is *required*; see [docs](./docs.md)!${nl}`;
    const expected = `Intro.${nl}${nl}**Note:** the chart ![TODO: describe image](images/chart.png), unlike \`![](code.png)\`, is *required*; see [docs](./docs.md)!${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["parentheses", "(", ")"],
    ["quotes and comma", "“", "”,"],
    ["brackets and semicolon", "[", "];"],
    ["colon and em dash", "see: ", "—"],
    ["trailing ellipsis and bang", "", "…!"],
    ["CJK punctuation", "「", "」。"],
  ])("inserts the placeholder for an undescribed image adjacent to punctuation and leaves the punctuation unchanged (%s)", (_name, before, after) => {
    const doc = `Intro.\n\nLook ${before}![](images/chart.png)${after} end.\n`;
    const expected = `Intro.\n\nLook ${before}![TODO: describe image](images/chart.png)${after} end.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["nested directory", "docs/assets/img/chart.png"],
    ["dot-slash prefix", "./docs/assets/chart.png"],
    ["parent traversal", "../../assets/shared/chart.png"],
    ["query and fragment", "docs/assets/chart.png?view=full#data"],
  ])("inserts the placeholder for an undescribed image and preserves the full relative directory path (%s)", (_name, target) => {
    const doc = `Intro.\n\nSee ![](${target} "Chart") here.\n`;
    const expected = `Intro.\n\nSee ![TODO: describe image](${target} "Chart") here.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`](${target} "Chart")`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("describes an undescribed image that ends the document with no final newline with %j line endings", (newline) => {
    const doc = `Opening paragraph.${newline}${newline}![](images/chart.png "Chart")`;
    const expected = `Opening paragraph.${newline}${newline}![TODO: describe image](images/chart.png "Chart")`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("describes two undescribed images in one document and keeps each source with %j line endings", (newline) => {
    const doc = `Intro.${newline}${newline}![](images/one.png) and ![](images/two.png "Two")${newline}`;
    const expected = `Intro.${newline}${newline}![TODO: describe image](images/one.png) and ![TODO: describe image](images/two.png "Two")${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("![TODO: describe image](images/one.png)");
    expect(fixed).toContain('![TODO: describe image](images/two.png "Two")');
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("describes an undescribed image at the end of a line and keeps the preceding text unchanged with %j line endings", (newline) => {
    const lead = "Preceding café text, see:  ";
    const doc = `Intro.${newline}${newline}${lead}![](images/chart.png)${newline}Next line.${newline}`;
    const expected = `Intro.${newline}${newline}${lead}![TODO: describe image](images/chart.png)${newline}Next line.${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`${lead}![TODO: describe image]`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("describes an undescribed image at the very start of the document and preserves the following prose with %j line endings", (newline) => {
    const doc = `![](images/chart.png "Chart")${newline}${newline}Following paragraph, café.${newline}${newline}Last line.${newline}`;
    const expected = `![TODO: describe image](images/chart.png "Chart")${newline}${newline}Following paragraph, café.${newline}${newline}Last line.${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(
      fixed.endsWith(
        `Following paragraph, café.${newline}${newline}Last line.${newline}`,
      ),
    ).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("describes an undescribed image that opens a later paragraph and preserves the prose after it with %j line endings", (newline) => {
    const intro = `Intro paragraph, café.${newline}${newline}`;
    const rest = ` shows the *trend*; see [notes](./n.md).${newline}Wrapped line stays.${newline}${newline}Last paragraph.${newline}`;
    const doc = `${intro}![](images/chart.png "Chart")${rest}`;
    const expected = `${intro}![TODO: describe image](images/chart.png "Chart")${rest}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.startsWith(intro)).toBe(true);
    expect(fixed.endsWith(rest)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    [
      "image is the entire document",
      "![](a b.png)",
      "![TODO: describe image](a b.png)",
    ],
    [
      "angle-bracket destination",
      "![](<my pics/a.png>)\nText.\n",
      "![TODO: describe image](<my pics/a.png>)\nText.\n",
    ],
    [
      "leading BOM",
      "\uFEFF![](a.png)\nText.\n",
      "\uFEFF![TODO: describe image](a.png)\nText.\n",
    ],
  ])("inserts the placeholder for an undescribed image at document start and preserves the source (%s)", (_name, doc, expected) => {
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes the undescribed image at document start and a later one, leaving a described image and following text untouched", () => {
    const doc =
      '![](a.png) lead café.\n\nKept ![Chart](b.png) here.\n\nThen ![ ](c.png "T") end.\n';
    const expected =
      '![TODO: describe image](a.png) lead café.\n\nKept ![Chart](b.png) here.\n\nThen ![TODO: describe image](c.png "T") end.\n';
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations[0].range?.from.offset).toBe(0);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("describes an undescribed image at the start of a document when prose follows on the same line", () => {
    const doc = "![](a.png) then prose continues.\nNext line.\n";
    const expected =
      "![TODO: describe image](a.png) then prose continues.\nNext line.\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "images/my-chart.png",
    "my-multi-part-chart-v2.png",
    "./assets/hero-image-2x.png?size=2#preview",
  ])("inserts the placeholder for an undescribed image and preserves the hyphenated filename %j", (src) => {
    const doc = `Intro.\n\nSee ![](${src}) here.\n`;
    const expected = `Intro.\n\nSee ![TODO: describe image](${src}) here.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`(${src})`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["spaces", "   "],
    ["a tab", "\t"],
    ["mixed spaces and tabs", " \t "],
  ])("replaces whitespace-only alt text (%s) with the placeholder and preserves the image source", (_name, alt) => {
    const doc = `Intro.\n\nSee ![${alt}](images/chart.png "Chart") here.\n`;
    const expected = `Intro.\n\nSee ![TODO: describe image](images/chart.png "Chart") here.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    [true, "\n"],
    [false, "\n"],
    [true, "\r\n"],
    [false, "\r\n"],
  ])("describes an undescribed image and preserves a valid link exactly beside it (image first: %s, %j)", (imageFirst, newline) => {
    const link =
      '[Café docs](https://example.com/docs/caf%C3%A9?a=1&b=2#top "Docs (v2)")';
    const image = "![](images/chart.png?view=full#data)";
    const repairedImage = "![TODO: describe image](images/chart.png?view=full#data)";
    const body = imageFirst ? `${image} ${link}` : `${link} ${image}`;
    const expectedBody = imageFirst
      ? `${repairedImage} ${link}`
      : `${link} ${repairedImage}`;
    const doc = `Before café: ${body}  after.${newline}`;
    const expected = `Before café: ${expectedBody}  after.${newline}`;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    // Only the image is flagged; the valid link is never touched.
    expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(link);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "images/my-chart.png",
    "my-multi-part-chart-v2.png",
    "./assets/hero-image-2x.png?size=2#preview",
  ])("leaves a described image with the hyphenated filename %j unchanged", (src) => {
    const doc = `# Title\n\nSee ![A described chart](${src} "Chart") here.\n`;
    const defaultRules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );

    for (const rules of [[ruleMissingAltText], defaultRules]) {
      const violations = lintDocument(doc, { rules });
      expect(violations).toEqual([]);
      expect(applyAllFixes(doc, violations)).toBe(doc);
    }
  });

  it.each([
    ["\n", "\n"],
    ["\r\n", "\r\n"],
    ["\n", ""],
  ])("autofix leaves a valid described image and its surrounding text unchanged (line ending %j, final newline %j)", (newline, final) => {
    const image = '![Café *latency* chart](images/latency.png?v=2#top "Latency")';
    const doc = `# Report${newline}${newline}Before the chart.${newline}${newline}${image}${newline}${newline}After the chart, with ${image} inline.${final}`;
    const defaultRules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );

    for (const rules of [[ruleMissingAltText], defaultRules]) {
      const violations = lintDocument(doc, { rules });
      expect(violations).toEqual([]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(doc);
      expect(fixed.split(image)).toHaveLength(3);
      expect(fixed).not.toContain("TODO");
    }
  });

  it("preserves surrounding blank lines and the final newline when fixing a link", () => {
    const doc =
      "\nOpening paragraph.\n\n\nRead [draft]() here.\n\nClosing paragraph.\n\n";
    const expected =
      "\nOpening paragraph.\n\n\nRead [draft](TODO) here.\n\nClosing paragraph.\n\n";
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

  it.each([
    "\n",
    "\r\n",
  ])("replaces a destination that is whitespace across line breaks with TODO (%j)", (nl) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = `Intro café.${nl}Read [draft](${nl}  \t${nl}) now.${nl}Then [guide](./guide.md).${nl}`;
    const expected = `Intro café.${nl}Read [draft](TODO) now.${nl}Then [guide](./guide.md).${nl}`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`[draft](${nl}  \t${nl})`);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("does not treat a quoted title after whitespace as an empty destination", () => {
    const doc = 'See [a](   "title") here.\n';
    expect(lintDocument(doc, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
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
    "\n",
    "\r\n",
  ])("preserves multiline context and code examples with %j line endings", (newline) => {
    const lines = [
      "Opening paragraph: 🚀 café.",
      "",
      "```md",
      "Read [draft](#) here.",
      "```",
      "",
      "Read [draft](#) here, then [published](./guide.md).",
      "",
      "Closing paragraph keeps  its spacing.",
    ];
    const doc = `${lines.join(newline)}${newline}`;
    const expected = `${[
      ...lines.slice(0, 6),
      "Read [draft](TODO) here, then [published](./guide.md).",
      ...lines.slice(7),
    ].join(newline)}${newline}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "\n",
    "\r\n",
  ])("preserves a multiline link label and surrounding lines with %j line endings", (newline) => {
    const prefix = `Opening paragraph.${newline}${newline}Read [draft${newline}guide](`;
    const suffix = `) for details.${newline}${newline}Closing paragraph.${newline}`;
    const doc = `${prefix}?${suffix}`;
    const expected = `${prefix}TODO${suffix}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
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
    "",
    " \t ",
    "#",
    "?",
  ])("checks the exact fixed line for destination %j at the start of a line, preserving its trailing text", (destination) => {
    for (const newline of ["\n", "\r\n"]) {
      const link = `[draft](${destination})`;
      const trailing = " continues to [guide](./guide.md) — café  spacing &\ttab.";
      const lines = ["Intro line stays.", `${link}${trailing}`, "Closing line."];
      const doc = `${lines.join(newline)}${newline}`;
      const fixedLine = `[draft](TODO)${trailing}`;
      const expected = `${[lines[0], fixedLine, lines[2]].join(newline)}${newline}`;
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      expect(violations[0].range?.from).toMatchObject({ line: 2, col: 0 });
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(link);
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      const fixedLines = fixed.split(newline);
      expect(fixedLines).toEqual([lines[0], fixedLine, lines[2], ""]);
      expect(fixedLines[1]).toBe(fixedLine);
      expect(fixedLines[1].slice("[draft](TODO)".length)).toBe(trailing);
      const remaining = lintDocument(fixed, { rules });
      expect(remaining).toEqual([]);
      expect(applyAllFixes(fixed, remaining)).toBe(expected);
    }
  });

  it.each([
    "",
    " ",
    "#",
    "?",
  ])("fixes an invalid link opening a mid-document line (destination %j) without moving the text that follows it", (destination) => {
    const link = `[draft](${destination})`;
    const repaired = "[draft](TODO)";
    // Trailing text opens with a parenthesis group and holds a code-span
    // lookalike and a valid link: none of it may move under the fix.
    const following =
      " (paren) keeps `[sample]()` and [guide](./guide.md) — café  end.";
    const tail = ["Next line stays.", "", "Last line keeps  spacing.  "];
    const delta = repaired.length - link.length;

    for (const newline of ["\n", "\r\n"]) {
      const head = ["Intro line with [ok](./ok.md).", "Second line stays.", ""];
      const doc = [...head, link + following, ...tail].join(newline);
      const expected = [...head, repaired + following, ...tail].join(newline);
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations.map((violation) => violation.ruleId)).toEqual([
        "invalid-link-target",
      ]);
      const { from, to } = violations[0].range!;
      expect(from).toMatchObject({ line: head.length + 1, col: 0 });
      expect(doc.slice(0, from.offset).endsWith("\n")).toBe(true);
      expect(doc.slice(from.offset, to.offset)).toBe(link);
      expect(violations[0].fix).not.toBeNull();

      for (const fixed of [
        applyFix(doc, violations[0]),
        applyAllFixes(doc, violations),
      ]) {
        expect(fixed).toBe(expected);
        // Byte-for-byte: the text before the link is unchanged, the link
        // became `[draft](TODO)`, and every character after it kept its
        // text at its shifted offset.
        expect(fixed.slice(0, from.offset)).toBe(doc.slice(0, from.offset));
        expect(fixed.slice(from.offset, to.offset + delta)).toBe(repaired);
        expect(fixed.slice(to.offset + delta)).toBe(doc.slice(to.offset));
      }
      const remaining = lintDocument(expected, { rules });
      expect(remaining).toEqual([]);
      expect(applyAllFixes(expected, remaining)).toBe(expected);
    }
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

  it.each(
    ["", " \t ", "#", "?"].flatMap((destination) =>
      ["", "\n", "\r\n"].map((ending) => [destination, ending]),
    ),
  )("is idempotent for an invalid link destination %j with ending %j", (destination, ending) => {
    const doc = `Before [link](${destination}) after.${ending}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(`Before [link](TODO) after.${ending}`);
    const remaining = lintDocument(once, { rules });
    expect(remaining).toEqual([]);
    const twice = applyAllFixes(once, remaining);
    expect(twice).toBe(once);
  });

  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("keeps a single link fix for destination %j unchanged on a subsequent fix-all pass", (destination) => {
    const doc = `📚 Read [draft](${destination}) beside [guide](./guide.md).\r\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();

    const once = applyFix(doc, violations[0]);
    expect(once).toBe("📚 Read [draft](TODO) beside [guide](./guide.md).\r\n");
    const remaining = lintDocument(once, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(once, remaining)).toBe(once);
  });

  it("is idempotent for an invalid link with all built-in rules enabled", () => {
    const doc =
      "---\ntitle: Guide\n---\n\n# Guide\n\nSee ![](chart.png) and [draft]().   \n";
    const violations = lintDocument(doc);
    expect(violations.map((violation) => violation.ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
      "no-trailing-spaces",
    ]);

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(
      "---\ntitle: Guide\n---\n\n# Guide\n\nSee ![TODO: describe image](chart.png) and [draft](TODO).\n",
    );
    const remaining = lintDocument(once);
    expect(remaining).toEqual([]);
    expect(applyAllFixes(once, remaining)).toBe(once);
  });

  it.each([
    "\n",
    "\r\n",
  ])("keeps an invalid link and trailing whitespace fixed on a second pass with %j line endings", (newline) => {
    const doc = ["Opening paragraph.", "", "Read [draft]() next.   "].join(newline);
    const rules = [ruleInvalidLinkTarget, ruleNoTrailingSpaces];
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId).sort()).toEqual([
      "invalid-link-target",
      "no-trailing-spaces",
    ]);

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(
      ["Opening paragraph.", "", "Read [draft](TODO) next."].join(newline),
    );
    const remaining = lintDocument(once, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(once, remaining)).toBe(once);
  });

  it("is idempotent when fixing multiple invalid destinations across lines", () => {
    const doc =
      "📚 [draft]() and [section](#); keep [guide](./guide.md).\r\n" +
      "Then [search](?) and [café]( \t ) at the end.";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(4);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(
      "📚 [draft](TODO) and [section](TODO); keep [guide](./guide.md).\r\n" +
        "Then [search](TODO) and [café](TODO) at the end.",
    );
    const remaining = lintDocument(once, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(once, remaining)).toBe(once);
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

  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("fixes a single-line link with destination %j without adding a newline", (destination) => {
    const doc = `[draft](${destination})`;
    const expected = "[draft](TODO)";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "",
    "#",
    "?",
  ])("fixes the final link with destination %j while preserving an earlier code example", (destination) => {
    const link = `[draft](${destination})`;
    const prefix = `# Guide ☕\r\n\r\nExample: \`${link}\`\r\nKeep [docs](./guide.md).\r\n\r\nRead `;
    const doc = `${prefix}${link}`;
    const expected = `${prefix}[draft](TODO)`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].range?.from.offset).toBe(prefix.length);
    expect(violations[0].range?.to.offset).toBe(doc.length);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("preserves the document ending when fixing final destination %j", (destination) => {
    const prefix = "Café 📚.\r\nKeep [guide](./guide.md).\n\nRead ";
    const link = `[draft guide](${destination})`;
    const rules = [ruleInvalidLinkTarget];

    for (const ending of ["", "\n", "\r\n"]) {
      const doc = `${prefix}${link}${ending}`;
      const expected = `${prefix}[draft guide](TODO)${ending}`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      expect(violations[0].range?.from.offset).toBe(prefix.length);
      expect(violations[0].range?.to.offset).toBe(prefix.length + link.length);
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it("flags multiple invalid links in one document", () => {
    const doc = "[first]() and [second](#) and [valid](https://example.com).\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(2);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "[first](TODO) and [second](TODO) and [valid](https://example.com).\n",
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes every invalid destination among repeated labels across paragraphs", () => {
    const doc =
      "Before [guide]() and [guide](#), keep [guide](./guide.md).\r\n\r\n" +
      "Example: `[guide](?)`\nThen [guide](?) and [guide]( \t ) after café.";
    const expected =
      "Before [guide](TODO) and [guide](TODO), keep [guide](./guide.md).\r\n\r\n" +
      "Example: `[guide](?)`\nThen [guide](TODO) and [guide](TODO) after café.";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(4);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(
      violations.map(({ range }) => doc.slice(range!.from.offset, range!.to.offset)),
    ).toEqual(["[guide]()", "[guide](#)", "[guide](?)", "[guide]( \t )"]);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
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

  it.each([
    "",
    "#",
    "?",
    " \t ",
  ])("fixes a repeated invalid destination %j shared by links with distinct labels", (href) => {
    const rules = [ruleInvalidLinkTarget];
    const alpha = `[alpha](${href})`;
    const beta = `[beta](${href})`;
    const doc = `Read ${alpha} and ${beta} before [guide](./guide.md).\n`;
    const expected =
      "Read [alpha](TODO) and [beta](TODO) before [guide](./guide.md).\n";
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(
      violations.map((violation) =>
        doc.slice(violation.range!.from.offset, violation.range!.to.offset),
      ),
    ).toEqual([alpha, beta]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    // Each fix repairs only its own destination; the neighboring link's
    // distinct label and destination stay byte-identical.
    expect(applyFix(doc, violations[0])).toBe(
      `Read [alpha](TODO) and ${beta} before [guide](./guide.md).\n`,
    );
    expect(applyFix(doc, violations[1])).toBe(
      `Read ${alpha} and [beta](TODO) before [guide](./guide.md).\n`,
    );
    for (const fixed of [
      applyAllFixes(doc, violations),
      applyAllFixes(doc, [...violations].reverse()),
    ]) {
      expect(fixed).toBe(expected);
      // Both invalid destinations became TODO and each distinct label
      // survived unchanged.
      expect(fixed.match(/\(TODO\)/g)).toHaveLength(2);
      expect(fixed).toContain("[alpha](TODO)");
      expect(fixed).toContain("[beta](TODO)");
    }
    const remaining = lintDocument(expected, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(expected, remaining)).toBe(expected);
  });

  it.each([
    ["", "#"],
    ["#", " \t "],
    ["?", ""],
  ])("fixes a repeated label with different invalid hrefs %j and %j on one line inside emphasis", (first, second) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = `**See [docs](${first})**, _then [docs](${second})_; done (see [docs](./docs.md)).\n`;
    const expected =
      "**See [docs](TODO)**, _then [docs](TODO)_; done (see [docs](./docs.md)).\n";
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(fixed.match(/\[docs\]\(TODO\)/g)).toHaveLength(2);
    expect(lintDocument(expected, { rules })).toEqual([]);
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

  it("sets both invalid hrefs in a heading and a table row to TODO and keeps the surrounding text intact", () => {
    const doc =
      "## See [setup]() first\n\n| Name | Link |\n| --- | --- |\n| **docs** | [guide](   ) and [ok](./ok.md) |\n\nTrailing *text*.\n";
    const expected =
      "## See [setup](TODO) first\n\n| Name | Link |\n| --- | --- |\n| **docs** | [guide](TODO) and [ok](./ok.md) |\n\nTrailing *text*.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(
      violations.map((v) => doc.slice(v.range!.from.offset, v.range!.to.offset)),
    ).toEqual(["[setup]()", "[guide](   )"]);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("autofixes two invalid links across one paragraph with %j line endings", (newline) => {
    const doc = [
      "Before café [first]() and  more text,",
      "then [second](?) after a\ttab.",
      "",
    ].join(newline);
    const expected = [
      "Before café [first](TODO) and  more text,",
      "then [second](TODO) after a\ttab.",
      "",
    ].join(newline);
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("fixes different invalid destinations with the same label independently", () => {
    const doc = "Before [café guide]() and [café guide](#) after.\n";
    const expected = "Before [café guide](TODO) and [café guide](TODO) after.\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(
      "Before [café guide](TODO) and [café guide](#) after.\n",
    );
    expect(applyFix(doc, violations[1])).toBe(
      "Before [café guide]() and [café guide](TODO) after.\n",
    );
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("autofixes adjacent invalid links without changing surrounding text", () => {
    const doc = "Before café [first]()[second](#) after.\r\nNext line.\n";
    const expected = "Before café [first](TODO)[second](TODO) after.\r\nNext line.\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(
      "Before café [first](TODO)[second](#) after.\r\nNext line.\n",
    );
    expect(applyFix(doc, violations[1])).toBe(
      "Before café [first]()[second](TODO) after.\r\nNext line.\n",
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("preserves intervening prose when fixing multiple links in either violation order", () => {
    const doc = "Before [first](      ) — café 😀, then [second](?) after.\n";
    const expected = "Before [first](TODO) — café 😀, then [second](TODO) after.\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["", "#"],
    ["?", "   "],
  ])("fixes both invalid links %j and %j on one line and preserves the intervening text", (first, second) => {
    const prefix = "Read ";
    // A code span between the links holds a link-shaped example that is
    // never linted, and the prose keeps its Unicode and double spaces.
    const middle = ", then compare `[x](#)` — café 😀 and  spaces before ";
    const suffix = " to finish.\n";
    const doc = `${prefix}[draft](${first})${middle}[next](${second})${suffix}`;
    const expected = `${prefix}[draft](TODO)${middle}[next](TODO)${suffix}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(
      violations.map((violation) =>
        doc.slice(violation.range!.from.offset, violation.range!.to.offset),
      ),
    ).toEqual([`[draft](${first})`, `[next](${second})`]);
    // Each fix alone repairs only its own destination.
    expect(applyFix(doc, violations[0])).toBe(
      `${prefix}[draft](TODO)${middle}[next](${second})${suffix}`,
    );
    expect(applyFix(doc, violations[1])).toBe(
      `${prefix}[draft](${first})${middle}[next](TODO)${suffix}`,
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The text between the two links is byte-for-byte identical afterward.
    const between = fixed.indexOf("[next](TODO)");
    const firstEnd = fixed.indexOf("[draft](TODO)") + "[draft](TODO)".length;
    expect(fixed.slice(firstEnd, between)).toBe(middle);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
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

  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("preserves the punctuation after an invalid link with destination %j exactly", (destination) => {
    const link = `[draft](${destination})`;
    const repaired = "[draft](TODO)";
    const rules = [ruleInvalidLinkTarget];

    for (const punctuation of [
      ".",
      ",",
      ";",
      ":",
      "!",
      "?",
      "…",
      "—",
      ")",
      "'s",
      "...",
      "!!",
      ").",
    ]) {
      const doc = `Read ${link}${punctuation} then [guide](./guide.md).\n`;
      const expected = `Read ${repaired}${punctuation} then [guide](./guide.md).\n`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(link);
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("preserves punctuation on both sides of a link with destination %j", (destination) => {
    const doc = `See (“[café guide](${destination})”); then continue.\r\n`;
    const expected = "See (“[café guide](TODO)”); then continue.\r\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["Read [draft](), then publish it.\n", "Read [draft](TODO), then publish it.\n"],
    ["(see [draft](#)), then continue.\n", "(see [draft](TODO)), then continue.\n"],
    ["Click [next](?); it's ready.\n", "Click [next](TODO); it's ready.\n"],
    ["The [draft]( \t )'s content.\n", "The [draft](TODO)'s content.\n"],
    ["Read [draft](#).", "Read [draft](TODO)."],
  ])("replaces the invalid destination and preserves the punctuation in %j", (doc, expected) => {
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

  it.each([
    ["「[草稿](#)」、続く。\n", "「[草稿](TODO)」、続く。\n"],
    ["¿Ver [guía]( \t )? ¡Sí!\n", "¿Ver [guía](TODO)? ¡Sí!\n"],
    ["**[bold]()**, _[it](?)_.\n", "**[bold](TODO)**, _[it](TODO)_.\n"],
    ["- [item](#): note; [two](?).\n", "- [item](TODO): note; [two](TODO).\n"],
  ])("keeps surrounding Unicode and markup punctuation when fixing %j", (doc, expected) => {
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(
      violations.every((v) => v.ruleId === "invalid-link-target" && v.fix !== null),
    ).toBe(true);
    expect(violations.length).toBeGreaterThan(0);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("preserves each punctuation mark when fixing several invalid links on one line", () => {
    const doc = "See [a](), [b](#); then [c](?)! Keep [docs](./guide.md).\r\n";
    const expected =
      "See [a](TODO), [b](TODO); then [c](TODO)! Keep [docs](./guide.md).\r\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    "",
    " \t ",
    "#",
    "?",
  ])("fixes an invalid link touching a valid link on each side for destination %j", (destination) => {
    const before = '[start](./start.md "Start")';
    const after = "[end](https://example.com/end?on=1#links)";
    const link = `[mid](${destination})`;
    const doc = `${before}${link}${after}`;
    const expected = `${before}[mid](TODO)${after}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(link);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    ["[](#)", "[](./guide.md)[](#)", "[](./guide.md)[](TODO)"],
    ["[](#)", "[](#)[](./guide.md)", "[](TODO)[](./guide.md)"],
    ["[](?)", "[](./guide.md) [](?)", "[](./guide.md) [](TODO)"],
    ["[]( )", "[]( ) [](./guide.md)", "[](TODO) [](./guide.md)"],
  ])("fixes only the empty-label link %s in %s", (link, links, expectedLinks) => {
    const doc = `See ${links} next.\n`;
    const expected = `See ${expectedLinks} next.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(link);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "## Read [guide](./guide.md) and [draft](#) next",
    "> Read [guide](./guide.md) and [draft](#) next",
    "- Read [guide](./guide.md) and [draft](#) next",
  ])("fixes the invalid link beside a valid link in %j", (line) => {
    const doc = `${line}\n\nDone.\n`;
    const expected = `${line.replace("[draft](#)", "[draft](TODO)")}\n\nDone.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[draft](#)");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "[mail](mailto:docs@example.com)",
    "[todo list](./TODO.md)",
    "[root](/docs/guide.md)",
  ])("preserves the valid link %s beside a repaired link in either order", (valid) => {
    const invalid = "[draft](#)";
    const repaired = "[draft](TODO)";
    const rules = [ruleInvalidLinkTarget];

    for (const validFirst of [true, false]) {
      const doc = `See ${validFirst ? valid : invalid} ${validFirst ? invalid : valid}.\n`;
      const expected = `See ${validFirst ? valid : repaired} ${validFirst ? repaired : valid}.\n`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(invalid);
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed).toContain(valid);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it.each([
    "",
    " ",
    "#",
    "?",
  ])("fixes an invalid link at the end of a line for href %j", (href) => {
    const rules = [ruleInvalidLinkTarget];
    const leading = "End of the section — see";
    const link = `[draft](${href})`;

    for (const newline of ["\n", "\r\n"]) {
      const doc = `Intro paragraph.${newline}${leading} ${link}${newline}Outro paragraph.${newline}`;
      const expectedLine = `${leading} [draft](TODO)`;
      const expected = `Intro paragraph.${newline}${expectedLine}${newline}Outro paragraph.${newline}`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(link);
      expect(doc.slice(to.offset, to.offset + newline.length)).toBe(newline);
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed.split(newline)[1]).toBe(expectedLine);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it("fixes an invalid link at the end of a line before a hard break and keeps the preceding text and break spaces", () => {
    const rules = [ruleInvalidLinkTarget];
    const leading = "Café notes: see **the** draft";
    const doc = `${leading} [draft]()  \nNext line.\n`;
    const expected = `${leading} [draft](TODO)  \nNext line.\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[draft]()");
    expect(doc.slice(0, from.offset)).toBe(`${leading} `);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.startsWith(`${leading} [draft](TODO)`)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["bullet item", "- "],
    ["ordered item", "1. "],
    ["blockquote", "> "],
    ["nested blockquote list", "> - "],
  ])("fixes an invalid link at the end of a %s line and keeps the marker, text and newline", (_name, marker) => {
    const rules = [ruleInvalidLinkTarget];
    for (const newline of ["\n", "\r\n"]) {
      const doc = `Intro.${newline}${newline}${marker}Read the [draft]()${newline}${marker.replace(/[-\d.]+ $/, "  ")}Tail.${newline}`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe("[draft]()");
      expect(doc.slice(to.offset, to.offset + newline.length)).toBe(newline);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(doc.replace("[draft]()", "[draft](TODO)"));
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it("fixes an invalid link at the end of the last line with no trailing newline", () => {
    const leading = "Final note — see";
    const doc = `Intro paragraph.\n\n${leading} [draft](?)`;
    const expectedLine = `${leading} [draft](TODO)`;
    const expected = `Intro paragraph.\n\n${expectedLine}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[draft](?)");
    expect(to.offset).toBe(doc.length);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.split("\n")[2]).toBe(expectedLine);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["no trailing newline", ""],
    ["one trailing newline", "\n"],
    ["trailing blank lines", "\n\n\n"],
  ])("inserts TODO into a last-line heading link after a fenced example and keeps all preceding text (%s)", (_name, ending) => {
    const prefix = [
      "# Notes",
      "",
      "```md",
      "[example]()",
      "```",
      "",
      "Earlier [ok](./ok.md) text with `[code]()` stays.",
      "",
      "## See ",
    ].join("\n");
    const doc = `${prefix}[more](#)${ending}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    expect(violations[0].range?.from.offset).toBe(prefix.length);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`${prefix}[more](TODO)${ending}`);
    expect(fixed.startsWith(prefix)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("repairs a final invalid link with all built-in rules without adding a trailing newline", () => {
    const prefix = "---\ntitle: Guide\n---\n\n# Guide\n\nSee [docs](./guide.md) and ";
    const doc = `${prefix}[draft]()`;
    const violations = lintDocument(doc);

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`${prefix}[draft](TODO)`);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed)).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed))).toBe(fixed);
  });

  it.each([
    "",
    " ",
    "#",
    "?",
  ])("repairs a final invalid link %j while a document-level fix prepends frontmatter, still without adding a trailing newline", (href) => {
    // No frontmatter: the default rules also report frontmatter-required,
    // whose document-level fix runs after the link fix and must not append a
    // newline either.
    for (const nl of ["\n", "\r\n"]) {
      const link = `[draft](${href})`;
      const doc = ["Intro [ok](./ok.md) stays.", "", `Final: ${link}`].join(nl);
      const violations = lintDocument(doc);

      expect(violations.map(({ ruleId }) => ruleId)).toEqual([
        "invalid-link-target",
        "frontmatter-required",
      ]);
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(link);
      // The link is the end of the document: no bytes follow it.
      expect(to.offset).toBe(doc.length);

      // The link fix on its own repairs the destination.
      const linkOnly = ["Intro [ok](./ok.md) stays.", "", "Final: [draft](TODO)"].join(
        nl,
      );
      expect(applyFix(doc, violations[0])).toBe(linkOnly);

      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(["---", "title: ", "tags: []", "---", "", linkOnly].join(nl));
      // The destination is fixed and no final newline was added.
      expect(fixed.endsWith("[draft](TODO)")).toBe(true);
      expect(fixed.endsWith("\n")).toBe(false);
      expect(fixed.endsWith("\r")).toBe(false);
      expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
    }
  });

  it.each([
    "\n",
    "\r\n",
  ])("repairs a final undescribed image with all built-in rules without adding a trailing newline (%j)", (newline) => {
    const prefix = [
      "---",
      "title: Guide",
      "---",
      "",
      "# Guide",
      "",
      "See [docs](./guide.md):",
      "",
      "",
    ].join(newline);
    const doc = `${prefix}![](images/chart.png "Chart")`;
    const violations = lintDocument(doc);

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`${prefix}![TODO: describe image](images/chart.png "Chart")`);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed)).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed))).toBe(fixed);
  });

  it.each([
    "",
    " ",
    "#",
    "?",
  ])("fixes only the destination of an invalid link %j followed by a newline and an unrelated paragraph", (href) => {
    const rules = [ruleInvalidLinkTarget];
    const link = `[draft](${href})`;
    // The unrelated paragraph holds a valid link and a code span wrapping a
    // broken link; neither is linted, so both must survive autofix verbatim.
    const paragraph =
      "Unrelated paragraph keeps [the guide](./guide.md) and `[sample](#)` intact — café.";
    for (const newline of ["\n", "\r\n"]) {
      for (const blank of ["", newline]) {
        const tail = `${newline}${blank}${paragraph}${newline}`;
        const doc = `Read ${link}${tail}`;
        const expected = `Read [draft](TODO)${tail}`;
        const violations = lintDocument(doc, { rules });

        expect(violations).toHaveLength(1);
        expect(violations[0].ruleId).toBe("invalid-link-target");
        const { from, to } = violations[0].range!;
        expect(doc.slice(from.offset, to.offset)).toBe(link);
        // The newline and paragraph sit outside the violation's range.
        expect(doc.slice(to.offset)).toBe(tail);
        expect(violations[0].fix).not.toBeNull();
        expect(applyFix(doc, violations[0])).toBe(expected);
        const fixed = applyAllFixes(doc, violations);
        expect(fixed).toBe(expected);
        // Only the destination changed: the link text, the newline and the
        // paragraph are byte-identical before and after the fix.
        expect(fixed.endsWith(tail)).toBe(true);
        expect(fixed.slice(0, from.offset)).toBe(doc.slice(0, from.offset));
        expect(lintDocument(fixed, { rules })).toEqual([]);
      }
    }
  });

  it.each([
    "",
    " ",
    "#",
    "?",
  ])("fixing an invalid link %j in multiline prose leaves unrelated preceding and following lines unchanged", (href) => {
    const rules = [ruleInvalidLinkTarget];
    const link = `[draft](${href})`;
    const repaired = `[draft](TODO)`;
    const preceding = [
      "# Café notes",
      "",
      "First paragraph stays as written — café,  double spacing.",
      "It keeps [a valid link](./guide.md) and `[code](#)` intact.",
      "",
    ];
    const linkLine = `Read ${link} before continuing.`;
    const fixedLine = `Read ${repaired} before continuing.`;
    const following = [
      "",
      "Second paragraph stays as written too — ☕.",
      "It keeps [another link](https://example.com/guide?x=1#frag) intact.",
      "Trailing spaces on this line stay.   ",
    ];
    const delta = repaired.length - link.length;

    for (const newline of ["\n", "\r\n"]) {
      const doc = [...preceding, linkLine, ...following].join(newline);
      const expected = [...preceding, fixedLine, ...following].join(newline);
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      expect(violations[0].range?.from.line).toBe(preceding.length + 1);
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(link);
      expect(violations[0].fix).not.toBeNull();

      for (const fixed of [
        applyFix(doc, violations[0]),
        applyAllFixes(doc, violations),
      ]) {
        expect(fixed).toBe(expected);
        // Every line before the link line is byte-identical.
        expect(fixed.slice(0, from.offset)).toBe(doc.slice(0, from.offset));
        // Every line after the link line is byte-identical, at its shifted offset.
        expect(fixed.slice(to.offset + delta)).toBe(doc.slice(to.offset));
        expect(fixed.split(newline)).toEqual([...preceding, fixedLine, ...following]);
      }
      const remaining = lintDocument(expected, { rules });
      expect(remaining).toEqual([]);
      expect(applyAllFixes(expected, remaining)).toBe(expected);
    }
  });

  it.each([
    ["", "#"],
    ["?", " "],
    [" \t ", ""],
    ["#", "?"],
  ])("inserts both placeholders for invalid links %j and %j on separate lines while line breaks stay unchanged", (firstHref, secondHref) => {
    const rules = [ruleInvalidLinkTarget];
    const first = `[first](${firstHref})`;
    const second = `[second](${secondHref})`;
    const middle = "A [guide](./guide.md) and a `[code](#)` example sit between them.";

    for (const newline of ["\n", "\r\n"]) {
      const firstLine = `Read ${first} before the break — café.`;
      const fixedFirstLine = `Read [first](TODO) before the break — café.`;
      const thirdLine = `Then ${second} after the break.`;
      const fixedThirdLine = `Then [second](TODO) after the break.`;
      for (const rest of [[], [""]]) {
        const lines = [firstLine, middle, thirdLine, ...rest];
        const doc = lines.join(newline);
        const expected = [fixedFirstLine, middle, fixedThirdLine, ...rest].join(
          newline,
        );
        const violations = lintDocument(doc, { rules });

        expect(violations.map((violation) => violation.ruleId)).toEqual([
          "invalid-link-target",
          "invalid-link-target",
        ]);
        expect(
          violations.map((violation) =>
            doc.slice(violation.range!.from.offset, violation.range!.to.offset),
          ),
        ).toEqual([first, second]);
        expect(violations[0].range?.from.line).toBe(1);
        expect(violations[1].range?.from.line).toBe(3);
        expect(violations.every((violation) => violation.fix !== null)).toBe(true);

        // Each fix alone repairs only its own line's destination.
        expect(applyFix(doc, violations[0])).toBe(
          [fixedFirstLine, middle, thirdLine, ...rest].join(newline),
        );
        expect(applyFix(doc, violations[1])).toBe(
          [firstLine, middle, fixedThirdLine, ...rest].join(newline),
        );

        for (const fixed of [
          applyAllFixes(doc, violations),
          applyAllFixes(doc, [...violations].reverse()),
        ]) {
          expect(fixed).toBe(expected);
          // Both placeholders were inserted and every line break survives
          // byte-identical: the same terminators in the same order.
          expect(fixed.match(/\(TODO\)/g)).toHaveLength(2);
          expect(fixed.match(/\r\n|\n/g)).toEqual(doc.match(/\r\n|\n/g));
        }
        const remaining = lintDocument(expected, { rules });
        expect(remaining).toEqual([]);
        expect(applyAllFixes(expected, remaining)).toBe(expected);
      }
    }
  });

  it.each([
    "",
    "#",
    "?",
    " \t ",
  ])("fixes an invalid link %j that ends a document with no trailing newline", (href) => {
    const rules = [ruleInvalidLinkTarget];
    const link = `[draft](${href})`;

    for (const newline of ["\n", "\r\n"]) {
      const lines = [
        "# Guide",
        "",
        "Keep [docs](./guide.md) and `[code]()` intact.",
        `Read ${link}`,
      ];
      const doc = lines.join(newline);
      const expected = [...lines.slice(0, -1), "Read [draft](TODO)"].join(newline);
      const violations = lintDocument(doc, { rules });

      expect(violations.map((violation) => violation.ruleId)).toEqual([
        "invalid-link-target",
      ]);
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(link);
      // The link is the end of the document: no bytes, not even a newline,
      // follow it.
      expect(to.offset).toBe(doc.length);
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // Only the destination changed; the document still has no trailing
      // newline and every byte before the link is identical.
      expect(fixed.endsWith("\n")).toBe(false);
      expect(fixed.slice(0, from.offset)).toBe(doc.slice(0, from.offset));
      const remaining = lintDocument(fixed, { rules });
      expect(remaining).toEqual([]);
      expect(applyAllFixes(fixed, remaining)).toBe(expected);
    }
  });

  it("fixes multiple invalid links in one document while labels and surrounding text stay intact", () => {
    const doc =
      "# Links\n\nSee [empty]() for *details*, then [hash](#) for `code`.\n\n- [valid](./ok.md)\n";
    const expected =
      "# Links\n\nSee [empty](TODO) for *details*, then [hash](TODO) for `code`.\n\n- [valid](./ok.md)\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.ruleId === "invalid-link-target")).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("[empty]");
    expect(fixed).toContain("[hash]");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("replaces an invalid target in the last list item before trailing blank lines with TODO and keeps the label", () => {
    const doc = "# Links\n\n- [valid](./ok.md)\n- [Last item]( )\n\n\n";
    const expected = "# Links\n\n- [valid](./ok.md)\n- [Last item](TODO)\n\n\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("fixes an invalid link at document end without adding unrelated text", () => {
    const doc = [
      "# Installation Guide",
      "",
      "Follow the [setup docs](./setup.md) for initial configuration.",
      "",
      "## Configuration",
      "",
      "Edit the config file and restart the service.",
      "",
      "For more help see [support](#).",
    ].join("\n");
    const expected = [
      "# Installation Guide",
      "",
      "Follow the [setup docs](./setup.md) for initial configuration.",
      "",
      "## Configuration",
      "",
      "Edit the config file and restart the service.",
      "",
      "For more help see [support](TODO).",
    ].join("\n");
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("fixes six invalid links across a full document with heading, list and blockquote, keeping every label and surrounding prose", () => {
    const doc = [
      "---",
      "title: Changelog",
      "version: 2.0",
      "---",
      "",
      "# Changelog",
      "",
      "## Overview",
      "",
      "This release adds features. See [summary]() and [notes](  ).",
      "",
      "## Changes",
      "",
      "- Fixed [issue one](#)",
      "- Added [issue two](?)",
      "- See [docs](./docs.md) for the full reference.",
      "",
      "## Known issues",
      "",
      "> [workaround a]() may help with crash reports.",
      "> Also check [workaround b](   ) for memory leaks.",
      "",
      "Please file bugs at [tracker](https://example.com/issues).",
      "",
    ].join("\n");

    const expected = [
      "---",
      "title: Changelog",
      "version: 2.0",
      "---",
      "",
      "# Changelog",
      "",
      "## Overview",
      "",
      "This release adds features. See [summary](TODO) and [notes](TODO).",
      "",
      "## Changes",
      "",
      "- Fixed [issue one](TODO)",
      "- Added [issue two](TODO)",
      "- See [docs](./docs.md) for the full reference.",
      "",
      "## Known issues",
      "",
      "> [workaround a](TODO) may help with crash reports.",
      "> Also check [workaround b](TODO) for memory leaks.",
      "",
      "Please file bugs at [tracker](https://example.com/issues).",
      "",
    ].join("\n");

    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(6);
    expect(violations.every((v) => v.ruleId === "invalid-link-target")).toBe(true);

    // Each invalid href becomes TODO.
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);

    // All link labels are preserved in order.
    expect([...fixed.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1])).toEqual([
      "summary",
      "notes",
      "issue one",
      "issue two",
      "docs",
      "workaround a",
      "workaround b",
      "tracker",
    ]);

    // Surrounding prose is intact.
    expect(fixed).toContain("This release adds features.");
    expect(fixed).toContain("- Fixed [issue one](TODO)");
    expect(fixed).toContain("> [workaround a](TODO) may help with crash reports.");
    expect(fixed).toContain(
      "Please file bugs at [tracker](https://example.com/issues).",
    );

    // Clean after fix.
    expect(lintDocument(expected, { rules })).toEqual([]);

    // Idempotent.
    expect(applyAllFixes(expected, lintDocument(expected, { rules }))).toBe(expected);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("replaces the invalid href on the last line of a document with no final newline and adds none (%s)", (_name, nl) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = ["Intro with [ok](./a.md).", "", "Last line: [draft]()"].join(nl);
    const expected = ["Intro with [ok](./a.md).", "", "Last line: [draft](TODO)"].join(
      nl,
    );
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(from.line).toBe(3);
    expect(doc.slice(from.offset, to.offset)).toBe("[draft]()");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // No final newline is added.
    expect(fixed.endsWith("\n")).toBe(false);
    expect(fixed.endsWith("\r")).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "",
    " ",
    "#",
    "?",
  ])("replaces the invalid destination %j of a link that fills the final line without adding a newline", (href) => {
    const rules = [ruleInvalidLinkTarget];
    const link = `[draft](${href})`;
    const leading = "Intro keeps [ok](./ok.md) and `[code]()` intact.";

    for (const nl of ["\n", "\r\n"]) {
      const lines = [leading, "", link];
      const doc = lines.join(nl);
      const expected = [leading, "", "[draft](TODO)"].join(nl);
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      const { from, to } = violations[0].range!;
      // The link is the entire final line and the end of the document.
      expect(from.line).toBe(3);
      expect(from.col).toBe(0);
      expect(doc.slice(from.offset, to.offset)).toBe(link);
      expect(to.offset).toBe(doc.length);
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // The destination was replaced; no newline was added at the end.
      expect(fixed.endsWith("\n")).toBe(false);
      expect(fixed.endsWith("\r")).toBe(false);
      expect(fixed.slice(0, from.offset)).toBe(doc.slice(0, from.offset));
      const remaining = lintDocument(fixed, { rules });
      expect(remaining).toEqual([]);
      expect(applyAllFixes(fixed, remaining)).toBe(expected);
    }
  });
});

// ─── 3. Rule: missing-alt-text ────────────────────────────────────────────────

describe("rule:missing-alt-text", () => {
  it.each([
    ["plain destination", "![Quarterly revenue chart](charts/q3.png)"],
    [
      "query, fragment and title",
      '![Café *plan*](img/caf%C3%A9.png?s=2#top "Plan (v2)")',
    ],
    ["angle-bracket destination", "![Site map](<img/site map.png>)"],
  ])("leaves an already-described image untouched, markup and destination (%s)", (_name, image) => {
    const doc = `# Report\n\nSee ${image} for details.\n`;
    const rules = [ruleMissingAltText];

    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(applyAllFixes(doc, lintDocument(doc, { rules }))).toBe(doc);
    // Also unchanged when every built-in rule runs.
    const all = lintDocument(doc);
    expect(applyAllFixes(doc, all)).toContain(image);
  });

  it("autofixes an undescribed image at the start of a document", () => {
    const doc = "![](chart.png)\nSome text follows.\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].range!.from.offset).toBe(0);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("![TODO: describe image](chart.png)\nSome text follows.\n");
    expect(fixed).toContain("TODO: describe image");
    expect(fixed).toContain("(chart.png)");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
  it.each([
    ["empty alt, parenthesized destination", "![](img/chart_(1).png)"],
    ["whitespace alt, title and query", '![ ](img/chart.png?v=2#top "Chart")'],
  ])("autofixes the first-character undescribed image (%s) with the default rule set, keeping the destination and following text", (_name, image) => {
    const rest = " then *emphasis* and [a link](https://example.com).\nSecond line.\n";
    const doc = `${image}${rest}`;
    const dest = image.slice(image.indexOf("]") + 1);
    const violations = lintDocument(doc).filter((v) => v.ruleId === "missing-alt-text");

    expect(violations).toHaveLength(1);
    expect(violations[0].range!.from.offset).toBe(0);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`![TODO: describe image]${dest}${rest}`);
    expect(lintDocument(fixed).filter((v) => v.ruleId === "missing-alt-text")).toEqual(
      [],
    );
  });
  it.each([
    "my_chart.png",
    "images/my_chart_v2.png?size=2#a_b",
    "_leading_and_trailing_.png",
  ])("inserts the placeholder and preserves an underscore filename exactly (%s)", (file) => {
    const doc = `Intro.\n\nSee ![](${file}) here.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`Intro.\n\nSee ![TODO: describe image](${file}) here.\n`);
    expect(fixed).toContain(`](${file})`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("preserves bracketed prose like [1] while describing an undescribed image (line endings %j)", (nl) => {
    const doc = `Results [1] show growth, see ![](fig.png) and note [2].${nl}Also [1] again.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `Results [1] show growth, see ![TODO: describe image](fig.png) and note [2].${nl}Also [1] again.${nl}`,
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("inserts a placeholder in each of two undescribed images on separate lines without changing intervening text (line endings %j)", (nl) => {
    const doc = [
      "# Gallery",
      "",
      "First café ![](a.png) end  ",
      "Middle `![](decoy.png)` text [guide](./guide.md).",
      'Second ![](b.png?x=1#y "B") done.',
      "",
    ].join(nl);
    const expected = doc
      .replace("![](a.png)", "![TODO: describe image](a.png)")
      .replace('![](b.png?x=1#y "B")', '![TODO: describe image](b.png?x=1#y "B")');
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/TODO: describe image/g)).toHaveLength(2);
    expect(fixed).toContain("`![](decoy.png)`");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["\n", false],
    ["\r\n", false],
    ["\n", true],
    ["\r\n", true],
  ])("leaves a described image unchanged while describing the undescribed one (line endings %j, described first: %s)", (nl, describedFirst) => {
    const described = '![Sales chart](images/sales.png?v=2#top "Sales")';
    const undescribed = "![](images/costs.png)";
    const [first, second] = describedFirst
      ? [described, undescribed]
      : [undescribed, described];
    const doc = `# Report${nl}${nl}Figures: ${first} and ${second}.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      doc.replace("![](images/costs.png)", "![TODO: describe image](images/costs.png)"),
    );
    expect(fixed).toContain(described);
    expect(fixed.match(/TODO: describe image/g)).toHaveLength(1);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["raw Unicode filename", "images/日本語-café-📊.png"],
    ["raw Unicode filename with query and fragment", "images/Ünïcödé-図.png?v=2#top"],
    ["percent-encoded Unicode filename", "images/caf%C3%A9-%E6%97%A5%E6%9C%AC.png"],
  ])("preserves a Unicode image filename while inserting the placeholder (%s)", (_label, source) => {
    const image = `![](${source})`;
    const doc = `# Galerie\n\nBild café ${image} Ende.\n`;
    const expected = doc.replace("![]", "![TODO: describe image]");
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`](${source})`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["Hangul path with a space", "보고서/분기별 차트 2026.png"],
    ["Cyrillic path with a space", "отчёты/продажи диаграмма.png"],
    ["mixed scripts, spaces and emoji", "galerie/café 概要 – final 🖼.webp"],
  ])("inserts the placeholder and preserves a multi-word Unicode filename byte-for-byte (%s)", (_name, source) => {
    for (const nl of ["\n", "\r\n"]) {
      const image = `![](${source})`;
      const doc = `# Gallery${nl}${nl}See café ${image} done.${nl}`;
      const expected = `# Gallery${nl}${nl}See café ![TODO: describe image](${source}) done.${nl}`;
      const rules = [ruleMissingAltText];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("missing-alt-text");
      expect(violations[0].fix).not.toBeNull();
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(image);
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed).toContain(`](${source})`);
      expect(fixed.match(/TODO: describe image/g)).toHaveLength(1);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it.each([
    "\n",
    "\r\n",
  ])("leaves a described image and its surrounding text unchanged (line endings %j)", (nl) => {
    const doc = [
      "# Gallery",
      "",
      'Before café ![A *bar* chart](images/chart.png?view=full#data "Chart") after.  ',
      "Next [guide](./guide.md) and `![](decoy.png)` stay.",
      "",
    ].join(nl);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });

  it.each([
    ["plain", "![Chart](a.png)"],
    ["single character", "![x](a.png)"],
    ["Unicode", "![Café diagram](a.png)"],
    ["emphasis and code", "![A *bar* `chart`](a.png)"],
    ["escaped brackets", "![Figure \\[1\\]](a.png)"],
    ["placeholder text already present", "![TODO: describe image](a.png)"],
    ["with title", '![Chart](a.png "Title")'],
    ["with query and fragment", "![Chart](a.png?x=1#y)"],
  ])("control: autofix leaves an image with a nonempty description unchanged (%s)", (_name, image) => {
    const doc = `---\ntitle: Gallery\n---\n\n# Gallery\n\nBefore ${image} after.\n`;

    for (const rules of [[ruleMissingAltText], BUILTIN_RULES]) {
      const violations = lintDocument(doc, { rules });
      expect(violations.filter(({ ruleId }) => ruleId === "missing-alt-text")).toEqual(
        [],
      );
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(doc);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(doc);
    }
  });

  it("fixes only the undescribed image when it sits beside a described one", () => {
    const described = "![Chart](a.png)";
    const doc = `Both ${described} and ![](b.png) here.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(applyAllFixes(doc, violations)).toBe(
      `Both ${described} and ![TODO: describe image](b.png) here.\n`,
    );
  });

  it.each([
    "\n",
    "\r\n",
  ])("inserts a placeholder in both undescribed images repeated on one line and keeps their sources (line endings %j)", (nl) => {
    const first = '![](a.png?x=1#y "A")';
    const second = "![](b.png)";
    const doc = `# Gallery${nl}${nl}Pair café ${first} and ${second} end.${nl}`;
    const expected = `# Gallery${nl}${nl}Pair café ![TODO: describe image](a.png?x=1#y "A") and ![TODO: describe image](b.png) end.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/!\[TODO: describe image\]/g)).toHaveLength(2);
    expect(fixed).toContain('(a.png?x=1#y "A")');
    expect(fixed).toContain("(b.png)");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("describes two undescribed images in list items and a blockquote, including a repeated source (line endings %j)", (nl) => {
    const doc = [
      "- ![](shared.png)",
      '- ![](shared.png "Again") tail',
      "> ![](quoted/b.png?x=1#y)",
      "",
    ].join(nl);
    const expected = [
      "- ![TODO: describe image](shared.png)",
      '- ![TODO: describe image](shared.png "Again") tail',
      "> ![TODO: describe image](quoted/b.png?x=1#y)",
      "",
    ].join(nl);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "",
    "Intro.\r\n",
  ])("fixes an image on a final line without a trailing newline (prefix %j)", (prefix) => {
    const doc = `${prefix}![](images/chart.png)`;
    const expected = `${prefix}![TODO: describe image](images/chart.png)`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    ["", "\n"],
    [" \t ", "\r\n"],
  ])("fixes an undescribed image mid-line on a final line without a trailing newline (alt %j, line endings %j)", (alt, newline) => {
    const image = `![${alt}](images/chart.png?view=full#data "Chart")`;
    const repaired = `![TODO: describe image](images/chart.png?view=full#data "Chart")`;
    // Earlier line breaks use `newline`; the last line has no line ending, and
    // the code span's image must stay untouched.
    const doc = [
      "# Report",
      "",
      "Keep [guide](./guide.md) and `![](decoy.png)` as code.",
      `See ${image} for the summary.`,
    ].join(newline);
    const expected = [
      "# Report",
      "",
      "Keep [guide](./guide.md) and `![](decoy.png)` as code.",
      `See ${repaired} for the summary.`,
    ].join(newline);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(fixed.length - doc.length).toBe("TODO: describe image".length - alt.length);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    ["", ""],
    ["\n", ""],
    ["\n\n", ""],
    ["\r\n", "\r\n"],
    ["\n", "  "],
  ])("inserts only the placeholder for an undescribed image that ends the document (trailing %j, leading %j)", (tail, lead) => {
    const doc = `# End\n\nBody café.\n\n${lead}![](end.png "Last")${tail}`;
    const expected = `# End\n\nBody café.\n\n${lead}![TODO: describe image](end.png "Last")${tail}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Only the placeholder was added: nothing else changed, and the trailing
    // line endings survive exactly.
    expect(fixed.length - doc.length).toBe("TODO: describe image".length);
    expect(fixed.endsWith(tail)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("preserves a CRLF image line in a document with mixed line endings", () => {
    const doc =
      "Gallery introduction.\n\nSee ![](images/chart.png) for details.\r\n" +
      "Example: `![](images/chart.png)`\n";
    const expected =
      "Gallery introduction.\n\nSee ![TODO: describe image](images/chart.png) for details.\r\n" +
      "Example: `![](images/chart.png)`\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["-", "\n"],
    ["*", "\r\n"],
    ["12.", "\n"],
    ["  -", "\r\n"],
    ["- [ ]", "\n"],
  ])("fixes an image in a list item with marker %j and line ending %j", (marker, newline) => {
    const image = '![](images/chart%20one.png?view=full#data "Chart")';
    const repaired =
      '![TODO: describe image](images/chart%20one.png?view=full#data "Chart")';
    const doc = [
      "- First item",
      `${marker} See ${image} for details.`,
      "- Last item",
      "",
    ].join(newline);
    const expected = [
      "- First item",
      `${marker} See ${repaired} for details.`,
      "- Last item",
      "",
    ].join(newline);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    ["-", "  ", "\n"],
    ["3)", "   ", "\r\n"],
  ])("fixes an image in a continuation paragraph of a loose list item with marker %j and keeps text and markers (line ending %j)", (marker, indent, newline) => {
    const doc = [
      `${marker} Intro text`,
      "",
      `${indent}Figure: ![](img/a.png "A") end.`,
      "",
      `${marker} Other item`,
      "",
    ].join(newline);
    const expected = doc.replace("![]", "![TODO: describe image]");
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`${marker} Intro text`);
    expect(fixed).toContain(`${marker} Other item`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes images that start list items, nested or ordered, keeping markers and source (line endings %j)", (nl) => {
    const doc = [
      "- ![](a.png)",
      '  - ![ ](b.png?x=1#y "B") caption',
      "1. ![](c.png)",
      "- [x] ![Described](d.png)",
      "",
    ].join(nl);
    const expected = [
      "- ![TODO: describe image](a.png)",
      '  - ![TODO: describe image](b.png?x=1#y "B") caption',
      "1. ![TODO: describe image](c.png)",
      "- [x] ![Described](d.png)",
      "",
    ].join(nl);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes an image at the start while preserving following text with %j line endings", (newline) => {
    const image = "![](images/chart.png?view=full#data)";
    const following = ` — café chart.${newline}${newline}Keep this paragraph. ☕${newline}`;
    const doc = image + following;
    const expected = `![TODO: describe image](images/chart.png?view=full#data)${following}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(violations[0].range?.from.offset).toBe(0);
    expect(violations[0].range?.to.offset).toBe(image.length);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    ["", "\n"],
    ["  ", "\r\n"],
  ])("fills a titled undescribed image at document start (alt %j) and keeps the rest, including a later image, byte-identical (line endings %j)", (alt, newline) => {
    const image = `![${alt}](hero.png?w=2#top "Hero café")`;
    const rest = [
      " intro text.",
      "",
      "Later ![](later.png) and `![](decoy.png)` stay as written.",
      "",
    ].join(newline);
    const doc = image + rest;
    const expected = rest
      .replace("![](later.png)", "![TODO: describe image](later.png)")
      .replace(/^/, '![TODO: describe image](hero.png?w=2#top "Hero café")');
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(violations[0].range?.from.offset).toBe(0);
    expect(applyFix(doc, violations[0])).toBe(
      `![TODO: describe image](hero.png?w=2#top "Hero café")${rest}`,
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("`![](decoy.png)`");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["", "\n", "\n"],
    ["", "\r\n", "\r\n"],
    [" \t ", "\n", "\n\n"],
    ["", "\r\n", "\r\n\r\n"],
  ])("changes only the description of a line-ending image %j before an unrelated paragraph (%j, separator %j)", (alt, newline, separator) => {
    const image = `![${alt}](images/chart.png "Chart")`;
    const paragraph = `Unrelated paragraph: café ☕ with [a link](./guide.md) and \`![](skip-me.png)\` in code.`;
    const tail = `${separator}${paragraph}${newline}`;
    const doc = `${image}${tail}`;
    const expected = `![TODO: describe image](images/chart.png "Chart")${tail}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Everything after the image (newline(s) and paragraph) is byte-identical.
    expect(fixed.slice(fixed.length - tail.length)).toBe(tail);
    expect(fixed.length - doc.length).toBe("TODO: describe image".length - alt.length);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["", "(", "),"],
    [" \t ", "“", "”;"],
    ["", "[", "]!?"],
  ])("preserves punctuation surrounding missing alt text %j", (alt, before, after) => {
    const image = `![${alt}](images/chart%20one.png?size=2&view=full#preview)`;
    const doc = `See ${before}${image}${after} next.\r\n`;
    const expected = `See ${before}![TODO: describe image](images/chart%20one.png?size=2&view=full#preview)${after} next.\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["", "."],
    [" ", ","],
    ["\t", ";:!?"],
    ["", ')."'],
  ])("preserves punctuation following missing alt text %j: %j", (alt, punctuation) => {
    const image = `![${alt}](images/chart.png?size=2#preview)`;
    const doc = `See ${image}${punctuation} Next.\r\n`;
    const expected = `See ![TODO: describe image](images/chart.png?size=2#preview)${punctuation} Next.\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ".",
    ",",
    "!",
    "?",
    "…",
  ])("preserves trailing punctuation %j at the end of the document", (punctuation) => {
    const doc = `See ![](chart.png)${punctuation}`;
    const expected = `See ![TODO: describe image](chart.png)${punctuation}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["> ", "\n"],
    ["> ", "\r\n"],
    ["> > ", "\n"],
    ["> > ", "\r\n"],
  ])("fixes an image inside a blockquote with marker %j and line ending %j", (marker, newline) => {
    const image = '![](images/chart.png?view=full#data "Chart")';
    const doc = ["Introduction.", `${marker}See ${image} for details.`, "", ""].join(
      newline,
    );
    const expected = [
      "Introduction.",
      `${marker}See ![TODO: describe image](images/chart.png?view=full#data "Chart") for details.`,
      "",
      "",
    ].join(newline);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes two adjacent images with empty alt text on the same line", () => {
    const first = "![](./images/chart%20one.png?size=2#preview)";
    const second = '![](../assets/map.svg?view=full#north "Map")';
    const fixedFirst =
      "![TODO: describe image](./images/chart%20one.png?size=2#preview)";
    const fixedSecond =
      '![TODO: describe image](../assets/map.svg?view=full#north "Map")';
    const doc = `Gallery: ${first}${second}.\r\n`;
    const expected = `Gallery: ${fixedFirst}${fixedSecond}.\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(
      violations.map(({ range }) => doc.slice(range!.from.offset, range!.to.offset)),
    ).toEqual([first, second]);
    expect(applyFix(doc, violations[0])).toBe(`Gallery: ${fixedFirst}${second}.\r\n`);
    expect(applyFix(doc, violations[1])).toBe(`Gallery: ${first}${fixedSecond}.\r\n`);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["", "", "\n"],
    ["", " \t ", "\r\n"],
    [" \t ", "", "\n"],
    [" ", " ", "\r\n"],
  ])("fixes two images missing descriptions %j and %j on the same line while preserving intervening text with %j line endings", (firstAlt, secondAlt, newline) => {
    const first = `![${firstAlt}](./images/chart%20one.png?size=2#preview)`;
    const second = `![${secondAlt}](../assets/map.svg?view=full#north "Map")`;
    const fixedFirst =
      "![TODO: describe image](./images/chart%20one.png?size=2#preview)";
    const fixedSecond =
      '![TODO: describe image](../assets/map.svg?view=full#north "Map")';
    const between =
      " beside café — `![](decoy.png)` stays code and [the guide](./guide.md) stays a link — then ";
    const doc = `Intro ☕${newline}See ${first}${between}${second}.${newline}End.${newline}`;
    const expected = `Intro ☕${newline}See ${fixedFirst}${between}${fixedSecond}.${newline}End.${newline}`;
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(
      violations.map(({ range }) => doc.slice(range!.from.offset, range!.to.offset)),
    ).toEqual([first, second]);
    const [firstRange, secondRange] = violations.map(({ range }) => range!);
    expect(doc.slice(firstRange.to.offset, secondRange.from.offset)).toBe(between);
    expect(violations.every(({ fix }) => fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(
      `Intro ☕${newline}See ${fixedFirst}${between}${second}.${newline}End.${newline}`,
    );
    expect(applyFix(doc, violations[1])).toBe(
      `Intro ☕${newline}See ${first}${between}${fixedSecond}.${newline}End.${newline}`,
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(
      fixed.slice(
        fixed.indexOf(fixedFirst) + fixedFirst.length,
        fixed.indexOf(fixedSecond),
      ),
    ).toBe(between);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "\n",
    "\r\n",
  ])("preserves Unicode prose around an image when fixing alt text with %j line endings", (newline) => {
    const prefix = "😀 café cafe\u0301 日本語 ";
    const suffix = " مرحبا 👩🏽‍💻 שלום 🌍";
    const image = '![](images/view.png?size=2#preview "View")';
    const doc = ["前文 🚀", `${prefix}${image}${suffix}`, "終わり", ""].join(newline);
    const expected = [
      "前文 🚀",
      `${prefix}![TODO: describe image](images/view.png?size=2#preview "View")${suffix}`,
      "終わり",
      "",
    ].join(newline);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "",
    " ",
    "\u3000",
  ])("inserts the placeholder into an image missing alt text %j surrounded by Unicode prose", (alt) => {
    const image = `![${alt}](images/caf%C3%A9.png?size=2#preview "Vue")`;
    const doc = `前文「cafe\u0301」😀${image}🇯🇵後文・مرحبا、終わり\r\n`;
    const expected = `前文「cafe\u0301」😀![TODO: describe image](images/caf%C3%A9.png?size=2#preview "Vue")🇯🇵後文・مرحبا、終わり\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("![TODO: describe image](images/caf%C3%A9.png");
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "",
    " ",
    " ",
  ])("keeps invisible and format characters touching an empty-alt image %j unchanged", (alt) => {
    // ZWJ/ZWNJ, bidi marks, NBSP, U+2028/U+2029, a BOM and a lone-surrogate-free
    // astral char sit directly against the image on both sides.
    const before = "﻿مرحبا‏‍  𝔘𝔫𝔦";
    const after = " ‌‎日本語 🏳️‍🌈";
    const image = `![${alt}](img/ü.png)`;
    const neighbor = "![Ünïcödé 風景](keep.png)";
    const doc = `${before}${image}${after}\n${neighbor}\n`;
    const expected = `${before}![TODO: describe image](img/ü.png)${after}\n${neighbor}\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Only the alt text may change; both surrounding strings survive verbatim.
    expect(fixed.startsWith(before)).toBe(true);
    expect(fixed.includes(`${after}\n${neighbor}\n`)).toBe(true);
    expect(fixed.length - doc.length).toBe("TODO: describe image".length - alt.length);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it("fixes the first image without changing a following described image", () => {
    const doc = "![](first.png)\n![A mountain at sunrise](second.png)\n";
    const expected =
      "![TODO: describe image](first.png)\n![A mountain at sunrise](second.png)\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["", "\n", ""],
    ["", "\n", "\n"],
    ["", "\n", "\r\n"],
    [" \t ", "\r\n", ""],
    [" \t ", "\r\n", "\r\n"],
  ])("fixes alt text %j at the end of a document with %j lines and ending %j", (alt, newline, ending) => {
    const prefix = ["# Gallery", "", "A café view.", "", "See: "].join(newline);
    const image = `![${alt}](images/view.png?size=2#preview)`;
    const doc = `${prefix}${image}${ending}`;
    const expected = `${prefix}![TODO: describe image](images/view.png?size=2#preview)${ending}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes an earlier image without adding a final newline with %j line endings", (newline) => {
    const doc = ["Gallery: café", "![](images/view.png)", "Closing text."].join(
      newline,
    );
    const expected = [
      "Gallery: café",
      "![TODO: describe image](images/view.png)",
      "Closing text.",
    ].join(newline);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    true,
    false,
  ])("fixes an empty-alt image next to a valid link (image first: %s)", (imageFirst) => {
    const image = "![](images/chart.png?size=2#data)";
    const repaired = "![TODO: describe image](images/chart.png?size=2#data)";
    const link = '[guide](./guide.md?view=full#images "Guide")';
    const doc = `See ${imageFirst ? image : link} ${imageFirst ? link : image}.\r\n`;
    const expected = `See ${imageFirst ? repaired : link} ${imageFirst ? link : repaired}.\r\n`;
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    true,
    false,
  ])("preserves a described image sharing a source with an image needing a fix (described first: %s)", (describedFirst) => {
    const source = "images/caf%C3%A9.png?size=2#preview";
    const described = `![Café terrace at sunset](${source})`;
    const empty = `![](${source})`;
    const repaired = `![TODO: describe image](${source})`;
    const doc = `${describedFirst ? described : empty} and ${describedFirst ? empty : described}.\n`;
    const expected = `${describedFirst ? described : repaired} and ${describedFirst ? repaired : described}.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(empty);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it("preserves a described image and its destination while fixing neighboring images", () => {
    const image =
      '![Café terrace at sunset ☕](images/caf%C3%A9.jpg?size=2&format=webp#view "Terrace")';
    const doc = `Before ![](first.png), ${image}, then ![  ](last.png).\r\n`;
    const expected =
      `Before ![TODO: describe image](first.png), ${image}, ` +
      "then ![TODO: describe image](last.png).\r\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes only the undescribed image in a list and keeps a padded-alt described image byte-identical (line endings %j)", (newline) => {
    // The described alt has edge spaces and a literal TODO: only an empty or
    // whitespace-only alt counts as undescribed.
    const described = '![ TODO: chart of café sales ](sales.png?v=2#top "Sales")';
    const undescribed = '![ \t](trend.png "Trend")';
    const repaired = '![TODO: describe image](trend.png "Trend")';
    const layout = (middle: string) =>
      ["- Intro `![](decoy.png)`", `- ${described}`, `- ${middle}`, ""].join(newline);
    const doc = layout(undescribed);
    const expected = layout(repaired);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(undescribed);
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(described);
    expect(fixed).toContain("`![](decoy.png)`");
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    [true, "\n"],
    [true, "\r\n"],
    [false, "\n"],
    [false, "\r\n"],
  ])("adds the placeholder only to the undescribed image on separate lines (described first: %s, line endings %j)", (describedFirst, newline) => {
    const described =
      '![A café terrace at sunrise ☕](../assets/caf%C3%A9.jpg?size=2&format=webp#view "Terrace")';
    const undescribed = '![](images/chart.png?view=full#data "Chart")';
    const repaired = '![TODO: describe image](images/chart.png?view=full#data "Chart")';
    const images = describedFirst ? [described, undescribed] : [undescribed, described];
    const fixedImages = describedFirst ? [described, repaired] : [repaired, described];
    const layout = (pair: string[]) =>
      [
        "---",
        "title: Gallery",
        "---",
        "",
        "# Café gallery",
        "",
        "Intro keeps [guide](./guide.md) and `![](decoy.png)` as code.",
        `Before ${pair[0]} after.`,
        `Then ${pair[1]} too.`,
        "",
      ].join(newline);
    const doc = layout(images);
    const expected = layout(fixedImages);
    // The full default rule set must see exactly the undescribed image:
    // the described image, the decoy code span and the valid link stay clean.
    const violations = lintDocument(doc);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(undescribed);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The described image survives byte-identical, shifted only by the
    // placeholder text when it follows the repaired image.
    expect(fixed.indexOf(described)).toBe(
      doc.indexOf(described) + (describedFirst ? 0 : "TODO: describe image".length),
    );
    expect(fixed.length - doc.length).toBe("TODO: describe image".length);
    const remaining = lintDocument(fixed);
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

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

  it("applies applyAllFixes with default rules and leaves a valid described image unchanged", () => {
    const doc =
      "See ![A flowing river at sunset](photos/river-sunset.jpg) for the view.\n";
    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(doc, { rules });
    expect(violations).toEqual([]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(doc);
  });

  it.each([
    "\n",
    "\r\n",
  ])("keeps a described image byte-for-byte unchanged while autofix rewrites the rest of its line (%j line endings)", (newline) => {
    const described =
      '![A café *chart* — v2](images/chart%20one.png?size=2&view=full#preview "Chart")';
    const doc = [
      `See ${described} and [draft](), then ![](diagram.svg)   `,
      "",
      "Tail keeps `[draft]()` code.",
      "",
    ].join(newline);
    const expected = [
      `See ${described} and [draft](TODO), then ![TODO: describe image](diagram.svg)`,
      "",
      "Tail keeps `[draft]()` code.",
      "",
    ].join(newline);
    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
      "no-trailing-spaces",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The described image survives verbatim while everything around it changed.
    expect(fixed.indexOf(described)).toBe(fixed.lastIndexOf(described));
    expect(fixed).toContain(described);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
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

  it("fixes only an empty alt across lines while preserving both image sources", () => {
    const doc =
      "Café: ![A garden map](../assets/map.svg?view=full#north)\r\n" +
      'Diagram: ![](https://example.com/a%20b.png?size=2&theme=dark#preview "Diagram")\r\n';
    const expected =
      "Café: ![A garden map](../assets/map.svg?view=full#north)\r\n" +
      'Diagram: ![TODO: describe image](https://example.com/a%20b.png?size=2&theme=dark#preview "Diagram")\r\n';
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(
      '![](https://example.com/a%20b.png?size=2&theme=dark#preview "Diagram")',
    );
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
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

  it("autofixes a whitespace-only alt description with a single space and preserves the plain source", () => {
    const doc = "See ![ ](images/photo.jpg) here.\n";
    const expected = "See ![TODO: describe image](images/photo.jpg) here.\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("](images/photo.jpg)");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes the documented whitespace-only image alt example", () => {
    const doc = "See ![  ](chart.png?view=full#data).\n";
    const expected = "See ![TODO: describe image](chart.png?view=full#data).\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
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

  it.each([
    "\t",
    " \t ",
    "　",
  ])("inserts the placeholder for whitespace-only description %j while preserving the destination", (alt) => {
    const source = '../assets/caf%C3%A9%20chart.png?size=2&lang=fr#view "Café chart"';
    const image = `![${alt}](${source})`;
    const doc = `Before café: ${image} after.\r\n`;
    const expected = `Before café: ![TODO: describe image](${source}) after.\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it("autofix inserts a TODO placeholder", () => {
    const doc = "See ![](diagram.png) for context.\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toContain("![TODO: describe image](diagram.png)");
    expect(fixed).not.toContain("![](diagram.png)");
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes a later image without changing unrelated lines with %j line endings", (newline) => {
    const before =
      ["# Café gallery", "Example: `![](diagram.png)`  ", ""].join(newline) + newline;
    const after = newline + ["", "Keep\tthis spacing.  ", "Last line."].join(newline);
    const doc = `${before}See ![](diagram.png) for context.${after}`;
    const expected = `${before}See ![TODO: describe image](diagram.png) for context.${after}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].range?.from.line).toBe(4);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes missing image alt text in a blockquote with %j line endings", (newline) => {
    const source = "../images/chart%20one.png?size=2#preview";
    const image = `![](${source})`;
    const doc = [
      "Before the quote.",
      "",
      `> See ${image} for details.`,
      "> More context.",
      "",
      "After the quote.",
      "",
    ].join(newline);
    const expected = [
      "Before the quote.",
      "",
      `> See ![TODO: describe image](${source}) for details.`,
      "> More context.",
      "",
      "After the quote.",
      "",
    ].join(newline);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
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

  it("preserves the complete query string when fixing an empty image alt", () => {
    const doc =
      "Before ![](https://example.com/chart.png?label=North%20%26%20South&size=2&size=4&empty=&view=full+detail) after.\n";
    const expected =
      "Before ![TODO: describe image](https://example.com/chart.png?label=North%20%26%20South&size=2&size=4&empty=&view=full+detail) after.\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
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

  it.each([
    ["", ""],
    ["", "\n"],
    ["", "\r\n"],
    [" \t ", ""],
    [" \t ", "\n"],
    [" \t ", "\r\n"],
  ])("is idempotent for image alt %j with ending %j", (alt, ending) => {
    const doc = `Before ![${alt}](images/chart.png?size=2#preview) after.${ending}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    expect(violations[0].fix).not.toBeNull();

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(
      `Before ![TODO: describe image](images/chart.png?size=2#preview) after.${ending}`,
    );
    const remaining = lintDocument(once, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(once, remaining)).toBe(once);
  });

  it.each([
    ["heading", "# Chart ![](a.png) overview\n"],
    ["blockquote", "> Quote ![ ](a.png)\n> more ![](b.png)\n"],
    ["table cell", "| Pic |\n| --- |\n| ![](a.png) |\n"],
    ["adjacent images", "![](a.png)![\t](b.png) ![](c.png)\n"],
  ])("re-linting and fixing an undescribed image in a %s changes nothing the second time", (_label, doc) => {
    const rules = [ruleMissingAltText];
    const fixOnce = (text: string) =>
      applyAllFixes(text, lintDocument(text, { rules }));

    const once = fixOnce(doc);
    expect(once).not.toBe(doc);
    expect(once).not.toMatch(/!\[\s*\]/);
    expect(lintDocument(once, { rules })).toEqual([]);
    expect(fixOnce(once)).toBe(once);
  });

  it.each([
    "\n",
    "\r\n",
  ])("is idempotent for undescribed images among code decoys, a described image and a remaining warning with %j line endings", (newline) => {
    const undescribed = "![](images/chart.png?size=2#preview)";
    const whitespaceAlt = '![ \t ](map.svg "Map")';
    const decoys = [
      "`![](decoy.png)` stays code",
      "```md",
      "![](fenced.png) stays inside the fence.",
      "```",
    ];
    const lines = [
      "---",
      "title: Café gallery",
      "---",
      "",
      "# Café gallery",
      "",
      "## Details",
      "",
      `Intro café ☕ keeps [guide](./guide.md) and ${decoys[0]}.`,
      "",
      `See ${undescribed} beside ![A chart](described.png).`,
      `Then ${whitespaceAlt} and ![TODO: describe image](existing.png).`,
      "",
      ...decoys.slice(1),
      "",
    ];
    const doc = lines.join(newline);
    const expected = lines
      .map((line) =>
        line
          .replace(
            undescribed,
            "![TODO: describe image](images/chart.png?size=2#preview)",
          )
          .replace(whitespaceAlt, '![TODO: describe image](map.svg "Map")'),
      )
      .join(newline);
    const rules = [
      ruleNoTrailingSpaces,
      ruleOrphanedHeading,
      ruleMissingAltText,
      ruleInvalidLinkTarget,
    ];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "orphaned-heading",
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(violations.filter((violation) => violation.fix !== null)).toHaveLength(2);

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(expected);
    expect(once).not.toBe(doc);

    // Second pass: only the unfixable orphaned-heading warning remains, so
    // applying fixes again must be a no-op on the text.
    const remaining = lintDocument(once, { rules });
    expect(remaining.map((violation) => violation.ruleId)).toEqual([
      "orphaned-heading",
    ]);
    expect(remaining[0].fix).toBeNull();
    expect(applyAllFixes(once, remaining)).toBe(once);

    // The whole lint-and-fix pipeline run twice from the original document
    // reaches the same fixpoint as a single pass.
    const fixPass = (text: string) =>
      applyAllFixes(text, lintDocument(text, { rules }));
    expect(fixPass(fixPass(doc))).toBe(once);

    // Fix All (the UI autofix path) likewise records no new history on a
    // second pass.
    clearLintHistory();
    expect(fixAllViolations(doc, violations)).toBe(once);
    const history = [...getLintHistory()];
    expect(history.map((entry) => entry.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(fixAllViolations(once, remaining)).toBe(once);
    expect(getLintHistory()).toEqual(history);
  });

  it.each([
    "\n",
    "\r\n",
  ])("keeps an image fix stable with all built-in rules and %j line endings", (newline) => {
    const doc = [
      "---",
      "title: Image guide",
      "---",
      "",
      "# Image guide",
      "",
      "See ![](images/chart.png?size=2#preview) beside ![A map](images/map.svg).",
      "",
    ].join(newline);
    const violations = lintDocument(doc);
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    expect(violations[0].fix).not.toBeNull();

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(doc.replace("![]", "![TODO: describe image]"));
    const remaining = lintDocument(once);
    expect(remaining).toEqual([]);
    expect(applyAllFixes(once, remaining)).toBe(once);
  });

  it("keeps a missing-alt fix stable across default-rule passes with a remaining warning", () => {
    const doc = "# First\n\n## Second\n\nSee ![](chart.png).   \n";
    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId).sort()).toEqual([
      "missing-alt-text",
      "no-trailing-spaces",
      "orphaned-heading",
    ]);

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(
      "# First\n\n## Second\n\nSee ![TODO: describe image](chart.png).\n",
    );
    const remaining = lintDocument(once, { rules });
    expect(remaining.map((violation) => violation.ruleId)).toEqual([
      "orphaned-heading",
    ]);
    expect(remaining[0].fix).toBeNull();
    expect(applyAllFixes(once, remaining)).toBe(once);
  });

  it.each([
    "\n",
    "\r\n",
  ])("keeps image alt placeholders stable with a remaining warning and %j line endings", (newline) => {
    const doc = [
      "# First",
      "",
      "## Second",
      "",
      "See ![](images/chart.png?size=2#preview) and ![TODO: describe image](existing.png).",
      "Then see ![ \t ](images/map.svg) and ![A diagram](diagram.svg).",
      "",
    ].join(newline);
    const expected = [
      "# First",
      "",
      "## Second",
      "",
      "See ![TODO: describe image](images/chart.png?size=2#preview) and ![TODO: describe image](existing.png).",
      "Then see ![TODO: describe image](images/map.svg) and ![A diagram](diagram.svg).",
      "",
    ].join(newline);
    const rules = [ruleOrphanedHeading, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "orphaned-heading",
      "missing-alt-text",
      "missing-alt-text",
    ]);

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(expected);
    const remaining = lintDocument(once, { rules });
    expect(remaining.map((violation) => violation.ruleId)).toEqual([
      "orphaned-heading",
    ]);
    expect(remaining[0].fix).toBeNull();
    expect(applyAllFixes(once, remaining)).toBe(once);
  });

  it.each([
    '"Café chart"',
    "'Café chart'",
  ])("preserves an image destination and title %s across autofix passes", (title) => {
    const destination = `images/caf%C3%A9.png?size=2#preview ${title}`;
    const doc = `See ![](${destination}) for details.`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    const once = applyAllFixes(doc, violations);
    expect(once).toBe(`See ![TODO: describe image](${destination}) for details.`);
    const remaining = lintDocument(once, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(once, remaining)).toBe(once);
  });

  it("keeps multiple empty-alt image fixes unchanged on a second default-rule pass", () => {
    const doc =
      "---\r\ntitle: Images\r\n---\r\n\r\n" +
      "See ![](images/chart.png?size=2#preview) and ![A map](map.svg).\r\n" +
      "Then see ![](images/graph.png) and [the guide](./guide.md).\r\n";
    const violations = lintDocument(doc);
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(
      "---\r\ntitle: Images\r\n---\r\n\r\n" +
        "See ![TODO: describe image](images/chart.png?size=2#preview) and ![A map](map.svg).\r\n" +
        "Then see ![TODO: describe image](images/graph.png) and [the guide](./guide.md).\r\n",
    );
    const remaining = lintDocument(once);
    expect(remaining).toEqual([]);
    expect(applyAllFixes(once, remaining)).toBe(once);
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

  it("fixes only the whitespace-only alt when adjacent images share a literal destination", () => {
    const src = "images/chart$&$1.png?size=2#preview";
    const doc = `Before ![ \t ](${src})![Chart](${src}) after.\n`;
    const expected = `Before ![TODO: describe image](${src})![Chart](${src}) after.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`![ \t ](${src})`);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("preserves an absolute image source and title when fixing whitespace-only alt text", () => {
    const doc =
      'See ![ \t ](https://example.com/image.png?size=2#preview "Image title") here.\n';
    const expected =
      'See ![TODO: describe image](https://example.com/image.png?size=2#preview "Image title") here.\n';
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
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

  it.each([
    "\n",
    "\r\n",
  ])("autofixes whitespace-only alt text that spans a line break (%j) and keeps the source on its own line", (nl) => {
    const doc = `Intro café.${nl}See ![ ${nl} ](images/chart.png?size=2#preview "Chart") now.${nl}`;
    const expected = `Intro café.${nl}See ![TODO: describe image](images/chart.png?size=2#preview "Chart") now.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("autofixes an image while preserving its source and surrounding prose", () => {
    const source = "../images/chart%20one.png?size=2&view=full#preview";
    const doc =
      `Opening paragraph.\r\n\r\nSee ![](${source}) for the café report.\r\n` +
      "\r\nClosing paragraph with  spacing.\r\n";
    const expected =
      "Opening paragraph.\r\n\r\n" +
      "See ![TODO: describe image](../images/chart%20one.png?size=2&view=full#preview) for the café report.\r\n" +
      "\r\nClosing paragraph with  spacing.\r\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`](${source})`);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it("preserves the text before and after an empty-alt image exactly, metacharacters included", () => {
    const before = "Costs $5 and $10; `![](decoy.png)` in code; wow! ";
    const src = "img$&$'$`$1.png?x=$2#frag";
    const after = " then $`tail$ and [x](y.md) stay.\n";
    const doc = `${before}![](${src})${after}`;
    const repaired = `![TODO: describe image](${src})`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`![](${src})`);
    expect(doc.slice(0, from.offset)).toBe(before);
    expect(doc.slice(to.offset)).toBe(after);

    const expected = `${before}${repaired}${after}`;
    for (const fixed of [
      applyFix(doc, violations[0]),
      applyAllFixes(doc, violations),
    ]) {
      expect(fixed.slice(0, before.length)).toBe(before);
      expect(fixed.slice(before.length + repaired.length)).toBe(after);
      expect(fixed).toBe(expected);
    }
    expect(lintDocument(expected, { rules })).toEqual([]);
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

  it("preserves a Unicode filename when fixing an image and a later link", () => {
    const source = "images/cafe\u0301-星🌟.png?size=2#preview";
    const doc = `See ![](${source}) and [details]().\r\n`;
    const expected = `See ![TODO: describe image](${source}) and [details](TODO).\r\n`;
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(
      `See ![TODO: describe image](${source}) and [details]().\r\n`,
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it("preserves literal and percent-encoded Unicode filenames independently", () => {
    const doc =
      "😀 ![](images/café-星.png) beside ![](images/caf%C3%A9-%E6%98%9F.png)\r\n";
    const expected =
      "😀 ![TODO: describe image](images/café-星.png) beside ![TODO: describe image](images/caf%C3%A9-%E6%98%9F.png)\r\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(
      "😀 ![TODO: describe image](images/café-星.png) beside ![](images/caf%C3%A9-%E6%98%9F.png)\r\n",
    );
    expect(applyFix(doc, violations[1])).toBe(
      "😀 ![](images/café-星.png) beside ![TODO: describe image](images/caf%C3%A9-%E6%98%9F.png)\r\n",
    );
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    // Composed (NFC) accents with a CJK directory, query and fragment.
    "galerie/café-大学.png?größe=2#vorschau",
    // The same file name decomposed (NFD), as macOS file systems store it.
    "galerie/cafe\u0301-大学.png?gro\u0308ße=2#vorschau",
    // An emoji ZWJ sequence and a right-to-left script in the path.
    "相册/familie-👨‍👩‍👧‍👦-תמונה.webp#预览",
    // A quoted Unicode title is part of the preserved destination.
    'assets/星空.png?t=夜 "タイトル 🌃"',
  ])("preserves a Unicode image source %j exactly when fixing an empty alt", (src) => {
    const doc = `Résumé ☕ before ![](${src}) après.\n`;
    const expected = `Résumé ☕ before ![TODO: describe image](${src}) après.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`![](${src})`);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("keeps each normalization form when empty-alt sources differ only by composition", () => {
    // macOS stores file names decomposed: the sources render identically but
    // are different strings, and each fix must preserve its own bytes.
    const nfc = "images/café.png";
    const nfd = "images/cafe\u0301.png";
    expect(nfd.normalize("NFC")).toBe(nfc);
    const doc = `Twins ![](${nfc}) and ![](${nfd}).\n`;
    const expected = `Twins ![TODO: describe image](${nfc}) and ![TODO: describe image](${nfd}).\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(
      `Twins ![TODO: describe image](${nfc}) and ![](${nfd}).\n`,
    );
    expect(applyFix(doc, violations[1])).toBe(
      `Twins ![](${nfc}) and ![TODO: describe image](${nfd}).\n`,
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(fixed);
  });

  it("inserts the placeholder and keeps a long Unicode filename that the message truncates", () => {
    // >40 UTF-16 code units: the message shows an excerpt (with a surrogate
    // pair inside it), but the fix must still splice in the destination whole.
    const src = "images/桜🌸-長いファイル名-2026年-最終版-保存用-写真データ.png";
    expect(src.length).toBeGreaterThan(40);
    const doc = `See ![](${src}) for the report.\n`;
    const expected = `See ![TODO: describe image](${src}) for the report.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].message).toBe(
      `Image is missing alt text: ${src.slice(0, 37)}…`,
    );
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`![](${src})`);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`](${src})`);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
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
    "\n",
    "\r\n",
  ])("fixes a later image while preserving earlier mentions of its source with %j line endings", (newline) => {
    const source = "images/chart%20one.png?view=full#data";
    const prefix =
      ["# Report", `Source: ${source}`, "Café 😀  notes.", ""].join(newline) + newline;
    const suffix = `${newline}End of report.${newline}`;
    const doc = `${prefix}See ![](${source}) for details.${suffix}`;
    const expected = `${prefix}See ![TODO: describe image](${source}) for details.${suffix}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`![](${source})`);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
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

  it.each([
    "\n",
    "\r\n",
  ])("preserves the prose before an empty-alt image at the end of a %j line", (newline) => {
    const src = "images/line-end.png?size=2#preview";
    const prose = `Ends with [a link](./guide.md#top) and ![A map](map.svg) then `;
    const lastLine = "Trailing paragraph keeps its  spacing.";
    const doc = [`${prose}![](${src})`, lastLine, ""].join(newline);
    const expected = [`${prose}![TODO: describe image](${src})`, lastLine, ""].join(
      newline,
    );
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    expect(doc.slice(0, from.offset)).toBe(prose);
    expect(doc.slice(from.offset, to.offset)).toBe(`![](${src})`);
    expect(doc.slice(to.offset)).toBe(`${newline}${lastLine}${newline}`);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
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
    [
      "![ \t ](shared.png)![A cat](shared.png)",
      "![TODO: describe image](shared.png)![A cat](shared.png)",
    ],
    [
      "![A cat](shared.png)![ \t ](shared.png)",
      "![A cat](shared.png)![TODO: describe image](shared.png)",
    ],
  ])("fixes only the missing alt in adjacent images: %s", (doc, expected) => {
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toHaveLength(0);
  });

  it.each([
    true,
    false,
  ])("preserves distinct destinations beside a described image (described first: %s)", (describedFirst) => {
    const described = '![A café map](../images/map%20one.svg?view=full#north "Map")';
    const missing = '![](images/chart.png?size=2#data "Chart")';
    const repaired = '![TODO: describe image](images/chart.png?size=2#data "Chart")';
    const doc = `Before ${describedFirst ? described : missing} ${describedFirst ? missing : described} after.\r\n`;
    const expected = `Before ${describedFirst ? described : repaired} ${describedFirst ? repaired : described} after.\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(missing);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    true,
    false,
  ])("fixes only the undescribed image next to a described linked image (described first: %s)", (describedFirst) => {
    const described =
      '[![A coverage badge](../assets/coverage%20badge.svg?branch=main#badge "Coverage")](https://example.com/builds)';
    const missing = "![](images/thumb.png?size=2#full)";
    const repaired = "![TODO: describe image](images/thumb.png?size=2#full)";
    const doc = `See ${describedFirst ? described : missing} and ${describedFirst ? missing : described}.\r\n`;
    const expected = `See ${describedFirst ? described : repaired} and ${describedFirst ? repaired : described}.\r\n`;
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(missing);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The described image — alt, link wrapper and both destinations — is byte-identical.
    expect(fixed).toContain(described);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it("adds the placeholder inside a linked image while preserving its href and a described neighbor", () => {
    const linked = "[![](images/thumb.png?size=2#full)](https://example.com/full.png)";
    const repaired =
      "[![TODO: describe image](images/thumb.png?size=2#full)](https://example.com/full.png)";
    const described = '![A garden map](../assets/map.svg?view=full#north "Map")';
    const doc = `Before ${linked} after ${described}.\r\n`;
    const expected = `Before ${repaired} after ${described}.\r\n`;
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("![](images/thumb.png?size=2#full)");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(described);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes both images in a paragraph with %j line endings", (newline) => {
    const first = "![](images/a.png?size=2#preview)";
    const second = "![](../assets/b.svg)";
    const fixedFirst = "![TODO: describe image](images/a.png?size=2#preview)";
    const fixedSecond = "![TODO: describe image](../assets/b.svg)";
    const doc = `Before ${first}, example \`${first}\`, and ${second} after.${newline}`;
    const expected = `Before ${fixedFirst}, example \`${first}\`, and ${fixedSecond} after.${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(
      violations.map(({ range }) => doc.slice(range!.from.offset, range!.to.offset)),
    ).toEqual([first, second]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(
      `Before ${fixedFirst}, example \`${first}\`, and ${second} after.${newline}`,
    );
    expect(applyFix(doc, violations[1])).toBe(
      `Before ${first}, example \`${first}\`, and ${fixedSecond} after.${newline}`,
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it("fixes every empty alt when image targets repeat across lines", () => {
    const repeated = "https://example.com/chart.png?size=2&lang=en#preview";
    const other = "../assets/map%20one.svg";
    const doc =
      `Café: ![](${repeated}) and ![A map](${other}).\r\n` +
      `Again ![](${repeated}) next to ![](${other}).\r\n`;
    const expected =
      `Café: ![TODO: describe image](${repeated}) and ![A map](${other}).\r\n` +
      `Again ![TODO: describe image](${repeated}) next to ![TODO: describe image](${other}).\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(
      violations.map(({ range }) => doc.slice(range!.from.offset, range!.to.offset)),
    ).toEqual([`![](${repeated})`, `![](${repeated})`, `![](${other})`]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes each undescribed image inside repeated prose while keeping its distinct source (%j line endings)", (newline) => {
    const prose = "Café ☕ — the same caption words repeat here.";
    const first = "![](images/chart%20one.png?size=2#preview)";
    const second = '![](../assets/map.svg?view=full#north "Map")';
    const firstFixed = "![TODO: describe image](images/chart%20one.png?size=2#preview)";
    const secondFixed =
      '![TODO: describe image](../assets/map.svg?view=full#north "Map")';
    const caption = (image: string) => `${prose} ${image} ${prose}`;
    const doc = [caption(first), prose, `${caption(second)}.`, ""].join(newline);
    const expected = [caption(firstFixed), prose, `${caption(secondFixed)}.`, ""].join(
      newline,
    );
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(
      violations.map(({ range }) => doc.slice(range!.from.offset, range!.to.offset)),
    ).toEqual([first, second]);
    expect(violations.every(({ fix }) => fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(
      [caption(firstFixed), prose, `${caption(second)}.`, ""].join(newline),
    );
    expect(applyFix(doc, violations[1])).toBe(
      [caption(first), prose, `${caption(secondFixed)}.`, ""].join(newline),
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(fixed.match(/TODO: describe image/g)).toHaveLength(2);
    // The five prose repetitions survive the fixes verbatim.
    expect(fixed.split(prose)).toHaveLength(6);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
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

  it.each([
    ["\n", "\n"],
    ["\r\n", "\r\n"],
    ["\n", "\r\n"],
    ["\r\n", "\n"],
    ["\n\n", "\r\n\r\n"],
  ])("inserts both placeholders for empty-alt images on separate lines and keeps line breaks %j and %j", (firstBreak, secondBreak) => {
    const first = "images/first.png?size=2#preview";
    const second = "images/second.png";
    const trailing = "text ";
    const doc = `![](${first})${firstBreak}![](${second})${secondBreak}${trailing}`;
    const expected = `![TODO: describe image](${first})${firstBreak}![TODO: describe image](${second})${secondBreak}${trailing}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/TODO: describe image/g)).toHaveLength(2);
    const breaks = (text: string) => text.match(/\r\n|\n|\r/g);
    expect(breaks(fixed)).toEqual(breaks(doc));
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes two images missing descriptions on separate lines, each keeping its source (%j line endings)", (newline) => {
    const firstSrc = './images/chart%20one.png?size=2#preview "Chart"';
    const secondSrc = "../assets/map.svg?view=full#north";
    const first = `![](${firstSrc})`;
    const second = `![ \t ](${secondSrc})`;
    const fixedFirst = `![TODO: describe image](${firstSrc})`;
    const fixedSecond = `![TODO: describe image](${secondSrc})`;
    const lines = [
      "Gallery opener.",
      `See ${first} for the chart.`,
      "Between the images.",
      `Then ${second} for the map.`,
      "Gallery closer.",
      "",
    ];
    const doc = lines.join(newline);
    const expected = [
      "Gallery opener.",
      `See ${fixedFirst} for the chart.`,
      "Between the images.",
      `Then ${fixedSecond} for the map.`,
      "Gallery closer.",
      "",
    ].join(newline);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(violations.map(({ range }) => range?.from.line)).toEqual([2, 4]);
    expect(
      violations.map(({ range }) => doc.slice(range!.from.offset, range!.to.offset)),
    ).toEqual([first, second]);
    expect(violations.every(({ fix }) => fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(doc.replace(first, fixedFirst));
    expect(applyFix(doc, violations[1])).toBe(doc.replace(second, fixedSecond));
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    // Both sources survive verbatim and each placeholder appears exactly once.
    expect(fixed.match(/TODO: describe image/g)).toHaveLength(2);
    expect(fixed).toContain(`](${firstSrc})`);
    expect(fixed).toContain(`](${secondSrc})`);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it("autofixes adjacent images with empty alt text and preserves both sources", () => {
    const doc = "Café: ![](images/first.png)![](images/second.jpg?size=2#preview).\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(
      violations.map(({ range }) => doc.slice(range!.from.offset, range!.to.offset)),
    ).toEqual(["![](images/first.png)", "![](images/second.jpg?size=2#preview)"]);
    expect(applyFix(doc, violations[0])).toBe(
      "Café: ![TODO: describe image](images/first.png)![](images/second.jpg?size=2#preview).\n",
    );
    expect(applyFix(doc, violations[1])).toBe(
      "Café: ![](images/first.png)![TODO: describe image](images/second.jpg?size=2#preview).\n",
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Café: ![TODO: describe image](images/first.png)![TODO: describe image](images/second.jpg?size=2#preview).\n",
    );
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toHaveLength(0);
    expect(applyAllFixes(fixed, remaining)).toBe(fixed);
  });

  it("fixes each adjacent empty-alt image when their sources are identical", () => {
    const doc = "Before ![](images/chart.png)![](images/chart.png) after.\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(
      "Before ![TODO: describe image](images/chart.png)![](images/chart.png) after.\n",
    );
    expect(applyFix(doc, violations[1])).toBe(
      "Before ![](images/chart.png)![TODO: describe image](images/chart.png) after.\n",
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Before ![TODO: describe image](images/chart.png)![TODO: describe image](images/chart.png) after.\n",
    );
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
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

  it.each([
    ["list item", "- "],
    ["blockquote", "> "],
  ])("fills three undescribed images on one %s line, skipping the described one between them", (_name, marker) => {
    const doc = `${marker}A ![](a.png) B ![Kept](k.png "K") C ![ ](b.png?x=1#y) D ![](c.png) E.\n`;
    const expected = `${marker}A ![TODO: describe image](a.png) B ![Kept](k.png "K") C ![TODO: describe image](b.png?x=1#y) D ![TODO: describe image](c.png) E.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(3);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/!\[TODO: describe image\]/g)).toHaveLength(3);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("gives each of several invalid images the placeholder while retaining its own source", () => {
    const images = [
      { alt: "", src: "images/first.png" },
      { alt: " \t ", src: "../assets/map%20two.svg#view" },
      { alt: "\u00a0", src: 'example.com/pic.webp "Pic title"' },
    ];
    const doc =
      `Gallery: ![](${images[0].src}) with ![A map](map.svg),\n` +
      `then ![${images[1].alt}](${images[1].src}),\n` +
      `and ![${images[2].alt}](${images[2].src}) at the end.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    for (const [i, { alt, src }] of images.entries()) {
      expect(violations[i].message).toBe(`Image is missing alt text: ${src}`);
      const { from, to } = violations[i].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(`![${alt}](${src})`);

      // A single fix repairs only its own image and leaves the others untouched.
      const once = applyFix(doc, violations[i]);
      expect(once).toContain(`![TODO: describe image](${src})`);
      expect(once).not.toContain(`![${alt}](${src})`);
      for (const [j, other] of images.entries()) {
        if (j !== i) expect(once).toContain(`![${other.alt}](${other.src})`);
      }
    }

    const expected =
      `Gallery: ![TODO: describe image](${images[0].src}) with ![A map](map.svg),\n` +
      `then ![TODO: describe image](${images[1].src}),\n` +
      `and ![TODO: describe image](${images[2].src}) at the end.\n`;
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.split("TODO: describe image")).toHaveLength(images.length + 1);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it("does not flag images with non-empty alt text", () => {
    const doc = "![My diagram](diagram.png)\n";
    expect(lintDocument(doc, { rules: [ruleMissingAltText] })).toHaveLength(0);
  });

  it.each([
    "\n",
    "\r\n",
  ])("inserts the documented placeholder into an invalid image followed by valid prose, line ending %j", (newline) => {
    const prose =
      "The chart above shows **quarterly** results; " +
      "see [the report](./report.md) for details.";
    const doc = ["![](images/chart.png?size=2#preview)", "", prose, ""].join(newline);
    const expected = [
      "![TODO: describe image](images/chart.png?size=2#preview)",
      "",
      prose,
      "",
    ].join(newline);
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith(`${prose}${newline}`)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["images/chart%20one.png?size=2&format=webp&empty=#preview", "", "\n"],
    ['./assets/map.svg?view=full&lang=fr "Map"', " \t ", "\r\n"],
    ["https://example.com/a%20b.png?tag=one&tag=two#section", "", "\r\n"],
    ["images/thumb.png?size=2", " ", "\n"],
  ])("preserves an image source containing a query string when fixing alt text %j with %j line endings (%s)", (source, alt, newline) => {
    const image = `![${alt}](${source})`;
    const repaired = `![TODO: describe image](${source})`;
    const prefix = ["---", "title: Gallery", "---", "", "Intro café.", ""].join(
      newline,
    );
    const doc = `${prefix}${newline}See ${image} for details.${newline}`;
    const expected = `${prefix}${newline}See ${repaired} for details.${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Query string, fragment and title arrive byte-identical.
    expect(fixed).toContain(`](${source})`);
    expect(fixed.length - doc.length).toBe("TODO: describe image".length - alt.length);
    // The full default rule set must not rewrite the source either.
    expect(applyAllFixes(doc, lintDocument(doc))).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "\n",
    "\r\n",
  ])("diagnostic: the repaired alt text is exactly 'TODO: describe image' and the surrounding text is preserved (%j line endings)", (newline) => {
    const before = ["# Gallery", "", "Intro café — see"].join(newline);
    const image = '![](images/chart.png?size=2#preview "Chart")';
    const repaired = '![TODO: describe image](images/chart.png?size=2#preview "Chart")';
    const after = [
      "for the quarterly numbers.",
      "",
      "Closing note: `![](decoy.png)` stays code.",
      "",
    ].join(newline);
    const doc = `${before}${newline}${image} ${after}`;
    const expected = `${before}${newline}${repaired} ${after}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Diagnostic: the inserted alt text is byte-exactly the placeholder.
    const altMatch = fixed.match(/!\[([^\]]*)\]\(images\/chart\.png[^)]*\)/);
    expect(altMatch).not.toBeNull();
    expect(altMatch![1]).toBe("TODO: describe image");
    // The text before and after the image is byte-identical.
    expect(fixed.slice(0, from.offset)).toBe(doc.slice(0, from.offset));
    expect(fixed.slice(from.offset + repaired.length)).toBe(doc.slice(to.offset));
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes an undescribed image as the sole content on its own line at the end of a document with %j line endings", (newline) => {
    const doc = `# Gallery${newline}${newline}Summary of the collection.${newline}${newline}![](images/hero.png)`;
    const expected = `# Gallery${newline}${newline}Summary of the collection.${newline}${newline}![TODO: describe image](images/hero.png)`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    // Source is preserved in the diagnostic message.
    expect(violations[0].message).toBe("Image is missing alt text: images/hero.png");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    // Source URL must survive the fix intact.
    expect(fixed).toContain("images/hero.png");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes an undescribed image while leaving an unrelated heading and paragraph unchanged (%j line endings)", (newline) => {
    const frontmatter = ["---", "title: Gallery", "---"].join(newline);
    const heading = "# Gallery";
    const paragraph =
      "Intro café ☕ with [the guide](./guide.md) and `![](decoy.png)` in code.";
    const image = '![](images/chart.png?size=2#preview "Chart")';
    const repaired = '![TODO: describe image](images/chart.png?size=2#preview "Chart")';
    const doc = [
      frontmatter,
      "",
      heading,
      "",
      paragraph,
      "",
      `See ${image} for the numbers.`,
      "",
    ].join(newline);
    const expected = [
      frontmatter,
      "",
      heading,
      "",
      paragraph,
      "",
      `See ${repaired} for the numbers.`,
      "",
    ].join(newline);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Heading and paragraph are byte-identical: everything outside the image
    // range is unchanged.
    expect(fixed.slice(0, from.offset)).toBe(doc.slice(0, from.offset));
    expect(fixed.slice(from.offset + repaired.length)).toBe(doc.slice(to.offset));
    expect(fixed).toContain(`${heading}${newline}${newline}${paragraph}`);
    expect(fixed.length - doc.length).toBe("TODO: describe image".length);
    // The full default rule set makes the same single fix.
    expect(applyAllFixes(doc, lintDocument(doc))).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    [
      "![](a.png),![](b.png).",
      "![TODO: describe image](a.png),![TODO: describe image](b.png).",
    ],
    [
      "(![](a.png)); ![ ](b.png)!?",
      "(![TODO: describe image](a.png)); ![TODO: describe image](b.png)!?",
    ],
    [
      "**![](a.png)**, _![](b.png)_.",
      "**![TODO: describe image](a.png)**, _![TODO: describe image](b.png)_.",
    ],
  ])("fixes several undescribed images separated only by punctuation in %j", (body, repairedBody) => {
    const doc = `Look: ${body} Done.\r\n`;
    const expected = `Look: ${repairedBody} Done.\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it.each([
    ["a period", "See ![](fig.png). Next."],
    ["a comma", "See ![](fig.png), then notes."],
    ["a semicolon", "See ![](fig.png); keep reading."],
    ["a colon", "See ![](fig.png): details follow."],
    ["a question mark", "What is ![](fig.png)? Explain."],
    ["an exclamation point", "Wow, ![](fig.png)! Amazing."],
    ["a closing parenthesis", "(See ![](fig.png)) for scale."],
    ["an em dash", "See ![](fig.png)—inline."],
  ])("inserts the placeholder into an undescribed image followed by %s, leaving the punctuation byte-for-byte", (_name, line) => {
    for (const nl of ["\n", "\r\n"]) {
      const image = "![](fig.png)";
      const repaired = "![TODO: describe image](fig.png)";
      const doc = `${line}${nl}`;
      const expected = `${line.replace(image, repaired)}${nl}`;
      const rules = [ruleMissingAltText];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("missing-alt-text");
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(image);
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // Everything after the repaired image — punctuation included — is
      // byte-identical to what followed the original image.
      expect(fixed.slice(from.offset + repaired.length)).toBe(doc.slice(to.offset));
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it.each([
    [
      "a letter before the ! and a period after",
      "chart![](fig.png).",
      "chart![TODO: describe image](fig.png).",
    ],
    [
      "a comma before and a semicolon after, mid-word",
      "x,![](fig.png);y",
      "x,![TODO: describe image](fig.png);y",
    ],
    [
      "parentheses hugging it between letters",
      "a(![](fig.png))c",
      "a(![TODO: describe image](fig.png))c",
    ],
    [
      "a colon before and an exclamation point after",
      "data:![](fig.png)!",
      "data:![TODO: describe image](fig.png)!",
    ],
    [
      "asterisks touching both sides",
      "see*![](fig.png)*done.",
      "see*![TODO: describe image](fig.png)*done.",
    ],
    [
      "comma, semicolon and em dash in one clause",
      "chart,![](fig.png);notes—done.",
      "chart,![TODO: describe image](fig.png);notes—done.",
    ],
    [
      "an ellipsis on each side",
      "weird…![](fig.png)…ok",
      "weird…![TODO: describe image](fig.png)…ok",
    ],
    [
      "a whitespace-only alt between quotes",
      "say “![ ](fig.png)” now",
      "say “![TODO: describe image](fig.png)” now",
    ],
  ])("inserts the documented placeholder for an undescribed image touching punctuation with no space between them (%s)", (_name, line, repairedLine) => {
    for (const nl of ["\n", "\r\n"]) {
      const image = line.slice(line.indexOf("!["), line.indexOf(")") + 1);
      const repaired = repairedLine.slice(
        repairedLine.indexOf("!["),
        repairedLine.indexOf(")") + 1,
      );
      const doc = `${line}${nl}`;
      const expected = `${repairedLine}${nl}`;
      const rules = [ruleMissingAltText];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("missing-alt-text");
      const { from, to } = violations[0].range!;
      // The reported range covers the image only — none of the punctuation
      // touching it.
      expect(doc.slice(from.offset, to.offset)).toBe(image);
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // The documented placeholder lands inside the brackets exactly once.
      expect(fixed.match(/TODO: describe image/g)).toHaveLength(1);
      // Everything before and after the image — punctuation included — is
      // byte-identical.
      expect(fixed.slice(0, from.offset)).toBe(doc.slice(0, from.offset));
      expect(fixed.slice(from.offset + repaired.length)).toBe(doc.slice(to.offset));
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });
});

// ─── 4. Chained violations + multi-fix application ───────────────────────────

describe("chained violations and multi-line fixes", () => {
  it.each([
    ["```", "\n"],
    ["~~~", "\r\n"],
  ])("fixes identical links outside a %s fence while preserving the example", (fence, newline) => {
    const code = [`${fence}markdown`, "[draft]() and [anchor](#)", fence].join(newline);
    const doc = ["Before [draft]().", "", code, "", "After [draft]().", ""].join(
      newline,
    );
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.range?.from.offset)).toEqual([
      doc.indexOf("[draft]()"),
      doc.lastIndexOf("[draft]()"),
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(
      ["Before [draft](TODO).", "", code, "", "After [draft]().", ""].join(newline),
    );
    expect(applyFix(doc, violations[1])).toBe(
      ["Before [draft]().", "", code, "", "After [draft](TODO).", ""].join(newline),
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      ["Before [draft](TODO).", "", code, "", "After [draft](TODO).", ""].join(newline),
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

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
    ["> ```markdown", "> ", "> ```", "\n"],
    ["- ~~~markdown", "  ", "  ~~~", "\r\n"],
  ])("preserves link and image examples in a container fence starting %s", (open, prefix, close, newline) => {
    const code = [open, `${prefix}[draft]() and ![](diagram.png)`, close].join(newline);
    const doc = ["Before [draft]().", "", code, "", "After ![](diagram.png).", ""].join(
      newline,
    );
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    expect(violations.map((violation) => violation.range?.from.offset)).toEqual([
      doc.indexOf("[draft]()"),
      doc.lastIndexOf("![](diagram.png)"),
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
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(fixed);
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

  it.each([
    '"Café at sunset"',
    "'Café at sunset'",
    "(Café at sunset)",
  ])("preserves a valid image with title %s while fixing neighboring violations", (title) => {
    const image = `![A café garden](../images/cafe%20garden.png?size=2#preview ${title})`;
    const doc = `Before [draft]() see ${image}, then ![](chart.png).\r\n`;
    const expected = `Before [draft](TODO) see ${image}, then ![TODO: describe image](chart.png).\r\n`;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
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

  it("fixes a link before an image on separate lines and preserves surrounding text", () => {
    const doc =
      "Intro: café\tand spacing.\r\nRead [draft]() for details.\r\n" +
      "Keep  this middle line.\r\nSee ![](images/chart.png?size=2#data) here.\r\nEnd.\r\n";
    const expected =
      "Intro: café\tand spacing.\r\nRead [draft](TODO) for details.\r\n" +
      "Keep  this middle line.\r\nSee ![TODO: describe image](images/chart.png?size=2#data) here.\r\nEnd.\r\n";
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    expect(
      violations.map(({ range }) => doc.slice(range!.from.offset, range!.to.offset)),
    ).toEqual(["[draft]()", "![](images/chart.png?size=2#data)"]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("preserves image and link order across adjacent lines with %j", (newline) => {
    const doc = `![](diagram.png)${newline}[docs]()${newline}`;
    // Run the link rule first to verify violations are ordered by position.
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `![TODO: describe image](diagram.png)${newline}[docs](TODO)${newline}`,
    );
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(fixed);
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
    const doc = `${[
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
      "Read [the guide](./guide.md) and [the draft](#).",
    ].join("\n")}\n`;

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
    expect(fixed).toBe(
      "# Section A\n\n## Section B\n\n## Section C\n\nBody text.\n\n" +
        "See ![TODO: describe image](chart.png) for data.\n\n" +
        "Contact [us](TODO) for more.\n" +
        "Read [the guide](./guide.md) and [the draft](TODO).\n",
    );

    const remaining = lintDocument(fixed, {
      rules: [
        ruleNoTrailingSpaces,
        ruleOrphanedHeading,
        ruleMissingAltText,
        ruleInvalidLinkTarget,
      ],
    });
    expect(remaining.map((violation) => violation.ruleId)).toEqual([
      "orphaned-heading",
      "orphaned-heading",
    ]);
    expect(remaining.every((violation) => violation.fix === null)).toBe(true);
    expect(applyAllFixes(fixed, remaining)).toBe(fixed);
  });

  it("sequential rule passes produce the same result as applyAllFixes", () => {
    const doc = "Look ![](img.png) and visit [here]().\n";
    const expected = "Look ![TODO: describe image](img.png) and visit [here](TODO).\n";
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const allViolations = lintDocument(doc, {
      rules,
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
      rules,
    });
    expect(remaining).toHaveLength(0);
    expect(allFixed).toBe(expected);
    expect(applyAllFixes(allFixed, remaining)).toBe(allFixed);

    const remainingSeq = lintDocument(seq, {
      rules,
    });
    expect(remainingSeq).toHaveLength(0);
    expect(seq).toBe(allFixed);
    expect(applyAllFixes(seq, remainingSeq)).toBe(seq);
  });

  it("fix for invalid-link-target leaves valid links untouched", () => {
    const doc = "[valid](https://example.com) and [broken]().\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(1);
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toContain("[valid](https://example.com)");
    expect(fixed).toContain("[broken](TODO)");
  });

  it.each([
    "?",
    "#",
    " \t ",
  ])("applies the image fix over the link fix nested inside it for destination %j, preserving the prose", (destination) => {
    const prose = "Closing prose with [a link](./report.md) stays.";
    const doc = `![](${destination}) is a diagram.\n\n${prose}\n`;
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    // The link fix's range sits inside the image's, so the batch applies the
    // wider image fix; the destination is repaired on the next pass.
    const once = applyAllFixes(doc, violations);
    expect(once).toBe(
      `![TODO: describe image](${destination}) is a diagram.\n\n${prose}\n`,
    );
    const remaining = lintDocument(once, { rules });
    expect(remaining.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    const twice = applyAllFixes(once, remaining);
    expect(twice).toBe(`![TODO: describe image](TODO) is a diagram.\n\n${prose}\n`);
    expect(lintDocument(twice, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("leaves a complete document with a valid link and a described image unchanged with %j line endings", (newline) => {
    const link =
      '[café guide](https://example.com/guide?view=full#links "Guide title")';
    const image = "![A café chart ☕](images/chart.png?size=2&theme=dark#preview)";
    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );

    for (const imageFirst of [false, true]) {
      const doc = [
        "# Café guide",
        "",
        `Read ${imageFirst ? image : link} and ${imageFirst ? link : image} for context.`,
        "",
        "Closing prose keeps  spacing and a tab:\t☕.",
        "",
      ].join(newline);
      const violations = lintDocument(doc, { rules });

      expect(violations).toEqual([]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(doc);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(doc);
    }
  });

  it.each([
    "\n",
    "\r\n",
  ])("keeps a valid link byte-for-byte unchanged while fixes on either side rewrite the document (%j line endings)", (newline) => {
    const link = '[the guide](./guide.md?topic=lint#links "Guide title")';
    const lines = [
      "---",
      "title: Guide",
      "---",
      "",
      "#### Deep section",
      "",
      "",
      `Read ${link} for details.`,
      "",
      "Then fix [draft]() now.   ",
      "",
    ];
    const doc = lines.join(newline);
    const expected = [
      "---",
      "title: Guide",
      "---",
      "",
      "### Deep section",
      "",
      `Read ${link} for details.`,
      "",
      "Then fix [draft](TODO) now.",
      "",
    ].join(newline);
    const violations = lintDocument(doc);

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "max-heading-depth",
      "no-consecutive-blank-lines",
      "invalid-link-target",
      "no-trailing-spaces",
    ]);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);

    // The invalid-link fix alone repairs only its own destination.
    const linkFix = violations.find(
      (violation) => violation.ruleId === "invalid-link-target",
    )!;
    expect(applyFix(doc, linkFix)).toBe(doc.replace("[draft]()", "[draft](TODO)"));

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The heading-depth and blank-line fixes deleted a "#" and one line
    // break before the link, so it moved left by that many bytes — yet the
    // link itself is byte-identical, and the TODO insert and the trailing
    // spaces trim after it never reached back into it.
    expect(fixed.indexOf(link)).toBe(doc.indexOf(link) - ("#".length + newline.length));

    const remaining = lintDocument(fixed);
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });
});

// ─── 5. Violation history helpers ────────────────────────────────────────────

describe("LinterToast violation history", () => {
  beforeEach(() => {
    clearLintHistory();
  });

  it("Fix all leaves an empty document empty and records no history", () => {
    const doc = "";
    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(doc, { rules });

    expect(violations).toEqual([]);
    expect(fixAllViolations(doc, violations)).toBe("");
    expect(getLintHistory()).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("leaves a valid link and image unchanged with %j line endings", (newline) => {
    const doc = [
      "---",
      "title: Café guide",
      "---",
      "",
      "Before: [Café guide](https://example.com/guide?view=full#links).",
      'See ![A café chart](images/chart.png?size=2#preview "Chart") after.',
      "",
    ].join(newline);
    const violations = lintDocument(doc);

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
    expect(fixAllViolations(doc, violations)).toBe(doc);
    expect(getLintHistory()).toEqual([]);
  });

  it("preserves a valid link and surrounding text while fixing images on both sides", () => {
    const doc =
      "Before ![](left.png), read [café guide](./guide.md?view=full#links) " +
      "for details, then see ![](right.png) afterward.\n";
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    const fixed = fixAllViolations(doc, violations);
    expect(fixed).toBe(
      "Before ![TODO: describe image](left.png), read [café guide](./guide.md?view=full#links) " +
        "for details, then see ![TODO: describe image](right.png) afterward.\n",
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(getLintHistory().map((entry) => entry.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("Fix all preserves clean prose and Markdown with line ending %j", (lineEnding) => {
    const doc = [
      "# Café guide",
      "",
      "Ordinary prose with  intentional spacing and **emphasis**.  ",
      "A second line links to [the guide](https://example.com/guide#details).",
      "",
      "- Use `code` when needed.",
      "- See ![A chart](images/chart.png) for context.",
      "",
    ].join(lineEnding);
    const enabledRules = new Set(LINTER_DEFAULT_ENABLED_RULES);
    const violations = lintDocument(doc).filter((v) => enabledRules.has(v.ruleId));

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
    expect(fixAllViolations(doc, violations)).toBe(doc);
    expect(getLintHistory()).toEqual([]);
  });

  it("leaves an empty document empty without recording fixes", () => {
    const doc = "";
    const toastRules = new Set(LINTER_DEFAULT_ENABLED_RULES);
    const violations = lintDocument(doc).filter((v) => toastRules.has(v.ruleId));

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe("");
    expect(fixAllViolations(doc, violations)).toBe("");
    expect(getLintHistory()).toEqual([]);
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

  it("does not change text or record another fix on a second pass for an invalid href", () => {
    const doc = "# First\n\n## Second\n\nRead [draft]() and [guide](./guide.md).   \n";
    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "orphaned-heading",
      "invalid-link-target",
      "no-trailing-spaces",
    ]);

    const once = fixAllViolations(doc, violations);
    expect(once).toBe(
      "# First\n\n## Second\n\nRead [draft](TODO) and [guide](./guide.md).\n",
    );
    const historyAfterFirstPass = [...getLintHistory()];
    expect(historyAfterFirstPass.map((entry) => entry.ruleId)).toEqual([
      "invalid-link-target",
      "no-trailing-spaces",
    ]);

    const remaining = lintDocument(once, { rules });
    expect(remaining.map((violation) => violation.ruleId)).toEqual([
      "orphaned-heading",
    ]);
    expect(remaining[0].fix).toBeNull();
    expect(fixAllViolations(once, remaining)).toBe(once);
    expect(getLintHistory()).toEqual(historyAfterFirstPass);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes multiple link placeholders only once with %j line endings", (newline) => {
    const doc = [
      "Read [draft]() and [draft](TODO).",
      "See [section](#), [search](?), and [guide](./guide.md).",
    ].join(newline);
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "invalid-link-target",
    ]);

    const once = fixAllViolations(doc, violations);
    expect(once).toBe(
      [
        "Read [draft](TODO) and [draft](TODO).",
        "See [section](TODO), [search](TODO), and [guide](./guide.md).",
      ].join(newline),
    );
    const historyAfterFirstPass = [...getLintHistory()];
    expect(historyAfterFirstPass).toHaveLength(3);
    const remaining = lintDocument(once, { rules });
    expect(remaining).toEqual([]);
    expect(fixAllViolations(once, remaining)).toBe(once);
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

  it.each([
    "",
    "\n",
    "\r\n",
    "\n\n",
    "\r\n\r\n",
  ])("Fix all preserves the document ending %j after an invalid link", (ending) => {
    const doc = `Opening paragraph.\n\nRead [draft]()${ending}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    const fixed = fixAllViolations(doc, violations);
    expect(fixed).toBe(`Opening paragraph.\n\nRead [draft](TODO)${ending}`);
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

  it("Fix all preserves both image sources while fixing an empty alt and a later link", () => {
    const doc =
      "See ![A café map](images/map.svg?view=full#north) beside " +
      "![](images/chart.png?size=2#data), then [details]().\n";
    const expected =
      "See ![A café map](images/map.svg?view=full#north) beside " +
      "![TODO: describe image](images/chart.png?size=2#data), then [details](TODO).\n";
    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    const fixed = fixAllViolations(doc, violations);
    expect(fixed).toBe(expected);
    const history = [...getLintHistory()];
    expect(history.map((entry) => entry.ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(fixAllViolations(fixed, remaining)).toBe(expected);
    expect(getLintHistory()).toEqual(history);
  });

  it.each([
    true,
    false,
  ])("Fix all preserves an adjacent described image with the same source (described first: %s)", (describedFirst) => {
    const described = "![A sleeping cat](images/cat.jpg)";
    const empty = "![](images/cat.jpg)";
    const repaired = "![TODO: describe image](images/cat.jpg)";
    const doc = describedFirst ? described + empty : empty + described;
    const expected = describedFirst ? described + repaired : repaired + described;
    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(empty);
    expect(violations[0].fix).not.toBeNull();
    const fixed = fixAllViolations(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(getLintHistory().map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
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

  it("Fix all is idempotent for missing image alt text with a remaining warning", () => {
    const doc = "# First\n\n## Second\n\nSee ![](chart.png) and ![ \t ](map.svg).\n";
    const rules = [ruleOrphanedHeading, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });
    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "orphaned-heading",
      "missing-alt-text",
      "missing-alt-text",
    ]);

    const once = fixAllViolations(doc, violations);
    expect(once).toBe(
      "# First\n\n## Second\n\nSee ![TODO: describe image](chart.png) and ![TODO: describe image](map.svg).\n",
    );
    const history = [...getLintHistory()];
    expect(history.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    const remaining = lintDocument(once, { rules });
    expect(remaining.map(({ ruleId }) => ruleId)).toEqual(["orphaned-heading"]);
    expect(remaining[0].fix).toBeNull();
    expect(fixAllViolations(once, remaining)).toBe(once);
    expect(getLintHistory()).toEqual(history);
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
    "\r\n",
  ])("preserves a valid CRLF document byte for byte with ending %j", (ending) => {
    const doc =
      [
        "---",
        "title: Café guide",
        "---",
        "",
        "# Café guide",
        "",
        "Read [the guide](./guide.md#details) and see ![A chart](chart.png).",
        "",
        "## Details",
        "",
        "Keep  internal spacing and Unicode: ☕.",
        "",
        "```md",
        "Example content",
        "```",
      ].join("\r\n") + ending;
    const violations = lintDocument(doc);

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });

  it("returns identical text when link and image fixes run on valid links and described images", () => {
    const doc = [
      "# Guide",
      "",
      "See [the docs](https://example.com/docs) and [setup](./setup.md#start).",
      "",
      "![Architecture diagram](images/arch.png)",
      '![Logo](https://example.com/logo.svg "Company logo")',
      "",
    ].join("\n");
    const violations = lintDocument(doc, {
      rules: [ruleInvalidLinkTarget, ruleMissingAltText],
    });

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });

  it("preserves a clean document through two autofix passes", () => {
    const doc =
      "---\ntitle: Guide\n---\n\nOrdinary prose with café and  internal spacing.\n\n" +
      "Read the [guide](https://example.com/guide?topic=lint#links) for details.\n";
    const firstViolations = lintDocument(doc);
    expect(firstViolations).toEqual([]);
    const once = applyAllFixes(doc, firstViolations);
    expect(once).toBe(doc);

    const secondViolations = lintDocument(once);
    expect(secondViolations).toEqual([]);
    expect(applyAllFixes(once, secondViolations)).toBe(doc);
  });

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

  it("leaves a valid document holding a link and a described image unchanged", () => {
    const link = "[the guide](https://example.com/guide?topic=lint#links)";
    const image = '![A café diagram](images/caf%C3%A9.png?size=2#preview "Diagram")';
    const doc = [
      "---",
      "title: Café guide",
      "---",
      "",
      "# Café guide",
      "",
      `Read ${link} and see ${image}.`,
      "",
      "## Details",
      "",
      "Keep  internal spacing and Unicode: ☕.",
      "",
    ].join("\n");
    const ruleSets = [
      BUILTIN_RULES,
      BUILTIN_RULES.filter((rule) => LINTER_DEFAULT_ENABLED_RULES.includes(rule.id)),
    ];

    for (const rules of ruleSets) {
      const violations = lintDocument(doc, { rules });
      expect(violations).toEqual([]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(doc);
      expect(fixed).toContain(link);
      expect(fixed).toContain(image);
      const remaining = lintDocument(fixed, { rules });
      expect(remaining).toEqual([]);
      expect(applyAllFixes(fixed, remaining)).toBe(doc);
    }
  });

  it("lintDocument on an empty string produces no violations for new rules", () => {
    const violations = lintDocument("", {
      rules: [ruleOrphanedHeading, ruleInvalidLinkTarget, ruleMissingAltText],
    });
    expect(violations).toHaveLength(0);
  });

  it("lints and autofixes an empty document to no findings and unchanged content", () => {
    const doc = "";
    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(doc, { rules });

    expect(violations).toEqual([]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(doc);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(doc);
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

  it.each([
    "\n",
    "\r\n",
  ])("preserves a clean document with ordinary prose and no links or images with line ending %j", (nl) => {
    clearLintHistory();
    const doc = [
      "---",
      "title: Guide",
      "---",
      "",
      "# Guide",
      "",
      "This is a paragraph of ordinary prose.",
      "",
      "## Getting Started",
      "",
      "Here are some notes about the project. Nothing fancy.",
      "",
      "- First item",
      "- Second item",
      "- Third item",
      "",
      "More content with **bold** and *italic* text.",
      "",
    ].join(nl);
    const violations = lintDocument(doc);
    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
    expect(fixAllViolations(doc, violations)).toBe(doc);
    expect(getLintHistory()).toEqual([]);
  });

  it("trailing-space fix handles multi-line doc correctly", () => {
    const doc = "line one   \nline two   \nline three\n";
    const violations = lintDocument(doc, { rules: [ruleNoTrailingSpaces] });
    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("line one\nline two\nline three\n");
  });

  it("all four default rules can run together on a messy document", () => {
    const doc = `${[
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
    ].join("\n")}\n`;

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

describe("invalid-link-target autofix: link label preservation", () => {
  it.each([
    ["#", "[Read the full style guide](#)"],
    ["", "[Read the full style guide]()"],
    ["?", "[Read the full style guide](?)"],
  ])("keeps a multiword label exactly when fixing destination %j", (_dest, link) => {
    const label = "Read the full style guide";
    const doc = `See ${link} now.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`See [${label}](TODO) now.\n`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    'Wait, what? Yes: it\'s "done"; see v1.2-beta!',
    "50% off / 100% free @ home #1 ~ now",
    "Q&A (part 1) - notes, etc...",
    "*emphasis*, _more_ and ~~gone~~!",
  ])("keeps a label with punctuation %j and the surrounding text when replacing an empty href", (label) => {
    const doc = `- Before: [${label}]() (see also [ok](./ok.md)), after.\n`;
    const expected = `- Before: [${label}](TODO) (see also [ok](./ok.md)), after.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("preserves the entire multiword label and replaces the invalid destination with TODO", () => {
    const doc = "Please visit [the documentation page]() for more info.\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();

    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toBe("Please visit [the documentation page](TODO) for more info.\n");
    expect(applyAllFixes(doc, violations)).toBe(fixed);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("retains a multiword link label when fixing an empty destination", () => {
    const doc = "Read [user setup guide]() before getting started.\n";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("Read [user setup guide](TODO) before getting started.\n");
    // Verify the multiword label is byte-for-byte preserved
    expect(fixed).toContain("[user setup guide](TODO)");
    expect(fixed).not.toContain("[user setup guide]()");
    // Idempotence: fixing again produces the same result
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it("preserves a multiword label byte-for-byte while replacing a whitespace-only href", () => {
    const label = "complete installation guide";
    const doc = `Draft: [${label}](   ) plus [ok](./ok.md) stay.\n`;
    const expected = `Draft: [${label}](TODO) plus [ok](./ok.md) stay.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(violations[0].fix).not.toBeNull();
    // The reported range covers the whole link, label included.
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`[${label}](   )`);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`[${label}](TODO)`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    // Idempotence: fixing again produces the same result.
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    // The full default rule set makes the same label-preserving repair.
    const full = `---\ntitle: Guide\n---\n\nDraft: [${label}](   ) plus [ok](./ok.md) stay.\n`;
    expect(applyAllFixes(full, lintDocument(full))).toBe(
      `---\ntitle: Guide\n---\n\nDraft: [${label}](TODO) plus [ok](./ok.md) stay.\n`,
    );
  });
});

describe("invalid-link-target autofix: empty href case", () => {
  const rules = [ruleInvalidLinkTarget];

  it("replaces an empty href with TODO and keeps the link text", () => {
    const doc = "Open [Settings page]() to continue.\n";
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("Open [Settings page](TODO) to continue.\n");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes every empty href on one line and keeps each link text", () => {
    const doc = "[one]() and [two]() and [three](./three.md)\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(applyAllFixes(doc, violations)).toBe(
      "[one](TODO) and [two](TODO) and [three](./three.md)\n",
    );
  });

  it("fixes an empty href inside a heading", () => {
    const doc = "# See [the guide]()\n\nBody.\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(applyAllFixes(doc, violations)).toBe("# See [the guide](TODO)\n\nBody.\n");
  });

  it("fixes an empty href inside a footnote definition and keeps the marker, label and inline reference", () => {
    const doc =
      "Text with a footnote[^1] inline.\n\n[^1]: Read the [install guide]() first.\n";
    const expected =
      "Text with a footnote[^1] inline.\n\n[^1]: Read the [install guide](TODO) first.\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    // The reported range covers the whole link — label included — never the [^1] marker.
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[install guide]()");

    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Both [^1] occurrences — inline reference and definition marker — survive byte-for-byte.
    expect(fixed.match(/\[\^1\]/g)).toHaveLength(2);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("leaves empty hrefs inside an HTML comment and inline math untouched while fixing the visible link", () => {
    const doc = "<!-- [draft]() -->\n\nKeep $[x]()$ and fix [real]() here.\n";
    const expected = "<!-- [draft]() -->\n\nKeep $[x]()$ and fix [real](TODO) here.\n";
    const violations = lintDocument(doc, { rules });

    // Only the visible link is flagged; the comment line and inline math are masked.
    expect(violations).toHaveLength(1);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[real]()");

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("<!-- [draft]() -->");
    expect(fixed).toContain("$[x]()$");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("invalid-link-target autofix: preserves surrounding content", () => {
  it.each([
    "\n",
    "\r\n",
  ])("fixing an invalid link leaves an unrelated heading and paragraph unchanged with %j line endings", (nl) => {
    const doc = [
      "# Main Title",
      "",
      "This is a paragraph with an [invalid link]() in it.",
      "",
      "## Subsection",
      "",
      "Another paragraph with valid content.",
      "",
    ].join(nl);

    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");

    const fixed = applyAllFixes(doc, violations);

    // Heading unchanged
    expect(fixed).toContain("# Main Title");
    expect(fixed).toContain("## Subsection");

    // Unrelated paragraph unchanged
    expect(fixed).toContain("Another paragraph with valid content.");

    // Link fixed in place
    expect(fixed).not.toContain("[invalid link]()");
    expect(fixed).toContain("[invalid link](TODO)");

    // Paragraph that held the link is otherwise intact
    expect(fixed).toContain("This is a paragraph with");

    // Re-lint is clean
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("preserves prose on both sides of an invalid link exactly with %j line endings", (nl) => {
    const doc = `🧭 Navigate to [resources]() for the full guide; then [appendix](#) for details.${nl}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(2);

    const fixed = applyAllFixes(doc, violations);

    // Verify the entire document is exactly as expected — byte-for-byte
    expect(fixed).toBe(
      `🧭 Navigate to [resources](TODO) for the full guide; then [appendix](TODO) for details.${nl}`,
    );

    // Verify prose before the first link is preserved exactly
    expect(fixed.startsWith("🧭 Navigate to ")).toBe(true);

    // Verify prose between the two links is preserved exactly
    expect(fixed).toContain(" for the full guide; then ");

    // Verify prose after the last link is preserved exactly
    expect(fixed.endsWith(` for details.${nl}`)).toBe(true);

    // Re-lint is clean
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("leaves a valid HTTPS link and its surrounding text unchanged with %j line endings", (nl) => {
    const doc = [
      "# Links",
      "",
      "Read the (very) good [guide](https://example.com/guide?topic=lint#links), then relax.",
      "",
    ].join(nl);
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });
});

describe("invalid-link-target autofix: invalid link in a blockquote", () => {
  it("replaces the invalid href with TODO and keeps the blockquote, nesting and surrounding text", () => {
    const doc = [
      "Intro before the quote.",
      "",
      "> Quoted text with an [empty link]() and a [valid one](https://example.com).",
      "> > Nested [hash only](#) stays quoted.",
      "",
      "Outro after the quote.",
      "",
    ].join("\n");
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(2);

    const fixed = applyAllFixes(doc, violations);

    expect(fixed).toBe(
      [
        "Intro before the quote.",
        "",
        "> Quoted text with an [empty link](TODO) and a [valid one](https://example.com).",
        "> > Nested [hash only](TODO) stays quoted.",
        "",
        "Outro after the quote.",
        "",
      ].join("\n"),
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("invalid-link-target autofix: single fix in a blockquote list", () => {
  it("applies one fix at a time, swapping only that href for TODO and keeping the quote, list markers and prose", () => {
    const doc = [
      "Before the quote.",
      "",
      "> Steps, see [setup]() first:",
      "> - run [build](./build.md)",
      "> - read [notes](?) carefully",
      "",
      "After the quote.",
      "",
    ].join("\n");
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(2);

    const first = applyFix(doc, violations[0]);
    expect(first).toBe(doc.replace("[setup]()", "[setup](TODO)"));
    expect(first).toContain("> - read [notes](?) carefully");

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      doc.replace("[setup]()", "[setup](TODO)").replace("[notes](?)", "[notes](TODO)"),
    );
    expect(fixed.startsWith("Before the quote.\n\n> Steps")).toBe(true);
    expect(fixed.endsWith("\nAfter the quote.\n")).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("link and image autofix: mixed-fix idempotence", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    "\n",
    "\r\n",
  ])("applying link and image fixes twice equals applying them once with %j line endings", (nl) => {
    const doc = [
      "# Gallery",
      "",
      "![](a.png) beside [draft]() and ![ \t ](b.png?x=1#y) then [top](#).",
      "Keep ![ok](c.png) and [guide](./guide.md); [search](?) ![](d.png)",
      "",
    ].join(nl);
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId).sort()).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "invalid-link-target",
      "missing-alt-text",
      "missing-alt-text",
      "missing-alt-text",
    ]);

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(
      [
        "# Gallery",
        "",
        "![TODO: describe image](a.png) beside [draft](TODO) and ![TODO: describe image](b.png?x=1#y) then [top](TODO).",
        "Keep ![ok](c.png) and [guide](./guide.md); [search](TODO) ![TODO: describe image](d.png)",
        "",
      ].join(nl),
    );

    // Second pass: re-lint and fix again — nothing may change.
    expect(lintDocument(once, { rules })).toEqual([]);
    expect(fixPass(once)).toBe(once);
    // Whole pipeline run twice from the original matches a single run.
    expect(fixPass(fixPass(doc))).toBe(once);
  });

  it.each([
    "\n",
    "\r\n",
  ])("is idempotent for an undescribed image inside an invalid link, in lists and quotes, beside code decoys (%j)", (nl) => {
    const doc = [
      "# Mixed",
      "",
      "[![](logo.png)]() and [![ok](badge.png)](#)",
      "",
      "- item [a]() with ![](i.png)",
      "> quote [b](?) with ![ ](q.png)",
      "",
      "`[code]() ![](x.png)` stays",
      "",
      "```",
      "[fence]() ![](y.png)",
      "```",
      "",
    ].join(nl);

    const first = fixPass(doc);
    expect(first).not.toBe(doc);
    // Decoys in inline code and fenced code are untouched.
    expect(first).toContain("`[code]() ![](x.png)` stays");
    expect(first).toContain(`[fence]() ![](y.png)${nl}`);
    expect(lintDocument(first, { rules })).toEqual([]);

    // The second autofix produces exactly the first result.
    expect(fixPass(first)).toBe(first);
  });
});

describe("invalid-link-target autofix: idempotence", () => {
  const fixPass = (text: string) =>
    applyAllFixes(text, lintDocument(text, { rules: [ruleInvalidLinkTarget] }));

  it.each([
    "\n",
    "\r\n",
  ])("running autofix twice on invalid links equals running it once with %j line endings", (nl) => {
    const doc = [
      "See [empty]() and [spaces](  \t  ) then [hash](#) plus [query](?).",
      "Valid [docs](https://example.com) and [local](./file.md) stay.",
      "",
    ].join(nl);

    // First pass: lint + fix
    const once = fixPass(doc);
    expect(once).not.toBe(doc); // something must change

    // Second pass: lint the fixed doc + fix again — must not change anything
    expect(fixPass(once)).toBe(once);

    // Also verify no violations remain after the first fix
    expect(lintDocument(once, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it.each([
    ["single empty link", "Read [this]() for details.\n"],
    ["single whitespace-only link", "Read [this](  \t  ) for details.\n"],
    ["single hash link", "Read [this](#) for details.\n"],
    ["single query link", "Read [this](?) for details.\n"],
  ])("running autofix twice on %s equals running it once", (_label, doc) => {
    const once = fixPass(doc);
    expect(fixPass(once)).toBe(once);
    expect(lintDocument(once, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it("is idempotent with applyFix: applying the captured fix twice on the original equals applying it once", () => {
    const doc = "Read [guide]() for details.\n";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();

    const fixFn = violations[0].fix!;
    const once = fixFn(doc);
    const twice = fixFn(doc);

    expect(twice).toBe(once);
    expect(once).toBe("Read [guide](TODO) for details.\n");
    expect(lintDocument(once, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });
});

describe("invalid-link-target autofix: repeated application", () => {
  it.each([
    "\n",
    "\r\n",
  ])("applying one fix a second time leaves the text unchanged, link by link (%j)", (nl) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = `Read [a]() and [b](   ) here.${nl}Then [c](#) and [ok](./guide.md).${nl}`;
    for (const violation of lintDocument(doc, { rules })) {
      const once = applyFix(doc, violation);
      expect(once).not.toBe(doc);
      // Re-lint after the first fix: the remaining violations still apply cleanly, and
      // the fixed link is no longer reported.
      const remaining = lintDocument(once, { rules });
      expect(remaining.length).toBe(lintDocument(doc, { rules }).length - 1);
      expect(applyAllFixes(once, remaining)).toBe(
        applyAllFixes(doc, lintDocument(doc, { rules })),
      );
    }
    const all = applyAllFixes(doc, lintDocument(doc, { rules }));
    expect(applyAllFixes(all, lintDocument(all, { rules }))).toBe(all);
    expect(all).toBe(
      `Read [a](TODO) and [b](TODO) here.${nl}Then [c](TODO) and [ok](./guide.md).${nl}`,
    );
  });
});

describe("rule:missing-alt-text mixed described and undescribed images", () => {
  it.each([
    ["\n", "\n\n"],
    ["\r\n", "\r\n\r\n"],
  ])("gives a placeholder only to the undescribed image, leaving the described one untouched (%j line endings)", (newline, gap) => {
    // One undescribed image and one described image on separate lines.
    const undescribed = "![](photos/lake.jpg)";
    const described = "![Sunset over the lake](photos/sunset.jpg)";
    const doc = `Gallery.${gap}${undescribed}${gap}${described}${newline}`;

    // After fix: only the undescribed image gets the placeholder.
    const expected = `Gallery.${gap}![TODO: describe image](photos/lake.jpg)${gap}${described}${newline}`;

    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    // Only one violation — the undescribed image.
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);

    // The described image is byte-for-byte preserved.
    expect(fixed).toContain(described);
    // The undescribed image now has the placeholder.
    expect(fixed).toContain("![TODO: describe image](photos/lake.jpg)");
    // Original undescribed syntax is gone.
    expect(fixed).not.toContain("![](photos/lake.jpg)");
    // Clean after fix.
    expect(lintDocument(fixed, { rules })).toEqual([]);
    // Idempotent.
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["\n"],
    ["\r\n"],
  ])("fixes only undescribed images in a multi-paragraph document with default rules, leaving described images untouched (%j)", (nl) => {
    const described1 = "![Revenue Q3 chart](images/q3.png)";
    const undescribed = "![](images/unknown.png)";
    const described2 = '![Team photo](images/team.jpg "Q3 retreat")';

    const doc = [
      "# Report",
      "",
      `Revenue grew this quarter. ${described1}`,
      "",
      `Also see ${undescribed} for comparison.`,
      "",
      `${described2}`,
      "",
    ].join(nl);

    const expected = doc.replace(
      undescribed,
      "![TODO: describe image](images/unknown.png)",
    );

    clearLintHistory();
    const defaultRules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(doc, { rules: defaultRules });
    const missingAlt = violations.filter((v) => v.ruleId === "missing-alt-text");

    // Only the undescribed image triggers missing-alt-text.
    expect(missingAlt).toHaveLength(1);
    expect(missingAlt[0].range?.from.offset).toBe(doc.indexOf(undescribed));

    const fixed = fixAllViolations(doc, violations);
    expect(fixed).toBe(expected);

    // Both described images are byte-for-byte preserved.
    expect(fixed).toContain(described1);
    expect(fixed).toContain(described2);
    // The undescribed image has the placeholder.
    expect(fixed).toContain("![TODO: describe image](images/unknown.png)");
    // Original undescribed syntax is gone.
    expect(fixed).not.toContain("![](images/unknown.png)");

    // Clean after fix — re-lint with default rules.
    const remaining = lintDocument(fixed, { rules: defaultRules });
    expect(remaining).toEqual([]);

    // fixAllViolations recorded the violation in history.
    const history = getLintHistory();
    expect(history).toHaveLength(1);
    expect(history[0].ruleId).toBe("missing-alt-text");
    expect(history[0].fixedAt).toBeGreaterThan(0);

    // Idempotent — running again changes nothing.
    expect(fixAllViolations(fixed, lintDocument(fixed, { rules: defaultRules }))).toBe(
      fixed,
    );
  });

  it.each([
    ["", "\n"],
    [" \t ", "\r\n"],
  ])("fixes an undescribed image (alt %j) on a line directly followed by a described image, which stays unchanged (%j line endings)", (alt, nl) => {
    // Consecutive lines in the same paragraph: no blank line between them.
    const undescribed = `![${alt}](photos/lake.jpg)`;
    const described = '![Sunset over the lake](photos/sunset.jpg?size=2#top "Sunset")';
    const doc = `Gallery:${nl}${undescribed}${nl}${described}${nl}`;
    const expected = `Gallery:${nl}![TODO: describe image](photos/lake.jpg)${nl}${described}${nl}`;

    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(undescribed);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The described image is byte-for-byte preserved.
    expect(fixed).toContain(described);
    expect(fixed.match(/TODO: describe image/g)).toHaveLength(1);
    expect(fixed).not.toContain(undescribed);
    // Clean after fix, and a second pass changes nothing.
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("rule:missing-alt-text two undescribed images", () => {
  it.each([
    ["\n", "\n\n"],
    ["\r\n", "\r\n\r\n"],
  ])("gives both images a placeholder and keeps both sources (%j line endings)", (newline, gap) => {
    const first = '![](assets/one%20a.png?v=1#top "One")';
    const second = "![   ](./assets/two.svg)";
    const doc = `Intro.${gap}${first} and ${second}${newline}`;
    const expected =
      `Intro.${gap}![TODO: describe image](assets/one%20a.png?v=1#top "One") and ` +
      `![TODO: describe image](./assets/two.svg)${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain('(assets/one%20a.png?v=1#top "One")');
    expect(fixed).toContain("(./assets/two.svg)");
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it("fixAllViolations under the default rules describes both images, keeps both sources and records two history entries", () => {
    clearLintHistory();
    const doc =
      "# Gallery\n\nSee the photos below.\n\n![](img/a.png)\n![](img/b.png)\n";
    const expected =
      "# Gallery\n\nSee the photos below.\n\n" +
      "![TODO: describe image](img/a.png)\n![TODO: describe image](img/b.png)\n";
    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    const fixed = fixAllViolations(doc, violations);
    expect(fixed).toBe(expected);
    expect(getLintHistory().map((entry) => entry.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["\n"],
    ["\r\n"],
  ])("describes two linked undescribed images and keeps every image source and link href intact (%j line endings)", (nl) => {
    const first = "[![](img/one.png)](pages/one)";
    const second = '[![  ](img/two.svg?w=2#top "Two")](<pages/two page>)';
    const fixedFirst = "[![TODO: describe image](img/one.png)](pages/one)";
    const fixedSecond =
      '[![TODO: describe image](img/two.svg?w=2#top "Two")](<pages/two page>)';
    const doc = `Links.${nl}${nl}Open ${first} then ${second} today.${nl}`;
    const expected = `Links.${nl}${nl}Open ${fixedFirst} then ${fixedSecond} today.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    // One violation per image; each range covers just the image inside its link.
    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(
      violations.map(({ range }) => doc.slice(range!.from.offset, range!.to.offset)),
    ).toEqual(["![](img/one.png)", '![  ](img/two.svg?w=2#top "Two")']);
    expect(violations.every(({ fix }) => fix !== null)).toBe(true);
    // Each single fix describes only its own image, leaving the other link
    // and its image untouched for a later pass.
    expect(applyFix(doc, violations[0])).toBe(
      `Links.${nl}${nl}Open ${fixedFirst} then ${second} today.${nl}`,
    );
    expect(applyFix(doc, violations[1])).toBe(
      `Links.${nl}${nl}Open ${first} then ${fixedSecond} today.${nl}`,
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Both image sources and both link hrefs are byte-for-byte intact.
    for (const destination of [
      "(img/one.png)",
      '](img/two.svg?w=2#top "Two")',
      "](pages/one)",
      "](<pages/two page>)",
    ]) {
      expect(fixed).toContain(destination);
    }
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["", "", "\n"],
    [" ", "  ", "\r\n"],
    [" \t ", "", "\n"],
  ])("describes both undescribed images in one paragraph and keeps both paths intact (alts %j and %j, %j line endings)", (firstAlt, secondAlt, nl) => {
    const first = `![${firstAlt}](images/first%20pic.png?v=1#top "First")`;
    const second = `![${secondAlt}](../assets/two.svg?view=full)`;
    const doc = `Intro.${nl}${nl}Compare ${first} with ${second} in this paragraph.${nl}`;
    const fixedFirst =
      '![TODO: describe image](images/first%20pic.png?v=1#top "First")';
    const fixedSecond = "![TODO: describe image](../assets/two.svg?view=full)";
    const expected = `Intro.${nl}${nl}Compare ${fixedFirst} with ${fixedSecond} in this paragraph.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    // Each violation's range covers exactly its own image.
    expect(
      violations.map(({ range }) => doc.slice(range!.from.offset, range!.to.offset)),
    ).toEqual([first, second]);
    expect(violations.every(({ fix }) => fix !== null)).toBe(true);
    // A single fix describes only its own image, leaving the other for a
    // later pass.
    expect(applyFix(doc, violations[0])).toBe(
      `Intro.${nl}${nl}Compare ${fixedFirst} with ${second} in this paragraph.${nl}`,
    );
    expect(applyFix(doc, violations[1])).toBe(
      `Intro.${nl}${nl}Compare ${first} with ${fixedSecond} in this paragraph.${nl}`,
    );

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Both descriptions receive the placeholder.
    expect(fixed.match(/!\[TODO: describe image\]/g)).toHaveLength(2);
    // Both image paths are byte-for-byte intact.
    expect(fixed).toContain('(images/first%20pic.png?v=1#top "First")');
    expect(fixed).toContain("(../assets/two.svg?view=full)");
    // Clean after fix; a second pass changes nothing.
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    "\n",
    "\r\n",
  ])("describes two undescribed images on soft-wrapped lines of one paragraph and keeps both paths intact (%j line endings)", (nl) => {
    // Consecutive lines with no blank line between them are one paragraph.
    const first = "![](photos/before.jpg)";
    const second = '![ ](<photos/after photo.jpg> "After")';
    const doc = `The gallery grows: ${first}${nl}then ${second} for the after shot.${nl}`;
    const expected =
      "The gallery grows: ![TODO: describe image](photos/before.jpg)" +
      `${nl}then ![TODO: describe image](<photos/after photo.jpg> "After") for the after shot.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    // Same paragraph, reported on consecutive lines in document order.
    expect(violations.map(({ range }) => range!.from.line)).toEqual([1, 2]);
    expect(violations.every(({ fix }) => fix !== null)).toBe(true);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Both descriptions receive the placeholder; both paths stay intact.
    expect(fixed).toContain("![TODO: describe image](photos/before.jpg)");
    expect(fixed).toContain(
      '![TODO: describe image](<photos/after photo.jpg> "After")',
    );
    expect(fixed.match(/!\[TODO: describe image\]/g)).toHaveLength(2);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("autofix: empty document", () => {
  it.each(BUILTIN_RULES)("leaves an empty document unchanged with rule $id", (rule) => {
    const doc = "";
    const violations = lintDocument(doc, { rules: [rule] });
    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });

  it("returns an empty document without throwing, across all built-in rules", () => {
    const violations = lintDocument("", { rules: BUILTIN_RULES });
    expect(() => applyAllFixes("", violations)).not.toThrow();
    expect(applyAllFixes("", violations)).toBe("");
  });

  it("returns an empty document when given no violations", () => {
    expect(applyAllFixes("", [])).toBe("");
  });

  it("adds no placeholders and is idempotent under every rule set", () => {
    const defaultRules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    for (const rules of [BUILTIN_RULES, defaultRules]) {
      const violations = lintDocument("", { rules });
      expect(violations).toEqual([]);
      const fixed = applyAllFixes("", violations);
      expect(fixed).toBe("");
      expect(fixed).not.toContain("TODO");
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe("");
    }
  });

  it("fixAllViolations returns an empty document and records no history", () => {
    clearLintHistory();
    const violations = lintDocument("", { rules: BUILTIN_RULES });
    expect(fixAllViolations("", violations)).toBe("");
    expect(getLintHistory()).toEqual([]);
  });

  it("does not throw when fixes computed from earlier content are applied to a cleared document", () => {
    // A stale lint result (the user deleted everything after linting) must not
    // crash autofix; whatever it returns is still a string the editor can use.
    const stale = lintDocument("See [x]() and ![](a.png)\n", { rules: BUILTIN_RULES });
    expect(stale.some((v) => v.fix !== null)).toBe(true);
    expect(() => applyAllFixes("", stale)).not.toThrow();
    expect(typeof applyAllFixes("", stale)).toBe("string");
  });

  it("applyFix returns an empty document unchanged", () => {
    const violation: LintViolation = {
      ruleId: "test-rule",
      message: "document-level issue",
      severity: "info",
      range: null,
      fix: null,
    };
    expect(applyFix("", violation)).toBe("");
  });
});

describe("autofix: whitespace-only document", () => {
  it.each([
    ["spaces only", "   "],
    ["blank lines only", "\n\n"],
    ["mixed spaces, tabs and blank lines", " \t \n\n  \n"],
    ["CRLF blank lines with spaces", "\r\n  \r\n"],
    ["mixed whitespace without a final newline", "\t \r\n \t"],
    ["single newline", "\n"],
  ])("preserves %s without placeholders under every rule set", (_label, doc) => {
    const defaultRules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    for (const rules of [BUILTIN_RULES, defaultRules]) {
      const violations = lintDocument(doc, { rules });
      expect(violations).toEqual([]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(doc);
      expect(fixed).not.toContain("TODO");
      // Second pass is a no-op.
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(doc);
    }
  });

  it.each([
    ["no-break space", "  "],
    ["em space and ideographic space", " 　 \n"],
    ["vertical tab and form feed", "\v\f \n"],
    ["lone carriage returns", "\r\r \r"],
    ["line and paragraph separators", "    "],
    ["a long run of mixed whitespace", " \t\r\n".repeat(5000)],
  ])("preserves %s byte-for-byte, without changing length", (_label, doc) => {
    const fixed = applyAllFixes(doc, lintDocument(doc, { rules: BUILTIN_RULES }));
    expect(fixed).toBe(doc);
    expect(fixed).toHaveLength(doc.length);
    clearLintHistory();
    expect(fixAllViolations(doc, lintDocument(doc, { rules: BUILTIN_RULES }))).toBe(
      doc,
    );
    expect(getLintHistory()).toEqual([]);
  });

  it.each([
    "   ",
    "\n\n",
    " \t \n\n  \n",
    "\r\n  \r\n",
  ])("fixAllViolations returns whitespace-only document %j unchanged and records no history", (doc) => {
    clearLintHistory();
    const violations = lintDocument(doc, { rules: BUILTIN_RULES });
    expect(fixAllViolations(doc, violations)).toBe(doc);
    expect(getLintHistory()).toEqual([]);
  });
});

describe("autofix: fenced-code preservation", () => {
  it.each([
    ["```", "\n"],
    ["~~~", "\r\n"],
  ])("image-like text inside a %s fenced code block remains unchanged by autofix (%j line endings)", (fence, newline) => {
    // Document has real violations in prose AND image-like text inside a code fence.
    // Autofix must fix the prose violations but leave the code-fenced content intact.
    const codeBlock = [
      `${fence}markdown`,
      `[draft]() and ![](diagram.png) are just examples.`,
      `![  ](photo.jpg) and [broken](#) too.`,
      fence,
    ].join(newline);

    const doc = [
      `Here is a real broken link: [fixme]() and ![](real.png).`,
      "",
      codeBlock,
      "",
      `After the block, another [bad](?) link and ![ ](also.png).`,
      "",
    ].join(newline);

    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    // 4 violations in prose only: 2 invalid links + 2 images with empty alt.
    // Image-like syntax inside the fenced code block is NOT flagged.
    expect(violations.length).toBe(4);
    expect(violations.map((v) => v.ruleId).sort()).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "missing-alt-text",
      "missing-alt-text",
    ]);

    // Apply fixes
    const fixed = applyAllFixes(doc, violations);

    // The prose lines should be fixed
    expect(fixed).toContain("[fixme](TODO)");
    expect(fixed).toContain("![TODO: describe image](real.png)");
    expect(fixed).toContain("[bad](TODO)");
    expect(fixed).toContain("![TODO: describe image](also.png)");

    // The fenced code block must be preserved EXACTLY — no image-like text modified
    expect(fixed).toContain(
      [
        `${fence}markdown`,
        `[draft]() and ![](diagram.png) are just examples.`,
        `![  ](photo.jpg) and [broken](#) too.`,
        fence,
      ].join(newline),
    );

    // Re-lint the fixed document — should be clean
    expect(lintDocument(fixed, { rules })).toEqual([]);

    // Idempotence: fixing again must not change anything
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("autofix: undescribed image only inside a fenced code block", () => {
  it.each([
    ["backtick fence", "```", "\n"],
    ["tilde fence", "~~~", "\r\n"],
    ["longer fence", "````", "\n"],
    ["fence with info string", '```md title="x"', "\r\n"],
    ["indented fence", "   ```", "\n"],
  ])("leaves the whole document byte-identical (%s)", (_name, open, nl) => {
    const close = open.trim().match(/^[`~]+/)![0];
    const doc = [
      "---",
      "title: Fenced",
      "---",
      "",
      "# Title",
      "",
      "Plain prose.",
      "",
      open,
      "![](diagram.png)",
      '![   ](spaced.png "T")',
      "![described](ok.png)",
      close,
      "",
      "Tail.",
      "",
    ].join(nl);

    for (const rules of [[ruleMissingAltText], BUILTIN_RULES]) {
      const violations = lintDocument(doc, { rules });
      expect(violations.filter((v) => v.ruleId === "missing-alt-text")).toEqual([]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(doc);
      expect(fixed).not.toContain("TODO: describe image");
    }
  });

  it("still fixes an undescribed image outside the fence and leaves the block untouched", () => {
    const block = "```\n![](inside.png)\n```";
    const doc = `${block}\n\n![](outside.png)\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(applyAllFixes(doc, violations)).toBe(
      `${block}\n\n![TODO: describe image](outside.png)\n`,
    );
  });
});

describe("autofix: invalid link only inside a fenced code block", () => {
  it.each([
    ["backtick fence", "```", "\n"],
    ["tilde fence", "~~~", "\r\n"],
    ["longer fence", "````", "\n"],
    ["fence with info string", '```md title="x"', "\r\n"],
    ["indented fence", "   ```", "\n"],
  ])("leaves the whole document byte-identical (%s)", (_name, open, nl) => {
    const close = open.trim().match(/^[`~]+/)![0];
    const doc = [
      "---",
      "title: Fenced",
      "---",
      "",
      "# Title",
      "",
      "Plain prose.",
      "",
      open,
      "[empty]()",
      "[hash](#)",
      "[ok](https://example.com)",
      close,
      "",
      "Tail.",
      "",
    ].join(nl);

    for (const rules of [[ruleInvalidLinkTarget], BUILTIN_RULES]) {
      const violations = lintDocument(doc, { rules });
      expect(violations.filter((v) => v.ruleId === "invalid-link-target")).toEqual([]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(doc);
      expect(fixed).not.toContain("TODO");
    }
  });

  it("still fixes an invalid link outside the fence and leaves the block untouched", () => {
    const block = "```\n[inside]()\n```";
    const doc = `${block}\n\n[outside]()\n`;
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed.startsWith(`${block}\n\n`)).toBe(true);
    expect(fixed).not.toBe(doc);
  });
});

// ─── 9. Autofix leaves a lone described image untouched ───────────────────────

describe("autofix: lone described image", () => {
  const images = [
    "![A red bicycle](bike.png)",
    '![Café terrace, at sunset](images/caf%C3%A9.png?size=2#view "Terrace (v2)")',
    "![Chart *Q3* `revenue`](<my chart.png>)",
    "![Logo][logo]\n\n[logo]: logo.svg",
  ];

  const rules = [
    ruleMissingAltText,
    ruleInvalidLinkTarget,
    ruleNoTrailingSpaces,
    ruleOrphanedHeading,
  ];

  it.each(images)("reports nothing and changes nothing for %j", (image) => {
    for (const newline of ["\n", "\r\n"]) {
      const doc = `# Gallery${newline}${newline}${image.replace(/\n/g, newline)}${newline}`;
      const violations = lintDocument(doc, { rules });
      expect(violations.filter((v) => v.ruleId === "missing-alt-text")).toEqual([]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(doc);
      expect(fixed).toContain(image.split("\n")[0]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });

  it("leaves described images in list items and blockquotes unchanged", () => {
    const doc = "- ![One](a.png)\n- item ![Two](b.png) end\n\n> ![Three](c.png)\n";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });
    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });
});

describe("rule:missing-alt-text unicode image sources", () => {
  it.each([
    "images/cafe\u0301 日本語 😀.png?言語=日本語#詳細",
    "../مرحبا/café.png",
    "画像/星🌟-café.png",
  ])("inserts a description without changing the Unicode source <%s>", (source) => {
    const image = `![](<${source}> "Café ☕")`;
    const repaired = `![TODO: describe image](<${source}> "Café ☕")`;
    const doc = `前文 😀 ${image} 後文\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`前文 😀 ${repaired} 後文\r\n`);
    expect(fixed).toContain(`(<${source}> "Café ☕")`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
  it.each([
    [
      "raw Unicode path with query and fragment",
      "📊 café.png?query=日本語#詳細",
      "Café report 前文 😀 ",
      " end.",
    ],
    ["emoji in path", "chart/⭐🖼️-stars.png", "See the gallery: ", " then done."],
    [
      "combining characters",
      "logos/naïve-résumé.png?lang=日本語",
      "View résumé: ",
      " complete.",
    ],
  ])("fixing an empty image description preserves the Unicode source and surrounding prose (%s)", (_name, source, before, after) => {
    const image = `![](${source})`;
    const repaired = `![TODO: describe image](${source})`;
    const doc = `# Title\r\n\r\n${before}${image}${after}\r\n`;
    const expected = `# Title\r\n\r\n${before}${repaired}${after}\r\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(expected).toContain(`](${source})`);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });
});

describe("autofix: undescribed image surrounded by Unicode text", () => {
  it.each([
    ["emoji modifiers & flags", "Hello 👋🏿 see ![](photo.png) then 🇯🇵 end"],
    ["combining characters", "cafe\u0301 ![](diagram.png) nice"],
    ["CJK run", "前文 ![](chart.png) 後文"],
    ["fullwidth ASCII", "Ｆｕｌｌｗｉｄｔｈ ![](image.png) Ｔｅｘｔ"],
    ["mixed scripts", "مرحبا ![](view.png) こんにちは"],
    ["surrounding punctuation", "— ![](icon.png) —"],
    ["zero-width joiner", "👨‍👩‍👧‍👦 ![](family.png) done"],
  ])("fixes and preserves surrounding text in %s context", (_name, line) => {
    for (const newline of ["\n", "\r\n"]) {
      const doc = `# Title${newline}${newline}${line}.${newline}`;
      const expected = doc
        .replace("![](photo.png)", "![TODO: describe image](photo.png)")
        .replace("![](diagram.png)", "![TODO: describe image](diagram.png)")
        .replace("![](chart.png)", "![TODO: describe image](chart.png)")
        .replace("![](image.png)", "![TODO: describe image](image.png)")
        .replace("![](view.png)", "![TODO: describe image](view.png)")
        .replace("![](icon.png)", "![TODO: describe image](icon.png)")
        .replace("![](family.png)", "![TODO: describe image](family.png)");

      const rules = [ruleMissingAltText];
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("missing-alt-text");

      // Extract the text before and after the image in the original doc
      const image = line.match(/!\[\]\([^)]+\)/)![0];
      const parts = line.split(image);
      const before = parts[0];
      const after = parts[1];

      const fixed = applyAllFixes(doc, violations);

      // Surrounding text must be preserved exactly
      expect(fixed).toContain(before);
      expect(fixed).toContain(after);

      // The placeholder must be inserted
      expect(fixed).toContain("![TODO: describe image]");

      // Exact expected output
      expect(fixed).toBe(expected);

      // Clean after fix
      expect(lintDocument(fixed, { rules })).toEqual([]);

      // Idempotent
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });
});

describe("rule:invalid-link-target CRLF document", () => {
  it.each([
    "",
    "   ",
    "#",
    "?",
  ])("replaces the invalid href %j and keeps every CRLF and the surrounding text", (href) => {
    const link = `[café guide](${href})`;
    const doc = `# Title\r\n\r\nSee ${link} for details — and more.\r\n  Indented tail.\r\n\r\n- item\r\n`;
    const expected = doc.replace(link, "[café guide](TODO)");
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(link);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // No bare LF introduced and no CR lost.
    expect(fixed.match(/\r\n/g)).toHaveLength(doc.match(/\r\n/g)!.length);
    expect(fixed.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["empty", "[draft]()"],
    ["whitespace", "[draft](   )"],
    ["question mark", "[draft](?)"],
  ])("sets the %s href to TODO at end of file without adding a final newline", (_name, link) => {
    const doc = `# Title\n\nRead ${link}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("# Title\n\nRead [draft](TODO)");
    expect(fixed.endsWith("\n")).toBe(false);
    expect(applyFix(doc, violations[0])).toBe(fixed);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["CJK and emoji", "日本語のテキスト 🎉 ", " 続きのテキスト 🚀"],
    ["accents and RTL", "Café naïve مرحبا ", " שלום Ünïcödé"],
    ["combining marks and ZWJ", "e\u0301 👨\u200d👩\u200d👧 ", " \u200b終わり"],
  ])("replaces an invalid href surrounded by Unicode text (%s) and preserves the text exactly", (_name, before, after) => {
    const doc = `# Title\n\n${before}[リンク 🔗](   )${after}\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`# Title\n\n${before}[リンク 🔗](TODO)${after}\n`);
    expect(applyFix(doc, violations[0])).toBe(fixed);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("rule:missing-alt-text CRLF document", () => {
  it.each([
    "",
    "   ",
    " \t ",
  ])("inserts the description for the missing alt %j and keeps every CRLF and the surrounding text", (alt) => {
    const image = `![${alt}](images/chart.png)`;
    const doc = `# Gallery\r\n\r\nSee ${image} for details — and more.\r\n  Indented tail.\r\n\r\n- item\r\n`;
    const expected = doc.replace(image, "![TODO: describe image](images/chart.png)");
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // No bare LF introduced and no CR lost.
    expect(fixed.match(/\r\n/g)).toHaveLength(doc.match(/\r\n/g)!.length);
    expect(fixed.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(fixed.length - doc.length).toBe("TODO: describe image".length - alt.length);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("describes the image mid-document while every other CRLF line stays byte-identical", () => {
    const image = '![](images/chart.png?size=2#preview "Chart")';
    const repaired = '![TODO: describe image](images/chart.png?size=2#preview "Chart")';
    const doc = [
      "# Gallery",
      "",
      "Intro café text.",
      "",
      `See ${image} for details.`,
      "After — keep `![](decoy.png)` code and ![described](ok.png) as is.",
      "",
    ].join("\r\n");
    const expected = [
      "# Gallery",
      "",
      "Intro café text.",
      "",
      `See ${repaired} for details.`,
      "After — keep `![](decoy.png)` code and ![described](ok.png) as is.",
      "",
    ].join("\r\n");
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The only edit is the inserted description: same line count, all CRLF.
    expect(fixed.split("\r\n")).toHaveLength(doc.split("\r\n").length);
    expect(fixed.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(fixed).toContain("`![](decoy.png)`");
    expect(fixed).toContain("![described](ok.png)");
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });

  it.each([
    ["empty", "![](end.png)", "![TODO: describe image](end.png)"],
    [
      "whitespace-only",
      '![  ](end.png "End")',
      '![TODO: describe image](end.png "End")',
    ],
  ])("describes the %s-alt image at end of a CRLF file without adding a final newline", (_name, image, repaired) => {
    const doc = `# Gallery\r\n\r\nBody.\r\n${image}`;
    const expected = doc.replace(image, repaired);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    // The CRLF lines before the image are untouched.
    expect(fixed.match(/\r\n/g)).toHaveLength(doc.match(/\r\n/g)!.length);
    expect(fixed.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("missing-alt-text autofix: idempotence for linked and angle-bracket images", () => {
  const rules = [ruleMissingAltText];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    "\n",
    "\r\n",
  ])("a second autofix produces exactly the first result with %j line endings", (nl) => {
    const doc = [
      "# Gallery",
      "",
      '[![](badge.svg)](https://example.com/build) and ![](<my pic.png> "Pic").',
      "Keep ![ok](c.png) and `![](decoy.png)` as is.",
      "",
    ].join(nl);
    const expected = [
      "# Gallery",
      "",
      '[![TODO: describe image](badge.svg)](https://example.com/build) and ![TODO: describe image](<my pic.png> "Pic").',
      "Keep ![ok](c.png) and `![](decoy.png)` as is.",
      "",
    ].join(nl);

    const once = fixPass(doc);
    expect(once).toBe(expected);
    expect(lintDocument(once, { rules })).toEqual([]);
    expect(fixPass(once)).toBe(once);
    expect(fixPass(fixPass(doc))).toBe(once);
  });
  it("inserts the description placeholder for an undescribed image and preserves CRLF endings", () => {
    const doc = "# Gallery\r\n\r\n![](images/chart.png)\r\nAfter the image.\r\n";
    const expected =
      "# Gallery\r\n\r\n![TODO: describe image](images/chart.png)\r\nAfter the image.\r\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Every line ending is still CRLF: no bare LF introduced or CR dropped.
    expect(fixed.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("autofixes a whitespace-only image description and is idempotent with %j line endings", (nl) => {
    const doc = [
      "# Gallery",
      "",
      `![  ](photo.jpg) and ![\t ](angle-bracket<chart.png>) done.`,
      "Keep ![Described](ok.png) as is.",
      "",
    ].join(nl);
    const expected = [
      "# Gallery",
      "",
      `![TODO: describe image](photo.jpg) and ![TODO: describe image](angle-bracket<chart.png>) done.`,
      "Keep ![Described](ok.png) as is.",
      "",
    ].join(nl);

    const once = fixPass(doc);
    expect(once).toBe(expected);
    expect(lintDocument(once, { rules })).toEqual([]);
    expect(fixPass(once)).toBe(once);
  });
});

describe("autofix: no-findings document", () => {
  const prose = [
    "---",
    "title: Field notes",
    "---",
    "",
    "# Field notes",
    "",
    "Ordinary prose, with punctuation; a [good link](https://example.com) and",
    "a described image: ![A red barn](barn.png).",
    "",
    "## Details",
    "",
    "Unicode stays put: café, naïve, 日本語, 🎉.",
    "",
  ];

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("leaves clean %s prose unchanged byte for byte", (_label, nl) => {
    const doc = prose.join(nl);
    const defaultRules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    for (const rules of [BUILTIN_RULES, defaultRules]) {
      const violations = lintDocument(doc, { rules });
      expect(violations).toEqual([]);
      expect(applyAllFixes(doc, violations)).toBe(doc);
    }
  });

  it("fixAllViolations returns clean prose as-is and records no history", () => {
    const doc = prose.join("\n");
    clearLintHistory();
    const violations = lintDocument(doc, { rules: BUILTIN_RULES });
    expect(fixAllViolations(doc, violations)).toBe(doc);
    expect(getLintHistory()).toEqual([]);
  });
});

describe("autofix: empty document", () => {
  const defaultRules = BUILTIN_RULES.filter((rule) =>
    LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
  );

  it("reports no violations and no applicable fixes for an empty document", () => {
    for (const rules of [BUILTIN_RULES, defaultRules]) {
      const violations = lintDocument("", { rules });
      expect(violations).toEqual([]);
      expect(violations.filter((v) => v.fix !== null)).toEqual([]);
    }
  });

  it("applyAllFixes returns an empty document unchanged", () => {
    expect(applyAllFixes("", [])).toBe("");
    expect(applyAllFixes("", lintDocument("", { rules: BUILTIN_RULES }))).toBe("");
  });

  it("fixAllViolations returns an empty document unchanged and records no history", () => {
    clearLintHistory();
    const violations = lintDocument("", { rules: BUILTIN_RULES });
    expect(fixAllViolations("", violations)).toBe("");
    expect(getLintHistory()).toEqual([]);
  });
});

// ─── Mixed valid and invalid links ───────────────────────────────────────────

describe("autofix: mixed valid and invalid links", () => {
  it("turns only the invalid href into TODO and leaves every valid link byte for byte", () => {
    const valid = [
      "[site](https://example.com/a_(b)?q=1#frag)",
      "[guide](./guide.md)",
      "[top](#top)",
    ];
    const fm = "---\ntitle: Guide\n---\n\n";
    const doc = `${fm}${valid[0]} then [broken]() and ${valid[1]}, [other](#) plus ${valid[2]}.\n`;
    const expected = `${fm}${valid[0]} then [broken](TODO) and ${valid[1]}, [other](TODO) plus ${valid[2]}.\n`;

    const violations = lintDocument(doc);
    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    for (const link of valid) expect(fixed).toContain(link);
    expect(lintDocument(fixed)).toEqual([]);
  });
});

// ─── Undescribed image with a directory in its relative path ─────────────────

describe("autofix: undescribed image with a nested relative path", () => {
  it.each([
    "docs/img/screens/overview.png",
    "./docs/img/overview.png",
    "../assets/img/overview.svg",
  ])("inserts the placeholder and keeps the path %j", (src) => {
    const doc = `# Guide\n\nSee ![](${src}) for details.\n`;
    const expected = `# Guide\n\nSee ![TODO: describe image](${src}) for details.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`](${src})`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

// ─── Undescribed image as the last block of a document ───────────────────────

describe("autofix: undescribed image at the end of a document", () => {
  it("describes a lone image without adding a trailing newline", () => {
    const doc = "![](image.png)";
    const violations = lintDocument(doc, { rules: [ruleMissingAltText] });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(applyAllFixes(doc, violations)).toBe("![TODO: describe image](image.png)");
  });

  it.each([
    "\n",
    "\r\n",
  ])("inserts the placeholder and keeps all preceding text (line endings %j)", (nl) => {
    const preceding = `# Café guide${nl}${nl}Intro with *emphasis* and [docs](./guide.md).${nl}${nl}Final figure:${nl}`;
    const doc = `${preceding}${nl}![](images/final.png)${nl}`;
    const expected = `${preceding}${nl}![TODO: describe image](images/final.png)${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.startsWith(preceding)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(expected);
  });

  it.each([
    "\n",
    "\r\n",
  ])("inserts the placeholder and keeps all preceding text when there is no final newline (line endings %j)", (nl) => {
    const preceding = `# End of notes${nl}${nl}Main text with [link](./ref.md) and *formatting*.${nl}${nl}Last paragraph before the figure:${nl}`;
    const doc = `${preceding}${nl}![](images/end.png)`;
    const expected = `${preceding}${nl}![TODO: describe image](images/end.png)`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(doc.endsWith("\n")).toBe(false);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(fixed.startsWith(preceding)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(expected);
  });

  it.each([
    ["LF, trailing newline", "\n", "\n"],
    ["LF, no trailing newline", "\n", ""],
    ["CRLF, trailing newline", "\r\n", "\r\n"],
    ["CRLF, no trailing newline", "\r\n", ""],
  ])("inserts the description placeholder and preserves the destination and final newline (%s)", (_name, nl, end) => {
    const dest = "photos/summary.png?width=1200";
    const body = `Line one.${nl}${nl}Line two with [link](./ref.md).${nl}`;
    const doc = `${body}![](${dest})${end}`;
    const expected = `${body}![TODO: describe image](${dest})${end}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`![](${dest})`);
    expect(to.offset).toBe(doc.length - end.length);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Acceptance: destination is preserved
    expect(fixed).toContain(`](${dest})`);
    // Acceptance: final newline (or lack thereof) is preserved
    expect(fixed.endsWith(end)).toBe(true);
    expect(fixed.length).toBe(doc.length + "TODO: describe image".length);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(expected);
  });

  it.each([
    "\n",
    "\r\n",
  ])("describes only the undescribed images after a described image and a code fence (line endings %j)", (nl) => {
    const preceding = [
      "# Café",
      "",
      "![Chart of café sales](images/chart.png)",
      "",
      "```md",
      "![](images/in-code.png)",
      "```",
      "",
      "Early ![](images/early.png) figure.",
      "",
      "Closing:",
      "",
    ].join(nl);
    const doc = `${preceding}![](images/last.png)`;
    const expected = `${preceding.replace("![](images/early.png)", "![TODO: describe image](images/early.png)")}![TODO: describe image](images/last.png)`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("![](images/in-code.png)");
    expect(fixed.endsWith(`${nl}![TODO: describe image](images/last.png)`)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

// ─── Invalid link as the last thing in a document with no final newline ──────

describe("autofix: invalid link in a document without a final newline", () => {
  it.each([
    ["empty href", "Intro line.\n\nSee [draft]()", "Intro line.\n\nSee [draft](TODO)"],
    [
      "blank href",
      "Intro line.\n\nSee [draft](  )",
      "Intro line.\n\nSee [draft](TODO)",
    ],
    [
      "tab-only href",
      "Intro line.\n\nSee [draft](	)",
      "Intro line.\n\nSee [draft](TODO)",
    ],
    [
      "CRLF",
      "Intro line.\r\n\r\nSee [draft]()",
      "Intro line.\r\n\r\nSee [draft](TODO)",
    ],
    [
      "Unicode label",
      "Intro.\n\nSee [café guide]()",
      "Intro.\n\nSee [café guide](TODO)",
    ],
  ])("sets the href to TODO and adds no final newline (%s)", (_name, doc, expected) => {
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(doc.endsWith("\n")).toBe(false);
    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(fixed.endsWith("](TODO)")).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["link is the whole document", "[draft]()", "[draft](TODO)"],
    ["link ends a list item", "- one\n- [draft](  )", "- one\n- [draft](TODO)"],
    [
      "valid link precedes it",
      "[ok](./a.md) and [draft]()",
      "[ok](./a.md) and [draft](TODO)",
    ],
  ])("fixes through applyFix and the default rule set without adding a final newline (%s)", (_name, doc, expected) => {
    // Default rules also report frontmatter-required here; only the link is fixable.
    const violations = lintDocument(doc).filter(
      ({ ruleId }) => ruleId === "invalid-link-target",
    );

    expect(violations).toHaveLength(1);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed).map(({ ruleId }) => ruleId)).not.toContain(
      "invalid-link-target",
    );
  });

  it.each([
    [
      "two invalid links, the last ends the file",
      "See [a]() and [b](#)",
      "See [a](TODO) and [b](TODO)",
    ],
    [
      "hash-only href after frontmatter",
      "---\ntitle: T\n---\n\n# T\n\nGo [here](#)",
      "---\ntitle: T\n---\n\n# T\n\nGo [here](TODO)",
    ],
    [
      "mixed CRLF with a valid sibling link",
      "[ok](./a.md)\r\n\r\n[draft](   )",
      "[ok](./a.md)\r\n\r\n[draft](TODO)",
    ],
  ])("fixes every invalid href and still adds no final newline (%s)", (_name, doc, expected) => {
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.length).toBeGreaterThan(0);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes a broken link with italic formatting at document end and adds no final newline", () => {
    const doc = "Intro.\n\nSee *[draft]()* for details";
    const expected = "Intro.\n\nSee *[draft](TODO)* for details";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(doc.endsWith("\n")).toBe(false);
    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(fixed.endsWith("TODO)* for details")).toBe(true);
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
  });

  it.each([
    [
      "link on an earlier line, before a plain-text tail",
      "See [draft]() now.\n\nTail text stays",
      "See [draft](TODO) now.\n\nTail text stays",
      1,
    ],
    [
      "a valid link follows the invalid one on the last line",
      "Fix [broken]() then keep [ok](./a.md)",
      "Fix [broken](TODO) then keep [ok](./a.md)",
      1,
    ],
    [
      "invalid links on two lines before a CRLF tail",
      "Fix [a](#) first.\r\n\r\nThen [b]() mid-doc.\r\n\r\nEnd stays",
      "Fix [a](TODO) first.\r\n\r\nThen [b](TODO) mid-doc.\r\n\r\nEnd stays",
      2,
    ],
  ])("replaces the destination away from the end of the file and still adds no final newline (%s)", (_name, doc, expected, count) => {
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(doc.endsWith("\n")).toBe(false);
    expect(violations).toHaveLength(count);
    expect(violations.every((v) => v.ruleId === "invalid-link-target")).toBe(true);
    expect(violations.every((v) => v.fix !== null)).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    // Everything after the last violation — including the absent final
    // newline — is byte-identical; only the href bytes changed.
    const tailStart = violations[violations.length - 1].range!.to.offset;
    expect(fixed.endsWith(doc.slice(tailStart))).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

// ─── Bracketed prose ─────────────────────────────────────────────────────────

describe("autofix: bracketed prose preservation", () => {
  const defaultRules = BUILTIN_RULES.filter((rule) =>
    LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
  );

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("leaves [sic] and other bracketed prose unchanged (%s)", (_label, nl) => {
    const doc = [
      "---",
      "title: Quotes",
      "---",
      "",
      "# Quotes",
      "",
      "He wrote that they was [sic] late, per the [editor's note] and [1].",
      "",
      "Brackets [at the start] and an empty [] pair stay put.",
      "",
    ].join(nl);
    for (const rules of [BUILTIN_RULES, defaultRules]) {
      const violations = lintDocument(doc, { rules });
      expect(violations).toEqual([]);
      expect(applyAllFixes(doc, violations)).toBe(doc);
    }
  });

  it("keeps [sic] intact while fixing a real broken link beside it", () => {
    const doc = "Teh [sic] word, see [guide]().\n";
    const rules = [ruleInvalidLinkTarget];
    const fixed = applyAllFixes(doc, lintDocument(doc, { rules }));
    expect(fixed).toBe("Teh [sic] word, see [guide](TODO).\n");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("keeps prose [sic] verbatim while an undescribed image beside it gets its placeholder (%s)", (_label, nl) => {
    const doc = [
      "---",
      "title: Errata",
      "---",
      "",
      'He wrote "we was" [sic]![](fig.png)[sic] — read verbatim.',
      "The margin reads [sic], quoting the errata.",
      "",
    ].join(nl);
    const expected = doc.replace("![](fig.png)", "![TODO: describe image](fig.png)");
    for (const rules of [BUILTIN_RULES, defaultRules]) {
      const violations = lintDocument(doc, { rules });

      // Bare [sic] is prose, not a link or part of the image: only the image is flagged.
      expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
      expect(
        doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
      ).toBe("![](fig.png)");
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(applyFix(doc, violations[0])).toBe(expected);
      expect(fixed).toContain("![TODO: describe image](fig.png)");
      expect(fixed.match(/TODO: describe image/g)).toHaveLength(1);
      expect(fixed.split("[sic]")).toHaveLength(doc.split("[sic]").length);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it.each([
    [
      "prose on both sides of the link",
      'He wrote "we was" [sic] and [sic] again, then broke [link]().',
      'He wrote "we was" [sic] and [sic] again, then broke [link](TODO).',
      "[link]()",
    ],
    [
      "prose adjacent to the link",
      "Teh [sic][broken]() end.",
      "Teh [sic][broken](TODO) end.",
      "[broken]()",
    ],
    [
      "link label also reads [sic]",
      'A quote "[sic]" next to a real link [sic]() here.',
      'A quote "[sic]" next to a real link [sic](TODO) here.',
      "[sic]()",
    ],
  ])("keeps prose [sic] verbatim while fixing an invalid link beside it (%s)", (_name, line, expectedLine, invalid) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `${line}${nl}`;
      const expected = `${expectedLine}${nl}`;
      const violations = lintDocument(doc, { rules: defaultRules });

      // Only the [label](href) form is a link: bare [sic] prose is never flagged.
      expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
      expect(
        doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
      ).toBe(invalid);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(applyFix(doc, violations[0])).toBe(expected);
      expect(fixed.split("[sic]")).toHaveLength(doc.split("[sic]").length);
      expect(lintDocument(fixed, { rules: defaultRules })).toEqual([]);
    }
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("turns an invalid href into TODO across multi-line prose and leaves other lines and breaks alone (%s)", (_label, nl) => {
    const doc = [
      "First line of prose, untouched.",
      "Second line says see [the guide]() for more",
      "and continues here with `[code]()` and [ok](./a.md).",
      "",
      "Last paragraph line.",
      "",
    ].join(nl);
    const expected = doc.replace("[the guide]()", "[the guide](TODO)");
    const rules = [ruleInvalidLinkTarget];
    const fixed = applyAllFixes(doc, lintDocument(doc, { rules }));
    expect(fixed).toBe(expected);
    expect(fixed.split(nl)).toHaveLength(doc.split(nl).length);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("valid image with Unicode alt text", () => {
  it.each([
    ["accented Latin", "Café résumé naïve"],
    ["CJK", "東京タワーの図 图表"],
    ["emoji and ZWJ sequence", "Team 👩‍💻 launch 🚀"],
    ["RTL", "رسم بياني"],
  ])("autofix leaves the image and its %s alt text unchanged", (_label, alt) => {
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    for (const nl of ["\n", "\r\n"]) {
      const doc = `# Title${nl}${nl}Intro ![${alt}](images/pic.png "Caption") end.${nl}`;
      const violations = lintDocument(doc, { rules });
      expect(violations).toEqual([]);
      expect(applyAllFixes(doc, violations)).toBe(doc);
    }
  });
});

describe("autofix: invalid link at the end of a document", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("sets the final paragraph's empty href to TODO and keeps all preceding prose byte-identical (%s)", (_name, nl) => {
    const prose = [
      "# Release notes",
      "",
      "Café déjà vu — see [changelog](./CHANGELOG.md) for *details*.",
      "",
      "```md",
      "[ignored]()",
      "```",
      "",
      "Last words, then the [broken link]()",
    ].join(nl);
    const doc = `${prose}${nl}`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    // Everything before the destination is untouched; only `()` became `(TODO)`.
    expect(fixed).toBe(`${prose.slice(0, -1)}TODO)${nl}`);
    expect(fixed.startsWith(prose.slice(0, prose.lastIndexOf("()") + 1))).toBe(true);
    expect(fixed).toContain("[ignored]()");
    expect(applyFix(doc, violations[0])).toBe(fixed);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: empty href on a link with an empty label", () => {
  const rules = [ruleInvalidLinkTarget];

  it("replaces the empty href with TODO, keeps the empty label, and leaves neighbouring links alone", () => {
    const doc = "Go [here]() or [](), then [ok](./a.md).\n";
    const expected = "Go [here](TODO) or [](TODO), then [ok](./a.md).\n";
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    const { from, to } = violations[1].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[]()");
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });
});

describe("autofix: invalid links in CRLF list and blockquote lines", () => {
  const rules = [ruleInvalidLinkTarget];

  it("inserts the TODO placeholder per line, never swallows a \\r, and keeps every CRLF intact", () => {
    const doc =
      "# Links\r\n\r\n- [first]()\r\n- [ok](./a.md)\r\n- [third](   )\r\n\r\n> [quoted](#)\r\n> tail\r\n";
    const expected =
      "# Links\r\n\r\n- [first](TODO)\r\n- [ok](./a.md)\r\n- [third](TODO)\r\n\r\n> [quoted](TODO)\r\n> tail\r\n";
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "invalid-link-target",
    ]);
    for (const v of violations) {
      const { from, to } = v.range!;
      const slice = doc.slice(from.offset, to.offset);
      expect(slice).not.toMatch(/[\r\n]/);
      expect(applyFix(doc, v)).toContain("(TODO)");
    }

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/\r\n/g)).toHaveLength(doc.match(/\r\n/g)!.length);
    expect(fixed.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });
});

describe("autofix: invalid link among valid links with repeated labels", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["\n"],
    ["\r\n"],
  ])("replaces only the invalid href when the same label appears before and after it (%j)", (nl) => {
    const validBefore = "[café guide](./guide.md)";
    const validAfter = "[café guide](https://example.com/guide#top)";
    const reference = "[café guide][ref]";
    const doc =
      `${validBefore} then [café guide](   ) then ${validAfter}.${nl}${nl}` +
      `Also ${reference}.${nl}${nl}[ref]: https://example.com/ref${nl}`;
    const expected = doc.replace("[café guide](   )", "[café guide](TODO)");

    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[café guide](   )");
    expect(doc.indexOf("[café guide](   )")).toBe(from.offset);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyFix(doc, violations[0])).toBe(expected);
    for (const link of [validBefore, validAfter, reference])
      expect(fixed).toContain(link);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: invalid links in a blockquote with mixed content", () => {
  const rules = [ruleInvalidLinkTarget];

  it("sets each invalid href to TODO and keeps every blockquote marker, list marker and valid link", () => {
    const doc = [
      "> ## Quoted [title]()",
      ">",
      "> See [first](   ) and [ok](./a.md).",
      "> - item [second]()",
      "> > nested [third](#)",
      "",
    ].join("\n");
    const expected = [
      "> ## Quoted [title](TODO)",
      ">",
      "> See [first](TODO) and [ok](./a.md).",
      "> - item [second](TODO)",
      "> > nested [third](TODO)",
      "",
    ].join("\n");

    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(4);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const markers = (text: string) =>
      text.split("\n").map((l) => l.match(/^(?:> ?)*/)?.[0]);
    expect(markers(fixed)).toEqual(markers(doc));
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("autofix: an invalid link inside a list item", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["*", "\n"],
    ["+", "\n"],
    ["1)", "\n"],
    ["10.", "\r\n"],
    ["  -", "\n"],
  ])("sets the href to TODO and keeps marker %j, the text around the link and line ending %j", (marker, nl) => {
    const lines = (href: string) => [
      "Intro.",
      "",
      `${marker} Before text [the **label**](${href}) after text, then more.`,
      `${marker} Untouched [ok](./a.md) item.`,
      "",
    ];
    const doc = lines("").join(nl);
    const expected = lines("TODO").join(nl);

    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(
      `${marker} Before text [the **label**](TODO) after text, then more.`,
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["-", "[ ]", ""],
    ["-", "[x]", "#"],
    ["*", "[ ]", "?"],
    ["  +", "[x]", "  "],
  ])("keeps the %j marker and the %j task box when the link follows the box directly (invalid href %j)", (marker, box, href) => {
    const doc = `Intro.\n${marker} ${box} [draft](${href}) today, see [ok](./a.md).\n${marker} ${box} Next item.\n`;
    const expected = `Intro.\n${marker} ${box} [draft](TODO) today, see [ok](./a.md).\n${marker} ${box} Next item.\n`;

    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    // The flagged span is the link alone: the marker and the box sit before it.
    expect(doc.slice(from.offset, to.offset)).toBe(`[draft](${href})`);
    expect(doc.slice(0, from.offset)).toBe(`Intro.\n${marker} ${box} `);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`${marker} ${box} [draft](TODO)`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["-", "-", ""],
    ["*", "*", "#"],
    ["+", "+", "?"],
    ["1.", "1.", " "],
  ])("keeps the %j marker when the invalid link's label repeats it (invalid href %j)", (marker, label, href) => {
    const doc = `Intro.\n${marker} [${label}](${href}) is kept, [ok](./a.md) too.\n`;
    const expected = `Intro.\n${marker} [${label}](TODO) is kept, [ok](./a.md) too.\n`;

    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    // The link is the second marker-shaped token on the line; the real
    // marker at column 0 is outside the flagged span.
    expect(doc.slice(from.offset, to.offset)).toBe(`[${label}](${href})`);
    expect(doc.slice(0, from.offset)).toBe(`Intro.\n${marker} `);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`${marker} [${label}](TODO)`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    "\n",
    "\r\n",
  ])("keeps the marker when the item's whole content is an empty-label invalid link (line ending %j)", (nl) => {
    const doc = `List:${nl}- []()${nl}- [ok](./a.md)${nl}`;
    const expected = `List:${nl}- [](TODO)${nl}- [ok](./a.md)${nl}`;

    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[]()");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("- [](TODO)");
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["-", "\n"],
    ["1.", "\r\n"],
  ])("keeps the %j marker when the list item opens the document (line ending %j)", (marker, nl) => {
    const doc = `${marker} Read [draft]() today.${nl}${marker} [ok](./a.md)${nl}`;
    const expected = `${marker} Read [draft](TODO) today.${nl}${marker} [ok](./a.md)${nl}`;

    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[draft]()");
    // Everything before the link, marker included, is untouched.
    expect(doc.slice(0, from.offset)).toBe(`${marker} Read `);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it("keeps the marker when another rule's fix lands on the same list item line", () => {
    const both = [ruleInvalidLinkTarget, ruleNoTrailingSpaces];
    const doc = "- See [docs]() for details.   \n- [ok](./a.md)\n";
    const expected = "- See [docs](TODO) for details.\n- [ok](./a.md)\n";

    const violations = lintDocument(doc, { rules: both });

    // The trailing-spaces fix and the link fix share the line; the link fix
    // applies first (later offsets last) and neither touches the marker.
    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "no-trailing-spaces",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules: both })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules: both }))).toBe(fixed);
  });

  it("fixes parent and nested items and keeps both markers and the indentation", () => {
    const doc = "- Parent [p]() link.\n  - Child [c](#) here.\n- [ok](./a.md)\n";
    const expected =
      "- Parent [p](TODO) link.\n  - Child [c](TODO) here.\n- [ok](./a.md)\n";

    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(
      violations.map((v) => doc.slice(v.range!.from.offset, v.range!.to.offset)),
    ).toEqual(["[p]()", "[c](#)"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("autofix: a described image with no other findings", () => {
  const defaultRules = BUILTIN_RULES.filter((rule) =>
    LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
  );

  it.each([
    ["no final newline", "![Quarterly revenue chart](images/revenue.png)"],
    ["LF final newline", "![Quarterly revenue chart](images/revenue.png)\n"],
    ["CRLF final newline", "![Quarterly revenue chart](images/revenue.png)\r\n"],
    [
      "title and Unicode alt",
      '![Café revenue *chart*](images/café.png?v=2#top "Revenue")\n',
    ],
    [
      "heading and prose around it",
      "# Report\n\nIntro text.\n\n![Revenue by quarter](rev.png)\n\nClosing text.\n",
    ],
  ])("reports nothing and returns the complete input unchanged (%s)", (_name, doc) => {
    for (const rules of [[ruleMissingAltText], defaultRules]) {
      const violations = lintDocument(doc, { rules });
      expect(violations).toEqual([]);
      expect(applyAllFixes(doc, violations)).toBe(doc);
    }
  });

  it.each([
    "\n",
    "\r\n",
  ])("describes an undescribed image at the start of a later line and leaves the following text unchanged with %j line endings", (newline) => {
    const before = `Intro café.${newline}`;
    const image = "![](images/chart.png)";
    const following = ` then *more* text, see [link](https://example.com).${newline}Last line. ☕${newline}`;
    const doc = before + image + following;
    const expected = `${before}![TODO: describe image](images/chart.png)${following}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(violations[0].range?.from.offset).toBe(before.length);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith(following)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    [false, "\n"],
    [true, "\n"],
    [false, "\r\n"],
    [true, "\r\n"],
  ])("describes only the undescribed image and keeps a described image exactly beside it (described first: %s, %j)", (describedFirst, newline) => {
    const described = '![Café *chart*](images/caf%C3%A9.png?size=2#a "Chart (v2)")';
    const undescribed = '![](images/other.png "Other")';
    const repaired = '![TODO: describe image](images/other.png "Other")';
    const pair = (a: string, b: string) =>
      describedFirst ? `${a} and ${b}` : `${b} and ${a}`;
    const doc = `Intro café.${newline}${newline}See ${pair(described, undescribed)}, done.${newline}`;
    const expected = `Intro café.${newline}${newline}See ${pair(described, repaired)}, done.${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(violations[0].range?.from.offset).toBe(doc.indexOf(undescribed));
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(described);
    expect(fixed.split("TODO: describe image")).toHaveLength(2);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("describes an undescribed image and leaves unrelated prose and line breaks on separate lines untouched (%j)", (newline) => {
    const image = '![](images/chart.png "Chart")';
    const repaired = '![TODO: describe image](images/chart.png "Chart")';
    const prose = "Unrelated café prose, with *emphasis* and trailing spaces.  ";
    const doc = `${prose}${newline}${image}${newline}${prose}${newline}`;
    const expected = `${prose}${newline}${repaired}${newline}${prose}${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.split(newline)).toHaveLength(doc.split(newline).length);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: mixed described and undescribed images across paragraphs", () => {
  it.each([
    "\n",
    "\r\n",
  ])("fixes the undescribed image and leaves the described image byte-identical in separate paragraphs (%j)", (newline) => {
    const described = '![Quarterly revenue chart](images/revenue.png "Q3 results")';
    const undescribed = "![](images/roadmap.png)";
    const repaired = "![TODO: describe image](images/roadmap.png)";
    const doc =
      `# Report${newline}${newline}` +
      `Here is the ${described} from last quarter.${newline}${newline}` +
      `And the ${undescribed} for next quarter.${newline}${newline}`;
    const expected =
      `# Report${newline}${newline}` +
      `Here is the ${described} from last quarter.${newline}${newline}` +
      `And the ${repaired} for next quarter.${newline}${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    // Only the undescribed image is flagged.
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].range?.from.offset).toBe(doc.indexOf(undescribed));

    // Autofix changes only the undescribed image.
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);

    // Described image is byte-for-byte identical.
    expect(fixed.slice(0, fixed.indexOf(repaired))).toBe(
      doc.slice(0, doc.indexOf(undescribed)),
    );
    expect(fixed.slice(fixed.indexOf(repaired) + repaired.length)).toBe(
      doc.slice(doc.indexOf(undescribed) + undescribed.length),
    );

    expect(fixed.split("TODO: describe image")).toHaveLength(2);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes multiple undescribed images while preserving described ones in different sections", () => {
    const described1 = "![Team photo](images/team.jpg)";
    const undescribed1 = "![](images/chart.png)";
    const described2 = '![Logo](https://cdn.example.com/logo.svg "Company logo")';
    const undescribed2 = "![](images/flow.png)";
    const repaired1 = "![TODO: describe image](images/chart.png)";
    const repaired2 = "![TODO: describe image](images/flow.png)";
    const doc = [
      "# Agenda",
      "",
      `Photo: ${described1}.`,
      "",
      `Chart: ${undescribed1}.`,
      "",
      `## Next`,
      "",
      `${described2} and ${undescribed2}.`,
      "",
    ].join("\n");

    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.ruleId === "missing-alt-text")).toBe(true);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toContain(described1);
    expect(fixed).toContain(described2);
    expect(fixed).toContain(repaired1);
    expect(fixed).toContain(repaired2);
    expect(fixed.split("TODO: describe image")).toHaveLength(3);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("rule:invalid-link-target — invalid link beside a valid link", () => {
  it.each([
    ["invalid first", "[broken]()", "[fine](https://example.com/ok)"],
    ["valid first", "[fine](https://example.com/ok)", "[broken](   )"],
  ])("sets only the invalid href to TODO and leaves the valid link unchanged (%s)", (_name, a, b) => {
    const doc = `Links: ${a} and ${b}.\n`;
    const expected = doc
      .replace("[broken]()", "[broken](TODO)")
      .replace("[broken](   )", "[broken](TODO)");
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("[broken](TODO)");
    expect(fixed).toContain("[fine](https://example.com/ok)");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("invalid-link autofix: whitespace-only href beside a code span", () => {
  it.each([
    "\n",
    "\r\n",
  ])("sets the real link's href to TODO, keeps its label, and leaves a lookalike inside a code span unchanged with %j line endings", (nl) => {
    const doc = `Use \`[sample](   )\` as text, then open [real guide](   ) now.${nl}Done.${nl}`;
    const expected = `Use \`[sample](   )\` as text, then open [real guide](TODO) now.${nl}Done.${nl}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[real guide](   )");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(expected);
  });
});

describe("rule:invalid-link-target empty href inside a table cell", () => {
  it.each([
    ["\n"],
    ["\r\n"],
  ])("keeps the label, uses the TODO href and leaves the table row intact with %j line endings", (nl) => {
    const doc = [
      "| Name | Link |",
      "| ---- | ---- |",
      "| `code` label | [the guide page]() |",
      "| ok | [ok](./ok.md) |",
      "",
    ].join(nl);
    const expected = doc.replace("[the guide page]()", "[the guide page](TODO)");
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[the guide page]()");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("[the guide page](TODO) |");
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("rule:invalid-link-target invalid href with Unicode label inside a table cell", () => {
  it.each([
    ["empty", ""],
    ["whitespace-only", " \t "],
    ["lone hash", "#"],
    ["lone question mark", "?"],
  ])("fixes a %s destination, keeps the Unicode label byte-for-byte and leaves the row intact", (_name, href) => {
    for (const nl of ["\n", "\r\n"]) {
      const label = "利用ガイド café 👩🏽‍💻";
      const link = `[${label}](${href})`;
      const doc = [
        "| 名前 | リンク |",
        "| ---- | ------ |",
        `| 概要 | ${link} — see [ok](./ok.md) |`,
        "",
      ].join(nl);
      const expected = doc.replace(link, `[${label}](TODO)`);
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
      const { from, to } = violations[0].range!;
      // The reported range spans the whole link, Unicode label included.
      expect(doc.slice(from.offset, to.offset)).toBe(link);
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // The label is preserved exactly around the repaired destination.
      expect(fixed).toContain(`[${label}](TODO)`);
      expect(fixed).toContain("[ok](./ok.md)");
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });
});

describe("invalid link and unrelated prose on separate lines", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("changes only the invalid href: prose lines and breaks stay byte-identical (%s)", (_name, nl) => {
    const prose1 = "Unrelated prose: café ☕, 100% *sure*, a_b_c & <b>tags</b>.";
    const prose2 = "More prose; (parens) and [brackets] without a link.";
    const link = "[the guide](   )";
    const doc = [prose1, link, prose2, ""].join(nl);
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(violations[0].range!.from.line).toBe(2);
    const fixed = applyAllFixes(doc, violations);

    // Only the href differs: removing the changed span leaves identical text.
    expect(fixed).toBe([prose1, "[the guide](TODO)", prose2, ""].join(nl));
    expect(fixed.split(nl)).toHaveLength(doc.split(nl).length);
    expect(fixed.split(nl)[0]).toBe(prose1);
    expect(fixed.split(nl)[2]).toBe(prose2);
    expect(fixed.length - doc.length).toBe("TODO".length - "   ".length);
    expect(applyFix(doc, violations[0])).toBe(fixed);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("invalid link followed by a newline and ordinary prose", () => {
  it.each([
    ["empty", ""],
    ["whitespace-only", " \t "],
    ["lone hash", "#"],
    ["lone question mark", "?"],
  ])("rewrites only the %s href; the line break and the prose line stay byte-identical", (_name, href) => {
    for (const nl of ["\n", "\r\n"]) {
      const link = `[guide](${href})`;
      const prose = "Ordinary prose follows — see [1] and [ok](./ok.md), then done.";
      const doc = `${link}${nl}${prose}${nl}`;
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
      const { from, to } = violations[0].range!;
      expect(from).toMatchObject({ line: 1, col: 0, offset: 0 });
      expect(doc.slice(from.offset, to.offset)).toBe(link);

      const expected = `[guide](TODO)${nl}${prose}${nl}`;
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // Everything after the repaired link — the line break and all of the
      // prose line, valid link and bracketed citation included — is
      // byte-for-byte the original tail.
      expect(fixed.slice("[guide](TODO)".length)).toBe(doc.slice(to.offset));
      expect(fixed.split(nl)).toHaveLength(doc.split(nl).length);
      expect(lintDocument(fixed, { rules })).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });
});

describe("invalid link preceded by ordinary text", () => {
  it.each([
    ["empty", ""],
    ["whitespace-only", " \t "],
    ["lone hash", "#"],
    ["lone question mark", "?"],
  ])("rewrites only the %s destination; the preceding text and the label stay byte-identical", (_name, href) => {
    for (const nl of ["\n", "\r\n"]) {
      const lead = "Ordinary prose comes first — see [1] and (note), then ";
      const link = `[the full guide](${href})`;
      const doc = `${lead}${link}${nl}`;
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
      const { from, to } = violations[0].range!;
      // The reported range covers the link alone, not the prose before it.
      expect(doc.slice(from.offset, to.offset)).toBe(link);
      expect(to.offset).toBe(doc.length - nl.length);

      const expected = `${lead}[the full guide](TODO)${nl}`;
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // Every byte before the link — all of the prose — is unchanged, and
      // the label sits at the same offset with the destination replaced.
      expect(fixed.slice(0, from.offset)).toBe(doc.slice(0, from.offset));
      expect(fixed.slice(from.offset)).toBe(`[the full guide](TODO)${nl}`);
      expect(fixed.split(nl)).toHaveLength(doc.split(nl).length);
      expect(lintDocument(fixed, { rules })).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });

  it("fixes an invalid link abutting ordinary text and a multiline lead without touching either", () => {
    for (const nl of ["\n", "\r\n"]) {
      const lead = [
        "# Notes",
        "",
        "First a plain sentence with (parens) and [1].",
        "",
      ].join(nl);
      const doc = `${lead}end of clause.[draft](#) done.${nl}`;
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe("[draft](#)");
      // "end of clause." is ordinary text that touches the link's bracket.
      expect(doc.slice(0, from.offset)).toBe(`${lead}end of clause.`);

      const expected = `${lead}end of clause.[draft](TODO) done.${nl}`;
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed.slice(0, from.offset)).toBe(doc.slice(0, from.offset));
      expect(fixed.indexOf("[draft]")).toBe(from.offset);
      expect(fixed.match(/\]\(TODO\)/g)).toHaveLength(1);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });
});

describe("invalid-link-target autofix: idempotence across document shapes", () => {
  const rules = [ruleInvalidLinkTarget];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    ["adjacent links", "[x]( )[y]()\n", "[x](TODO)[y](TODO)\n"],
    ["nested list items", "- [x]()\n  - [y](#)\n", "- [x](TODO)\n  - [y](TODO)\n"],
    [
      "links mixed with an image",
      "a [x]() [y](#) [z](?) ![i]() \n",
      "a [x](TODO) [y](TODO) [z](TODO) ![i](TODO) \n",
    ],
  ])("fixes %s once and a second pass changes nothing", (_name, doc, expected) => {
    const once = fixPass(doc);
    expect(once).toBe(expected);
    expect(fixPass(once)).toBe(once);
    expect(lintDocument(once, { rules })).toEqual([]);
  });

  it.each([
    "a [x](<>) b\n",
    'a [x](# "t") b\n',
  ])("leaves %j byte-identical on every pass", (doc) => {
    expect(fixPass(doc)).toBe(doc);
    expect(fixPass(fixPass(doc))).toBe(doc);
  });
});

describe("autofix preserves plain prose (no links or images)", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    ["single sentence", "Just a plain sentence.\n"],
    [
      "multi-paragraph",
      "First paragraph.\n\nSecond paragraph, with commas; and more.\n",
    ],
    ["brackets and parens without link syntax", "see [1] and (note) or [a] (b) here\n"],
    ["no trailing newline", "no newline at end"],
    ["CRLF line endings", "line one\r\nline two\r\n"],
    ["unicode and emoji", "café — naïve 日本語 🎉\n"],
  ])("leaves %s byte-for-byte unchanged", (_name, doc) => {
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(fixPass(doc)).toBe(doc);
    expect(fixPass(fixPass(doc))).toBe(doc);
  });
});

describe("autofix preserves plain numeric bracket annotations", () => {
  const linkRules = [ruleInvalidLinkTarget, ruleMissingAltText];
  const linkFix = (text: string) =>
    applyAllFixes(text, lintDocument(text, { rules: linkRules }));

  it.each([
    ["lone [1]", "[1]\n"],
    ["[1] inside a sentence", "As shown in prior work [1], results hold.\n"],
    ["multiple numeric markers", "See [1], [2] and [10].\n"],
    ["adjacent numeric markers", "Cited by [1][2] together.\n"],
    ["range marker", "Refs [1-3] apply.\n"],
    ["numeric marker before parens", "value [1] (approx) here\n"],
    ["numeric marker at line start and end", "[1] starts and ends [2]\n"],
  ])("leaves %s byte-for-byte unchanged", (_name, doc) => {
    expect(lintDocument(doc, { rules: linkRules })).toEqual([]);
    expect(linkFix(doc)).toBe(doc);
    expect(linkFix(linkFix(doc))).toBe(doc);
  });

  it("preserves [1] while still fixing a real violation on the same line", () => {
    const doc = "Claim [1] here.   \n";
    const fixed = applyAllFixes(doc, lintDocument(doc));
    expect(fixed).toContain("Claim [1] here.\n");
  });
});

// ─── Valid relative links survive autofix untouched ──────────────────────────

describe("autofix: valid relative link preservation", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
  const fix = (doc: string) => applyAllFixes(doc, lintDocument(doc, { rules }));

  it.each([
    ["sibling file", "See the [guide](./guide.md) for details.\n"],
    ["parent directory", "Back to [index](../index.md) now.\n"],
    ["nested path with anchor", "Read [setup](docs/setup/install.md#linux) first.\n"],
    ["bare anchor", "Jump to [below](#section) quickly.\n"],
    ["link with title", 'Use [api](./api.md "API ref") daily.\n'],
  ])("leaves a %s link and surrounding text byte-for-byte unchanged", (_name, doc) => {
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(fix(doc)).toBe(doc);
  });

  it("keeps the relative link exact while fixing trailing spaces elsewhere", () => {
    const doc = "# Title\n\nSee [guide](./docs/guide.md) here.\nTrailing   \n";
    expect(fix(doc)).toBe("# Title\n\nSee [guide](./docs/guide.md) here.\nTrailing\n");
  });

  it.each([
    ["query string", "Open [view](./page.md?tab=2) now.\n"],
    ["CRLF line endings", "Read [guide](../docs/guide.md) now.\r\n"],
    ["inside a list item", "- Read [guide](./a/b.md#x) then stop.\n"],
  ])("leaves a relative link with %s unchanged", (_name, doc) => {
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(fix(doc)).toBe(doc);
  });

  it("fixes an empty link while preserving a relative link on the same line", () => {
    const doc = "See [broken]() and [guide](./docs/guide.md) both.\n";
    const fixed = fix(doc);
    expect(fixed).toBe("See [broken](TODO) and [guide](./docs/guide.md) both.\n");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("preserves a deeply nested relative link while fixing trailing spaces elsewhere", () => {
    const doc = "# Title\n\nSee [config](../../src/config.md) here.\nTrailing   \n";
    expect(fix(doc)).toBe(
      "# Title\n\nSee [config](../../src/config.md) here.\nTrailing\n",
    );
  });

  it("keeps a relative link and surrounding prose unchanged in a document with front matter", () => {
    const doc =
      "---\ntitle: Manual\n---\n\nRead the [setup guide](./getting-started/setup.md) first.\n";
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(fix(doc)).toBe(doc);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("leaves a bare link to guide.md and its surrounding text unchanged (%s)", (_name, nl) => {
    const link = "[guide](guide.md)";
    const doc = `---${nl}title: Manual${nl}---${nl}${nl}# Manual${nl}${nl}Read the ${link} first, then continue here.${nl}`;
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(fix(doc)).toBe(doc);
    expect(fix(doc)).toContain(link);
    expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
  });

  it("keeps a guide.md link and its surrounding text intact while fixing an empty link on the same line", () => {
    const link = "[guide](guide.md)";
    const doc = `Read ${link} and [broken]() today.\n`;
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`Read ${link} and [broken](TODO) today.\n`);
    expect(fixed).toContain(link);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

// ─── Fragment links survive autofix untouched ──────────────────────────────

describe("autofix: fragment-link preservation", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
  const fix = (doc: string) => applyAllFixes(doc, lintDocument(doc, { rules }));

  it("verifies that a link such as [section](#section) remains unchanged", () => {
    const doc = "See [section](#section) for details.\n";
    const violations = lintDocument(doc, { rules });
    expect(violations).toEqual([]);
    expect(fix(doc)).toBe(doc);
  });

  it.each([
    ["exact match", "Jump to [section](#section) quickly.\n"],
    ["different text and anchor", "Go to [top](#top).\n"],
    ["with heading prefix", "Read [Introduction](#introduction) first.\n"],
    ["CRLF line endings", "Jump to [section](#section) now.\r\n"],
  ])("leaves a fragment link %s and surrounding text byte-for-byte unchanged", (_name, doc) => {
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(fix(doc)).toBe(doc);
  });

  it("keeps the fragment link exact while fixing a trailing-space violation elsewhere", () => {
    const doc = "# Title\n\nSee [section](#section) here.\nTrailing   \n";
    expect(fix(doc)).toBe("# Title\n\nSee [section](#section) here.\nTrailing\n");
  });

  it("fixes an invalid empty link while preserving a valid fragment link on the same line", () => {
    const doc = "See [broken]() and [section](#section) both.\n";
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("See [broken](TODO) and [section](#section) both.\n");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

// ─── [sic] prose annotation survives autofix untouched ───────────────────────

describe("autofix: [sic] prose preservation", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
  const fix = (doc: string) => applyAllFixes(doc, lintDocument(doc, { rules }));

  it.each([
    ["inline quote", 'He wrote "teh quick fox" [sic] in the memo.\n'],
    ["italic variant", "The sign said *recieve* [_sic_] at the door.\n"],
    ["end of sentence", 'They were "definately" right [sic].\n'],
    ["uppercase", 'Quoted as written: "alot" [SIC] and moved on.\n'],
  ])("leaves a %s [sic] annotation and surrounding prose unchanged", (_name, doc) => {
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(fix(doc)).toBe(doc);
  });

  it.each([
    [
      "after the link",
      "See [the guide]() [sic] for details.\n",
      "See [the guide](TODO) [sic] for details.\n",
    ],
    [
      "before the link",
      "Teh [sic] [the guide]() says so.\n",
      "Teh [sic] [the guide](TODO) says so.\n",
    ],
    [
      "on both sides",
      "A [sic] [the guide]() [sic], then more.\n",
      "A [sic] [the guide](TODO) [sic], then more.\n",
    ],
    [
      "touching the link",
      "Read [the guide]()[sic] now.\n",
      "Read [the guide](TODO)[sic] now.\n",
    ],
  ])("repairs an invalid link and preserves a [sic] annotation %s", (_name, doc, expected) => {
    const violations = lintDocument(doc, { rules });
    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/\[sic\]/g)).toHaveLength(doc.match(/\[sic\]/g)!.length);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(fix(fixed)).toBe(fixed);
  });

  it("keeps [sic] exact while fixing trailing spaces elsewhere", () => {
    const doc = 'Said "wich" [sic] again.   \nNext line.\n';
    expect(fix(doc)).toBe('Said "wich" [sic] again.\nNext line.\n');
  });

  it("leaves [sic] in a heading, quote, list item and code span unchanged while fixing the invalid links beside them", () => {
    const doc = [
      '## He said "teh" [sic]',
      "",
      "> Quoted teh [sic] here, per [draft]().",
      "",
      "- Item wich [sic], see [notes]().",
      "",
      "Code says `[sic]()` while prose says [broken]().",
      "",
    ].join("\n");
    const expected = [
      '## He said "teh" [sic]',
      "",
      "> Quoted teh [sic] here, per [draft](TODO).",
      "",
      "- Item wich [sic], see [notes](TODO).",
      "",
      "Code says `[sic]()` while prose says [broken](TODO).",
      "",
    ].join("\n");
    const violations = lintDocument(doc, { rules });
    // The `[sic]()` in the code span is code, not a link, so it is not flagged.
    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "invalid-link-target",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/\[sic\]/g)).toHaveLength(4);
    for (const prose of [
      '## He said "teh" [sic]',
      "> Quoted teh [sic] here",
      "- Item wich [sic], see",
      "`[sic]()`",
    ])
      expect(fixed).toContain(prose);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(fix(fixed)).toBe(fixed);
  });

  it("leaves every [sic] and its surrounding prose unchanged across a multi-block document under the full default rule set", () => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = [
        "---",
        "title: Quotes",
        "---",
        "",
        "# Quotes",
        "",
        'He wrote "teh quick fox" [sic] in the memo; see [draft]() and ![](chart.png).   ',
        "",
        'They were "definately" right [sic], per [notes](#) below.',
        "",
        "- wich [sic] item",
        "",
      ].join(nl);
      const expected = [
        "---",
        "title: Quotes",
        "---",
        "",
        "# Quotes",
        "",
        'He wrote "teh quick fox" [sic] in the memo; see [draft](TODO) and ![TODO: describe image](chart.png).',
        "",
        'They were "definately" right [sic], per [notes](TODO) below.',
        "",
        "- wich [sic] item",
        "",
      ].join(nl);

      const violations = lintDocument(doc);
      expect(violations.map((v) => v.ruleId)).toEqual([
        "invalid-link-target",
        "missing-alt-text",
        "no-trailing-spaces",
        "invalid-link-target",
      ]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed.match(/\[sic\]/g)).toHaveLength(3);
      for (const prose of [
        '"teh quick fox" [sic] in the memo',
        "right [sic], per [notes]",
        "- wich [sic] item",
      ])
        expect(fixed).toContain(prose);
      expect(lintDocument(fixed)).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed))).toBe(fixed);
    }
  });

  it("keeps [sic] inside a valid link title and as a valid link label while fixing an invalid link", () => {
    const doc = 'See [guide](./guide.md "[sic]") and [sic](#errata), then [draft]().\n';
    const expected =
      'See [guide](./guide.md "[sic]") and [sic](#errata), then [draft](TODO).\n';
    const violations = lintDocument(doc, { rules });

    // Only [draft]() is a violation: the title's "[sic]" sits inside a valid
    // link destination and [sic](#errata) is a real fragment link.
    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe("[draft]()");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(fixed).toContain('[guide](./guide.md "[sic]")');
    expect(fixed).toContain("[sic](#errata)");
    expect(fixed.match(/\[sic\]/g)).toHaveLength(2);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(fix(fixed)).toBe(fixed);
  });
});

// ─── [1] footnote reference survives autofix untouched ──────────────────────

describe("autofix: [1] prose preservation", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
  const fix = (doc: string) => applyAllFixes(doc, lintDocument(doc, { rules }));

  it.each([
    ["standalone sentence", "As shown in prior work [1], results hold.\n"],
    ["multiple references", "See [1], [2] and [10] for details.\n"],
    ["at line start and end", "[1] starts and ends [2]\n"],
  ])("leaves a %s [1] annotation and surrounding prose unchanged", (_name, doc) => {
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(fix(doc)).toBe(doc);
  });

  it.each([
    [
      "after the link",
      "See [the guide]() [1] for details.\n",
      "See [the guide](TODO) [1] for details.\n",
    ],
    [
      "before the link",
      "Per [1] [the guide]() says so.\n",
      "Per [1] [the guide](TODO) says so.\n",
    ],
    [
      "on both sides",
      "A [1] [the guide]() [2], then more.\n",
      "A [1] [the guide](TODO) [2], then more.\n",
    ],
    [
      "touching the link",
      "Read [the guide]()[1] now.\n",
      "Read [the guide](TODO)[1] now.\n",
    ],
  ])("repairs an invalid link and preserves a [1] annotation %s", (_name, doc, expected) => {
    const violations = lintDocument(doc, { rules });
    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/\[\d+\]/g)).toHaveLength(doc.match(/\[\d+\]/g)!.length);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(fix(fixed)).toBe(fixed);
  });

  it("keeps [1] intact while fixing trailing spaces elsewhere", () => {
    const doc = "Claim [1] here.   \nNext line.\n";
    expect(fix(doc)).toBe("Claim [1] here.\nNext line.\n");
  });

  it("leaves every [1] and its surrounding prose unchanged across a multi-block document under the full default rule set", () => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = [
        "---",
        "title: Citations",
        "---",
        "",
        "# Citations",
        "",
        "Intro paragraph.",
        "",
        "## Results [1]",
        "",
        "Per [1] and [2], growth holds; see [draft]() and ![](chart.png).   ",
        "",
        "> Cited [1] here, per [notes](#).",
        "",
        "- Claim [1] again, see [source]().",
        "",
        "Code shows `[1]()` while prose says [broken]().",
        "",
      ].join(nl);
      const expected = [
        "---",
        "title: Citations",
        "---",
        "",
        "# Citations",
        "",
        "Intro paragraph.",
        "",
        "## Results [1]",
        "",
        "Per [1] and [2], growth holds; see [draft](TODO) and ![TODO: describe image](chart.png).",
        "",
        "> Cited [1] here, per [notes](TODO).",
        "",
        "- Claim [1] again, see [source](TODO).",
        "",
        "Code shows `[1]()` while prose says [broken](TODO).",
        "",
      ].join(nl);

      const violations = lintDocument(doc);
      expect(violations.map((v) => v.ruleId)).toEqual([
        "invalid-link-target",
        "missing-alt-text",
        "no-trailing-spaces",
        "invalid-link-target",
        "invalid-link-target",
        "invalid-link-target",
      ]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed.match(/\[\d+\]/g)).toHaveLength(doc.match(/\[\d+\]/g)!.length);
      for (const prose of [
        "## Results [1]",
        "Per [1] and [2], growth holds",
        "> Cited [1] here",
        "- Claim [1] again",
        "`[1]()`",
      ])
        expect(fixed).toContain(prose);
      expect(lintDocument(fixed)).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed))).toBe(fixed);
    }
  });
});

describe("autofix: invalid link at the end of a document", () => {
  const rules = [ruleInvalidLinkTarget];
  const head = "# Notes\n\nSee [ok](./a.md) and *emphasis* first.\n\n";

  it.each([
    ["LF, trailing newline", "\n", "\n"],
    ["LF, no trailing newline", "\n", ""],
    ["CRLF, trailing newline", "\r\n", "\r\n"],
    ["CRLF, no trailing newline", "\r\n", ""],
  ])("replaces the empty href with TODO and changes nothing else (%s)", (_name, nl, end) => {
    const prefix = head.replace(/\n/g, nl);
    const doc = `${prefix}Last: [final link]()${end}`;
    const expected = `${prefix}Last: [final link](TODO)${end}`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[final link]()");
    expect(to.offset).toBe(doc.length - end.length);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.length).toBe(doc.length + "TODO".length);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "",
    "   ",
    "#",
    "?",
  ])("repairs an invalid href %j in the final line without adding a newline", (href) => {
    const doc = `Intro.\n\nRead [broken](${href}) and [valid](./guide.md).`;
    const expected = "Intro.\n\nRead [broken](TODO) and [valid](./guide.md).";
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("fixes a document that is only an invalid link", () => {
    const doc = "[only]()";
    expect(applyAllFixes(doc, lintDocument(doc, { rules }))).toBe("[only](TODO)");
  });
});

describe("rule:missing-alt-text image alone in an unordered list item", () => {
  it.each([
    ["-", "\n"],
    ["*", "\r\n"],
    ["+", "\n"],
  ])("adds the placeholder and keeps marker %j, destination and neighbouring items (line ending %j)", (marker, nl) => {
    const dest = 'images/diagram%20one.png?view=full#data "Diagram"';
    const doc = [
      `${marker} Intro item`,
      `${marker} ![](${dest})`,
      `${marker} ![Existing alt](images/other.png)`,
      "",
    ].join(nl);
    const expected = [
      `${marker} Intro item`,
      `${marker} ![TODO: describe image](${dest})`,
      `${marker} ![Existing alt](images/other.png)`,
      "",
    ].join(nl);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`${marker} ![TODO: describe image](${dest})`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("rule:missing-alt-text undescribed image mixed into nested unordered list items", () => {
  const rules = [ruleMissingAltText];

  it.each([
    ["-", "  ", "\n"],
    ["*", "    ", "\r\n"],
    ["+", "\t", "\n"],
  ])("fills the placeholder and keeps marker %j and indent in a nested item with text and a task box (indent %j, line ending %j)", (marker, indent, nl) => {
    const build = (alt: string) =>
      [
        `${marker} Top item`,
        `${indent}${marker} Chart: ![${alt}](img/a.png "A") and ![Kept](img/k.png)`,
        `${indent}${marker} [x] Done ![${alt}](img/b.png?v=2#top)`,
        "",
      ].join(nl);
    const doc = build(" ");
    const expected = build("TODO: describe image");
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("autofix: invalid links in an ordered list", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
    ["bare hash", "#"],
  ])("replaces the %s destination with TODO and keeps each number, delimiter and label", (_name, href) => {
    const doc = [
      "Steps:",
      "",
      "1. Read [the **setup** guide](./setup.md) first.",
      `2. Then open [Café menu ☕](${href}) next.`,
      `10) Finally see [wrap-up](${href}).`,
      "",
    ].join("\n");
    const expected = [
      "Steps:",
      "",
      "1. Read [the **setup** guide](./setup.md) first.",
      "2. Then open [Café menu ☕](TODO) next.",
      "10) Finally see [wrap-up](TODO).",
      "",
    ].join("\n");

    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["\n"],
    ["\r\n"],
  ])("keeps indentation, a non-1 start number when fixing an ordered item with a nested child (line ending %j)", (nl) => {
    const doc = [
      "3. Configure [the env file](?) before running.",
      "   - Nested: see [notes]() and [ok](./ok.md).",
      "4. Done.",
      "",
    ].join(nl);
    const expected = [
      "3. Configure [the env file](TODO) before running.",
      "   - Nested: see [notes](TODO) and [ok](./ok.md).",
      "4. Done.",
      "",
    ].join(nl);

    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["0."],
    ["7."],
    ["100."],
    ["2)"],
  ])("fixes a lone ? href in a loose numbered list item with marker %j and keeps the marker, blank lines and text", (marker) => {
    const doc = `${marker} Intro, see [ok](./ok.md).\n\n${marker} Visit [the **docs**](?), then [home](./) today.\n\n${marker} Last item.\n`;
    const expected = `${marker} Intro, see [ok](./ok.md).\n\n${marker} Visit [the **docs**](TODO), then [home](./) today.\n\n${marker} Last item.\n`;

    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("fixes invalid hrefs in nested ordered lists and a quoted ordered list, keeping markers, indentation, inline code and text", () => {
    const doc = [
      "1. Parent with `[code]()` kept and [bad]() link.",
      "   1. Child [one](#) then [two](./two.md).",
      "   2) Child [three]( ) end.",
      "2. Next.",
      "",
      "> 1. Quoted [q]() item",
      "> 2. Plain",
      "",
    ].join("\n");
    const expected = [
      "1. Parent with `[code]()` kept and [bad](TODO) link.",
      "   1. Child [one](TODO) then [two](./two.md).",
      "   2) Child [three](TODO) end.",
      "2. Next.",
      "",
      "> 1. Quoted [q](TODO) item",
      "> 2. Plain",
      "",
    ].join("\n");

    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(4);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("invalid-link-target autofix: idempotence inside blockquotes, tables and headings", () => {
  const rules = [ruleInvalidLinkTarget];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it("applying the autofix twice equals applying it once", () => {
    const doc = [
      "## See [docs]()",
      "",
      "> quoted [a](#) and [b]( )",
      "",
      "| col | link |",
      "| --- | --- |",
      "| x | [c](?) |",
      "",
    ].join("\n");
    const once = fixPass(doc);
    expect(once).toBe(
      [
        "## See [docs](TODO)",
        "",
        "> quoted [a](TODO) and [b](TODO)",
        "",
        "| col | link |",
        "| --- | --- |",
        "| x | [c](TODO) |",
        "",
      ].join("\n"),
    );
    expect(fixPass(once)).toBe(once);
    expect(lintDocument(once, { rules })).toEqual([]);
  });
});

describe("autofix: plain-text preservation", () => {
  it("returns ordinary multiline prose unchanged", () => {
    const doc = [
      "The quick brown fox jumps over the lazy dog.",
      "It was a quiet morning, and nothing much happened.",
      "",
      "A second paragraph follows here, with punctuation; colons: and dashes - too.",
      "",
    ].join("\n");
    // frontmatter-required is excluded: it deliberately inserts a block into any doc without one.
    const violations = lintDocument(doc, { disabledRules: ["frontmatter-required"] });
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });

  it("leaves [sic] brackets and surrounding prose unchanged", () => {
    const doc = [
      'The memo said "their going to the park" [sic] and later "recieve" [sic].',
      "",
      "Quoted verbatim: she wrote [sic] without comment.",
      "",
    ].join("\n");
    const violations = lintDocument(doc, { disabledRules: ["frontmatter-required"] });
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(doc);
    expect(fixed.match(/\[sic\]/g)).toHaveLength(3);
  });
});

describe("autofix: valid HTTP links", () => {
  it("leaves a valid HTTP link unchanged", () => {
    const doc = [
      "# Links",
      "",
      "See [the docs](http://example.com/docs?a=1#top) for details.",
      "",
    ].join("\n");
    const violations = lintDocument(doc, { disabledRules: ["frontmatter-required"] });
    expect(violations.filter((v) => v.ruleId === "invalid-link-target")).toHaveLength(
      0,
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(doc);
    expect(fixed).toContain("(http://example.com/docs?a=1#top)");
  });
});

describe("autofix: invalid link at the end of a document", () => {
  const rules = [ruleInvalidLinkTarget];

  it("replaces the empty href with TODO, keeps the label, and changes nothing else", () => {
    const doc = [
      "# Getting Started",
      "",
      "Welcome to the guide.",
      "This is the second paragraph with some *italic* and **bold** text.",
      "",
      "Read [the manual](./manual.md) for details.",
      "",
      "Also check [help page]() for more info.",
      "",
    ].join("\n");

    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");

    const fixed = applyAllFixes(doc, violations);

    // Acceptance: href becomes TODO
    expect(fixed).toContain("[help page](TODO)");
    // Acceptance: label remains intact
    expect(fixed).not.toContain("[TODO]");
    // Acceptance: no unrelated text changes — prefix before the link is untouched
    const linkIndex = fixed.indexOf("[help page](TODO)");
    expect(fixed.slice(0, linkIndex)).toBe(doc.slice(0, doc.indexOf("[help page]()")));
    // Suffix (trailing newline) is also untouched
    const docAfter = doc.slice(doc.indexOf("[help page]()") + "[help page]()".length);
    const fixedAfter = fixed.slice(linkIndex + "[help page](TODO)".length);
    expect(fixedAfter).toBe(docAfter);
    // Valid link in earlier paragraph is untouched
    expect(fixed).toContain("[the manual](./manual.md)");
    // Clean after fix
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

// ─── Valid HTTPS link preservation ────────────────────────────────────────────

describe("autofix: valid HTTPS link preservation", () => {
  it("leaves a complete https link unchanged while fixing a neighbouring empty link", () => {
    const link =
      '[spec](https://example.com/docs/v2/spec.html?a=1&b=two#section "The spec")';
    const rules = [ruleInvalidLinkTarget];
    const doc = `Read the ${link} or see [empty]().\n`;
    const violations = lintDocument(doc, { rules });
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toContain(link);
    expect(fixed).toBe(`Read the ${link} or see [empty](TODO).\n`);
  });

  it("returns a document containing only a valid https link byte-for-byte", () => {
    const doc = "[home](https://example.com/)\n";
    const rules = [ruleInvalidLinkTarget];
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(applyAllFixes(doc, lintDocument(doc, { rules }))).toBe(doc);
  });

  it.each([
    ["inline link", "[Docs](https://example.com/a_b/c(d)?x=1&y=2#frag)"],
    ["titled link", '[Docs](https://example.com/guide "Guide")'],
    ["angle-bracket autolink", "<https://example.com/path?q=1>"],
  ])("leaves a valid https %s and its surrounding prose unchanged under the default rules", (_name, link) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `---${nl}title: Links${nl}---${nl}${nl}# Links${nl}${nl}Before text, see ${link} for more; after text.${nl}`;
      const violations = lintDocument(doc);
      expect(applyAllFixes(doc, violations)).toBe(doc);
      expect(lintDocument(doc, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
    }
  });
});

describe("rule:missing-alt-text undescribed image in an ordered list", () => {
  it.each([
    ["dot marker", "1. ", "images/chart.png"],
    ["paren marker", "2) ", "images/a%20b.png?v=2#top"],
    ["multi-digit marker", "10. ", 'images/chart.png "Chart"'],
  ])("adds the description placeholder and keeps the list marker and image source (%s)", (_name, marker, dest) => {
    const doc = `Steps:\n\n${marker}See ![](${dest}) here.\n${marker}Second item.\n`;
    const expected = `Steps:\n\n${marker}See ![TODO: describe image](${dest}) here.\n${marker}Second item.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("rule:missing-alt-text undescribed image as the whole content of numbered list items", () => {
  it.each([
    ["\n"],
    ["\r\n"],
  ])("fills every image-only and nested numbered item, keeping start number, indentation, markers and sources (line ending %j)", (nl) => {
    const doc = [
      "Steps:",
      "",
      "3. ![](images/one.png)",
      '4) ![](images/two%20x.png?v=2#top "Two")',
      "   1. ![](./nested.png)",
      "5. ![Described](images/keep.png)",
      "",
    ].join(nl);
    const expected = [
      "Steps:",
      "",
      "3. ![TODO: describe image](images/one.png)",
      '4) ![TODO: describe image](images/two%20x.png?v=2#top "Two")',
      "   1. ![TODO: describe image](./nested.png)",
      "5. ![Described](images/keep.png)",
      "",
    ].join(nl);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(3);
    for (const v of violations) expect(v.fix).not.toBeNull();
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("rule:missing-alt-text undescribed image in a bulleted list", () => {
  it.each([
    ["dash marker", "- ", "images/chart.png"],
    ["asterisk marker", "* ", "images/a%20b.png?v=2#top"],
    ["plus marker", "+ ", 'images/chart.png "Chart"'],
    ["nested dash marker", "  - ", "images/chart.png"],
  ])("adds the description placeholder and keeps the list marker and image source (%s)", (_name, marker, dest) => {
    const doc = `Items:\n\n${marker}See ![](${dest}) here.\n${marker}Second item.\n`;
    const expected = `Items:\n\n${marker}See ![TODO: describe image](${dest}) here.\n${marker}Second item.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("rule:missing-alt-text undescribed image in a blockquote", () => {
  it.each([
    "\n",
    "\r\n",
  ])("preserves a quoted image's query and fragment while inserting its description (%j)", (nl) => {
    const doc = [
      "> See ![](assets/chart.svg?view=wide#detail) for context.",
      "> Next line.",
      "",
    ].join(nl);
    const expected = [
      "> See ![TODO: describe image](assets/chart.svg?view=wide#detail) for context.",
      "> Next line.",
      "",
    ].join(nl);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the description placeholder and preserves the blockquote marker and image source (%s)", (_name, nl) => {
    const doc = ["> ![](diagram.png)", "> This is supporting text.", ""].join(nl);
    const expected = [
      "> ![TODO: describe image](diagram.png)",
      "> This is supporting text.",
      "",
    ].join(nl);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // blockquote marker is preserved
    expect(fixed).toContain("> ![TODO: describe image](diagram.png)");
    // image source is preserved
    expect(fixed).toContain("(diagram.png)");
    // clean after fix
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("handles a deeply nested blockquote with an undescribed image", () => {
    const doc = [
      "> Quote level 1",
      "> > Nested quote with ![](nested.png) image",
      "> > More nested text.",
      "",
    ].join("\n");
    const expected = [
      "> Quote level 1",
      "> > Nested quote with ![TODO: describe image](nested.png) image",
      "> > More nested text.",
      "",
    ].join("\n");
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // blockquote markers at both levels are preserved
    expect(fixed).toContain(
      "> > Nested quote with ![TODO: describe image](nested.png) image",
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("fixes undescribed images on several quoted lines, a quoted list item and a lazy line, leaving described and unquoted images alone (%s)", (_name, nl) => {
    const doc = [
      "> - ![](list.png)",
      "> - ![Kept](kept.png)",
      "> ![](one.png) and ![](two.png)",
      "lazy continuation ![](lazy.png)",
      "",
      "![](plain.png)",
      "",
    ].join(nl);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(5);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      [
        "> - ![TODO: describe image](list.png)",
        "> - ![Kept](kept.png)",
        "> ![TODO: describe image](one.png) and ![TODO: describe image](two.png)",
        "lazy continuation ![TODO: describe image](lazy.png)",
        "",
        "![TODO: describe image](plain.png)",
        "",
      ].join(nl),
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the description placeholder mid-prose inside a single-level blockquote, preserving the marker and image source (%s)", (_name, nl) => {
    const doc = [
      "> This sentence has an ![](photo.jpg) inline.",
      "> Continuation after the image.",
      "",
    ].join(nl);
    const expected = [
      "> This sentence has an ![TODO: describe image](photo.jpg) inline.",
      "> Continuation after the image.",
      "",
    ].join(nl);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.startsWith("> This sentence")).toBe(true);
    expect(fixed).toContain("(photo.jpg)");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the placeholder under the default rule set and keeps every quote prefix and image source (%s)", (_name, nl) => {
    const doc = [
      "---",
      "title: Quoted images",
      "---",
      "",
      "# Quoted images",
      "",
      "An intro sentence.",
      "",
      "> Quoted line with ![](images/quote.png) inline.",
      '> Second line ends with ![ ](images/tail.png?w=1#t "Tail").',
      "",
    ].join(nl);
    const expected = [
      "---",
      "title: Quoted images",
      "---",
      "",
      "# Quoted images",
      "",
      "An intro sentence.",
      "",
      "> Quoted line with ![TODO: describe image](images/quote.png) inline.",
      '> Second line ends with ![TODO: describe image](images/tail.png?w=1#t "Tail").',
      "",
    ].join(nl);
    const violations = lintDocument(doc);

    expect(violations).toHaveLength(2);
    expect(
      violations.every((v) => v.ruleId === "missing-alt-text" && v.fix !== null),
    ).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The description placeholder and the blockquote prefix appear in the fixed output.
    expect(fixed.match(/TODO: describe image/g)).toHaveLength(2);
    expect(fixed).toContain(
      "> Quoted line with ![TODO: describe image](images/quote.png)",
    );
    expect(fixed.split(nl).filter((line) => line.startsWith(">"))).toHaveLength(2);
    // The fixed document is a fixed point under the full default rule set.
    expect(applyAllFixes(fixed, lintDocument(fixed))).toBe(fixed);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the placeholder when the undescribed image ends a blockquote with no trailing newline (%s)", (_name, nl) => {
    const doc = `Text.${nl}${nl}> Quote ends with ![](end.png)`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `Text.${nl}${nl}> Quote ends with ![TODO: describe image](end.png)`,
    );
    // The description placeholder and the blockquote prefix appear in the fixed output.
    expect(fixed).toContain("TODO: describe image");
    expect(fixed).toContain("> Quote ends with");
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("rule:missing-alt-text undescribed image in a blockquote with surrounding text", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("keeps each quote prefix, the unquoted text around the quote and the image title and source (%s)", (_name, nl) => {
    const doc = [
      "Before the quote, café.",
      "",
      ">![](tight.png)",
      ">",
      '>   Indented ![](<my pics/a b.png> "Title") text.',
      "",
      "After the quote.",
    ].join(nl);
    const expected = [
      "Before the quote, café.",
      "",
      ">![TODO: describe image](tight.png)",
      ">",
      '>   Indented ![TODO: describe image](<my pics/a b.png> "Title") text.',
      "",
      "After the quote.",
    ].join(nl);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(
      violations.every((v) => v.ruleId === "missing-alt-text" && v.fix !== null),
    ).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("link and image autofix: invalid link wrapping an undescribed image", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    "\n",
    "\r\n",
  ])("is idempotent for linked images, quoted and listed mixes with %j line endings", (nl) => {
    const doc = [
      "> [![](logo.png)]() and ![](b.png) in a quote",
      "",
      "- [![ ](c.png)](#) then [ok](./ok.md)",
      "- | cell ![](d.png) [x](?) |",
      "",
    ].join(nl);
    const once = fixPass(doc);

    expect(once).not.toBe(doc);
    expect(once).not.toContain("![](");
    expect(once).toContain("[ok](./ok.md)");
    expect(once).toContain("[x](TODO)");
    // Links that wrap an image are not linted, so they may survive; the pass must still converge.
    expect(lintDocument(once, { rules })).toEqual([]);
    expect(fixPass(once)).toBe(once);
    expect(fixPass(fixPass(doc))).toBe(once);
  });
});

describe("autofix preserves bracketed numeric reference prose like [1]", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it("keeps a bare [1] reference and its surrounding text while fixing a real violation", () => {
    const doc =
      "As shown in prior work [1], results hold. See [bad]() and note [1] again.\n";
    const fixed = fixPass(doc);

    expect(fixed).toBe(
      "As shown in prior work [1], results hold. See [bad](TODO) and note [1] again.\n",
    );
    expect(fixPass(fixed)).toBe(fixed);
  });

  it("leaves a document containing only [1] prose byte-for-byte unchanged", () => {
    const doc = "Claim [1] and another [1].\n\n[1]: https://example.com/ref\n";
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(fixPass(doc)).toBe(doc);
  });
});

describe("autofix preserves bracketed TODO prose like [TODO]", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it("keeps [TODO] prose intact while fixing a real invalid link violation", () => {
    const doc = "Remember to [TODO] before shipping. See [broken]() for the guide.\n";
    const fixed = fixPass(doc);

    expect(fixed).toBe(
      "Remember to [TODO] before shipping. See [broken](TODO) for the guide.\n",
    );
    expect(fixPass(fixed)).toBe(fixed);
  });

  it("leaves a document containing only [TODO] prose byte-for-byte unchanged", () => {
    const doc = "Fix this [TODO] item and that [TODO] task.\n";
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(fixPass(doc)).toBe(doc);
  });
});

describe("autofix preserves [TODO] prose in varied markdown contexts", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    ["heading", "# Plan [TODO]\n\nBody text.\n"],
    ["list item", "- [TODO] write docs\n- [TODO] add tests\n"],
    ["blockquote", "> [TODO] revisit this\n"],
    ["emphasis", "Do **[TODO]** and *[TODO]* now.\n"],
    ["CRLF", "Line [TODO] one\r\nLine [TODO] two\r\n"],
    ["valid link labelled TODO", "See [TODO](./todo.md) for details.\n"],
  ])("leaves [TODO] untouched in a %s", (_label, doc) => {
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(fixPass(doc)).toBe(doc);
  });

  it("keeps the [TODO] label when the link itself has an empty target", () => {
    const doc = "Open [TODO]() then [TODO] again.\n";
    const fixed = fixPass(doc);
    expect(fixed).toBe("Open [TODO](TODO) then [TODO] again.\n");
    expect(fixPass(fixed)).toBe(fixed);
  });
});

describe("autofix keeps [TODO] prose exactly while fixing neighbouring violations", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    [
      "a space before parentheses",
      "Do [TODO] (soon) and [bad]() now.\n",
      "Do [TODO] (soon) and [bad](TODO) now.\n",
    ],
    [
      "a reference-style label",
      "Do [TODO][ref] and [bad](#).\n\n[ref]: ./ref.md\n",
      "Do [TODO][ref] and [bad](TODO).\n\n[ref]: ./ref.md\n",
    ],
    [
      "inline code",
      "Use `[TODO]` or [TODO] and ![](a.png).\n",
      "Use `[TODO]` or [TODO] and ![TODO: describe image](a.png).\n",
    ],
    [
      "a trailing-space line",
      "Item [TODO]   \nNext [bad]() line\n",
      "Item [TODO]\nNext [bad](TODO) line\n",
    ],
    [
      "a nested bracket",
      "Note [[TODO]] and [bad]().\n",
      "Note [[TODO]] and [bad](TODO).\n",
    ],
  ])("preserves [TODO] beside %s", (_label, doc, expected) => {
    const fixed = fixPass(doc);
    expect(fixed).toBe(expected);
    expect(fixed.split("[TODO]").length).toBe(doc.split("[TODO]").length);
    expect(fixPass(fixed)).toBe(fixed);
  });
});

describe("autofix of an undescribed image between two paragraphs", () => {
  it.each([
    "\n",
    "\r\n",
  ])("inserts the description placeholder and keeps both paragraphs byte-for-byte with %j line endings", (newline) => {
    const before = `First paragraph, with café text${newline}wrapped over two lines.`;
    const after = `Second paragraph follows${newline}and also wraps.`;
    const doc = `${before}${newline}${newline}![](images/chart.png "Chart")${newline}${newline}${after}${newline}`;
    const expected = `${before}${newline}${newline}![TODO: describe image](images/chart.png "Chart")${newline}${newline}${after}${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(before);
    expect(fixed).toContain(after);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("keeps irregular paragraph spacing (extra and whitespace-only blank lines) and changes only the description", () => {
    const doc =
      "Above paragraph.\n\n\n\n![](images/gap.png)\n  \t\n\n\nBelow paragraph.\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Above paragraph.\n\n\n\n![TODO: describe image](images/gap.png)\n  \t\n\n\nBelow paragraph.\n",
    );
    // Removing the inserted placeholder restores the original byte-for-byte.
    expect(fixed.replace("TODO: describe image", "")).toBe(doc);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("gives each of three undescribed images the placeholder, keeps every source, and leaves a described image alone", () => {
    const doc =
      "- ![](images/one.png)\n" +
      "- ![Kept description](images/two.png)\n" +
      '- ![](<images/three four.png> "Third")\n' +
      "- ![   ](https://example.com/five.png?x=1#y)\n";
    const expected =
      "- ![TODO: describe image](images/one.png)\n" +
      "- ![Kept description](images/two.png)\n" +
      '- ![TODO: describe image](<images/three four.png> "Third")\n' +
      "- ![TODO: describe image](https://example.com/five.png?x=1#y)\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(3);
    expect(
      violations.every((v) => v.ruleId === "missing-alt-text" && v.fix !== null),
    ).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("is the only violation under the full default rules and keeps both valid paragraphs byte-for-byte (%s)", (_name, nl) => {
    const before =
      "Opening paragraph keeps [a valid link](./guide.md), *emphasis* and `code`.";
    const after =
      "Closing paragraph keeps ![its sibling](mate.png) and **strong text**.";
    const doc = `---${nl}title: Gallery${nl}---${nl}${nl}${before}${nl}${nl}![](photos/diagram.svg)${nl}${nl}${after}${nl}`;
    const expected = `---${nl}title: Gallery${nl}---${nl}${nl}${before}${nl}${nl}![TODO: describe image](photos/diagram.svg)${nl}${nl}${after}${nl}`;
    const violations = lintDocument(doc);

    expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe("![](photos/diagram.svg)");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(before);
    expect(fixed).toContain(after);
    expect(lintDocument(fixed)).toEqual([]);
  });
});

describe("autofix of an undescribed image at the end of the document", () => {
  const rules = [ruleMissingAltText];

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the description placeholder and preserves the preceding text (%s)", (_name, nl) => {
    const before = `Intro paragraph with café text${nl}wrapped over two lines.${nl}${nl}## Figures`;
    const doc = `${before}${nl}${nl}![](images/final.png "Last")${nl}`;
    const expected = `${before}${nl}${nl}![TODO: describe image](images/final.png "Last")${nl}`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.startsWith(before)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes an image that ends the document with no trailing newline", () => {
    const doc = "Preceding text stays put.\n\n![](last.png)";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].range?.to.offset).toBe(doc.length);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Preceding text stays put.\n\n![TODO: describe image](last.png)",
    );
    expect(applyFix(doc, violations[0])).toBe(fixed);
  });

  it("fixes an image directly after text on the final line and is idempotent", () => {
    const doc = "Closing remark: ![](end.png)";
    const fixed = applyAllFixes(doc, lintDocument(doc, { rules }));

    expect(fixed).toBe("Closing remark: ![TODO: describe image](end.png)");
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("autofix preserves bracketed [sic] prose", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it("keeps [sic] and its surrounding text while fixing a real violation", () => {
    const doc = "He wrote that they was [sic] late. See [broken]() for details.\n";
    const fixed = fixPass(doc);

    expect(fixed).toBe(
      "He wrote that they was [sic] late. See [broken](TODO) for details.\n",
    );
    expect(fixPass(fixed)).toBe(fixed);
  });

  it("leaves a document containing only [sic] prose byte-for-byte unchanged", () => {
    const doc = 'The quote said "teh [sic] cat" and "recieve [sic]".\n';
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(fixPass(doc)).toBe(doc);
  });

  it.each([
    ["heading", "# Teh [sic] title\n\nBody.\n"],
    ["list item", "- wich [sic] item\n- next [sic]\n"],
    ["blockquote", '> She said "recieve" [sic] twice.\n'],
    ["table cell", "| a | b |\n| - | - |\n| teh [sic] | [sic] |\n"],
    ["no trailing newline", "Quoted [sic]"],
  ])("leaves [sic] unchanged inside a %s", (_name, doc) => {
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(fixPass(doc)).toBe(doc);
  });

  it("keeps [sic] and a hard line break exact in a blockquote while fixing a broken link", () => {
    const doc = "> Teh [sic] note, see [x]().  \n> Done [sic].\n";
    expect(fixPass(doc)).toBe("> Teh [sic] note, see [x](TODO).  \n> Done [sic].\n");
  });
});

describe("autofix on a whitespace-only document", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

  it.each([
    ["spaces", "   "],
    ["tabs", "\t\t"],
    ["blank lines", "\n\n\n"],
    ["CRLF blank lines", "\r\n\r\n"],
    ["mixed", " \t\n  \r\n\t "],
  ])("preserves the input and reports no link or image fix (%s)", (_name, doc) => {
    const violations = lintDocument(doc, { rules });

    expect(violations.filter((v) => v.ruleId === "invalid-link-target")).toEqual([]);
    expect(violations.filter((v) => v.ruleId === "missing-alt-text")).toEqual([]);
    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });
});

describe("autofix idempotence for undescribed images", () => {
  const rules = [ruleMissingAltText];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    ["empty alt", "![](images/a.png)"],
    ["angle-bracket destination with spaces", '![](<images/a b.png> "Title")'],
    ["several in one line", "![](a.png) and ![](b.png?v=2#top)"],
    ["inside a list item", "- item ![](a.png)"],
    ["inside a blockquote", "> quote ![](a.png)"],
    ["beside a described image", "![ok](a.png) ![](b.png)"],
  ])("a second autofix pass changes nothing and lints clean (%s)", (_name, body) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `Intro.${nl}${nl}${body}${nl}`;
      const once = fixPass(doc);

      expect(once).not.toBe(doc);
      expect(once).toContain("![TODO: describe image]");
      expect(fixPass(once)).toBe(once);
      expect(lintDocument(once, { rules })).toEqual([]);
    }
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixing the images one at a time converges to the same fixed point as one batch pass (line ending %j)", (nl) => {
    const doc = [
      'Start ![](a.png) mid ![](<b c.png> "T") end.',
      "Second ![ ](d.png?v=1#frag) line.",
      "",
    ].join(nl);
    const batch = fixPass(doc);

    expect(batch.match(/!\[TODO: describe image\]/g)).toHaveLength(3);
    expect(lintDocument(batch, { rules })).toEqual([]);

    for (const violation of lintDocument(doc, { rules })) {
      // A captured fix is a pure splice at lint-time offsets: applying it
      // twice to the original document yields the same output.
      expect(violation.fix).not.toBeNull();
      const fixFn = violation.fix!;
      expect(fixFn(doc)).toBe(fixFn(doc));

      // Fixing just this image leaves the rest for a second pass, which
      // converges to the batch result.
      const step = applyFix(doc, violation);
      expect(step).not.toBe(doc);
      expect(applyAllFixes(step, lintDocument(step, { rules }))).toBe(batch);
    }

    // The batch result is itself a fixed point.
    expect(fixPass(batch)).toBe(batch);
  });
});

describe("autofix idempotence for undescribed images under the default rules", () => {
  const fixDefault = (text: string) => applyAllFixes(text, lintDocument(text));

  it.each([
    ["in a heading", "## Chart ![](a.png)"],
    ["in a table cell", "| Col |\n| --- |\n| ![](a.png) |"],
    ["as a linked image", "[![](badge.svg)](https://example.com)"],
    ["with a title", '![](a.png "Title")'],
    ["after a code fence", "```\n![](code.png)\n```\n\n![](a.png)"],
  ])("a second default-rule pass changes nothing (%s)", (_name, body) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `---${nl}title: Doc${nl}---${nl}${nl}# Doc${nl}${nl}${body.replace(/\n/g, nl)}${nl}`;
      const once = fixDefault(doc);

      expect(once).toContain("![TODO: describe image]");
      expect(fixDefault(once)).toBe(once);
      expect(lintDocument(once).filter((v) => v.ruleId === "missing-alt-text")).toEqual(
        [],
      );
    }
  });
});

describe("autofix idempotence for undescribed images: exact output", () => {
  const rules = [ruleMissingAltText];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    "\n",
    "\r\n",
  ])("fixing twice equals fixing once, byte for byte, for repeated and whitespace-only images with %j line endings", (nl) => {
    const doc = [
      "![](same.png) and ![](same.png)",
      '![   ](same.png?v=1#top "T")',
      "[![](badge.svg)](https://example.com) ![kept](ok.png)",
      "",
    ].join(nl);
    const expected = [
      "![TODO: describe image](same.png) and ![TODO: describe image](same.png)",
      '![TODO: describe image](same.png?v=1#top "T")',
      "[![TODO: describe image](badge.svg)](https://example.com) ![kept](ok.png)",
      "",
    ].join(nl);

    const once = fixPass(doc);
    const twice = fixPass(once);

    expect(once).toBe(expected);
    expect(twice).toBe(once);
    expect(lintDocument(twice, { rules })).toEqual([]);
  });
});

describe("autofix idempotence for an undescribed image across autofix entry points", () => {
  const rules = [ruleMissingAltText];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    "\n",
    "\r\n",
  ])("applyFix, applyAllFixes and Fix All reach one fixpoint for a single undescribed image with %j line endings", (nl) => {
    clearLintHistory();
    const doc = [
      'See ![](images/chart.png?size=2#preview "Chart") beside ![A map](map.svg).',
      "",
    ].join(nl);
    const expected = doc.replace(
      "![](images/chart.png",
      "![TODO: describe image](images/chart.png",
    );
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    expect(violations[0].fix).not.toBeNull();
    // Every autofix entry point produces the same single-image fixpoint.
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(fixAllViolations(doc, violations)).toBe(expected);
    expect(getLintHistory().map((entry) => entry.ruleId)).toEqual(["missing-alt-text"]);

    // A second pass lints clean, changes nothing and records no new history.
    const second = lintDocument(expected, { rules });
    expect(second).toEqual([]);
    expect(fixPass(expected)).toBe(expected);
    expect(fixPass(fixPass(doc))).toBe(expected);
    const history = [...getLintHistory()];
    expect(fixAllViolations(expected, second)).toBe(expected);
    expect(getLintHistory()).toEqual(history);
  });
});

// ─── Valid anchor links survive the default autofix pipeline ─────────────────

describe("autofix: valid anchor-link preservation (default rules)", () => {
  const fixDefault = (doc: string) => applyAllFixes(doc, lintDocument(doc));

  it.each([
    ["hyphenated slug", "Skip to [install steps](#install-steps) now.\n"],
    ["underscore and digits", "Jump to [step 2](#step_2) later.\n"],
    ["percent-encoded unicode", "Lire [café](#caf%C3%A9) d'abord.\n"],
    ["two anchors in one sentence", "Compare [a](#alpha), then [b](#beta); done.\n"],
    ["anchor in a list item", "- Go to [top](#top) (see below).\n"],
    ["anchor in a blockquote", "> Refer to [notes](#notes) for context.\n"],
    ["anchor in a table cell", "| Col |\n| --- |\n| [row](#row-1) |\n"],
    ["anchor with title", 'See [faq](#faq "Questions") before asking.\n'],
  ])("leaves a valid anchor link (%s) and its prose unchanged", (_name, body) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `---${nl}title: Doc${nl}---${nl}${nl}# Doc${nl}${nl}${body.replace(/\n/g, nl)}`;
      const violations = lintDocument(doc);
      expect(violations.filter((v) => v.ruleId === "invalid-link-target")).toEqual([]);
      expect(fixDefault(doc)).toBe(doc);
    }
  });

  it("preserves the anchor link while fixing a broken link beside it", () => {
    const head = "---\ntitle: Doc\n---\n\n# Doc\n\n";
    const doc = `${head}See [bad]() or [good](#good-section) today.\n`;
    const fixed = fixDefault(doc);
    expect(fixed).toBe(`${head}See [bad](TODO) or [good](#good-section) today.\n`);
    expect(fixDefault(fixed)).toBe(fixed);
  });
});

describe("rule:missing-alt-text undescribed image in a loose unordered list", () => {
  const rules = [ruleMissingAltText];

  it.each([
    ["-", "  "],
    ["*", "  "],
    ["+", "  "],
  ])("fills the placeholder in an item and its continuation paragraph and keeps marker %j and source", (marker, indent) => {
    const build = (alt: string) =>
      [
        `${marker} First item with ![${alt}](<img/my pic.png> "Pic") inline`,
        "",
        `${indent}Continuation ![${alt}](img/b.png?v=2#top) text`,
        "",
        `${marker} Last item`,
        "",
      ].join("\n");
    const doc = build("");
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(build("TODO: describe image"));
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("autofix: bracketed-word prose preservation", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

  it.each([
    ["editorial insertion", "He said [sic] twice."],
    ["task marker and footnote", "- [ ] todo [^1] item [x]"],
    ["collapsed reference", "See [word][] and [other][ref] here."],
    ["nested brackets", "A [[nested]] word and [a [b] c] span."],
    [
      "numeric citation",
      "As shown in prior work [1], results hold; see also [1] and [12].",
    ],
  ])("leaves bracketed prose untouched (%s)", (_label, doc) => {
    const violations = lintDocument(doc, { rules });
    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });

  it("keeps brackets and surrounding prose exactly while fixing a neighbouring link and image", () => {
    const doc = "Said [sic] then [draft]() and [aside] ![](a.png) plus [2] end.\n";
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(2);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "Said [sic] then [draft](TODO) and [aside] ![TODO: describe image](a.png) plus [2] end.\n",
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("described image preservation across line endings and rule sets", () => {
  it.each([
    ["LF, final newline", "\n", "\n"],
    ["CRLF, final newline", "\r\n", "\r\n"],
    ["LF, no final newline", "\n", ""],
    ["CRLF, no final newline", "\r\n", ""],
  ])("leaves a described image with a Unicode alt and titled destination byte-identical (%s)", (_name, nl, tail) => {
    const image =
      '![Diagramme 📈 des coûts *Q3*](img/co%C3%BBts.png?s=2#top "Coûts (v2)")';
    const doc = `# Report${nl}${nl}${image}${tail}`;

    for (const rules of [
      [ruleMissingAltText],
      [ruleInvalidLinkTarget, ruleMissingAltText],
    ]) {
      const violations = lintDocument(doc, { rules });
      expect(violations).toEqual([]);
      expect(applyAllFixes(doc, violations)).toBe(doc);
    }
    // The image itself is never altered by any built-in rule's autofix.
    expect(applyAllFixes(doc, lintDocument(doc))).toContain(image);
  });

  it.each([
    ["comma, colon and exclamation", "![Status: draft, v2 — done!](img/status.png)"],
    ["quotes and parentheses", '![He said "hi" (twice)](img/hi.png)'],
    ["emphasis and symbol runs", "![Chart *Q3* ~old~ 100% & more?](img/q3.png)"],
    ["titled destination", '![Costs, Q3: up 20%!](img/costs.png "Q3 (est.)")'],
    ["sentence-final ellipsis", "![Wait… what?! Yes; ok.](img/w.png)"],
  ])("leaves a described image with punctuation in its alt text byte-identical (%s)", (_name, image) => {
    for (const [nl, tail] of [
      ["\n", "\n"],
      ["\r\n", "\r\n"],
      ["\n", ""],
      ["\r\n", ""],
    ]) {
      const doc = `# Report${nl}${nl}${image}${tail}`;
      for (const rules of [
        [ruleMissingAltText],
        [ruleInvalidLinkTarget, ruleMissingAltText],
      ]) {
        const violations = lintDocument(doc, { rules });
        expect(violations).toEqual([]);
        expect(applyAllFixes(doc, violations)).toBe(doc);
      }
      // The image itself is never altered by any built-in rule's autofix.
      expect(applyAllFixes(doc, lintDocument(doc))).toContain(image);
    }
  });
});

describe("invalid-link-target autofix: blockquote with code and lazy continuation", () => {
  it("sets the invalid href to TODO, keeps every quote marker, and leaves quoted code untouched", () => {
    const rules = [ruleInvalidLinkTarget];
    const doc = [
      "> Quote with a [broken link]( ) here",
      "lazy continuation with [another](#) too",
      "> ```md",
      "> [in code]()",
      "> ```",
      "> Done [ok](./a.md).",
      "",
    ].join("\n");
    const violations = lintDocument(doc, { rules });
    expect(violations.length).toBeGreaterThanOrEqual(1);

    const fixed = applyAllFixes(doc, violations);

    expect(fixed).toBe(
      [
        "> Quote with a [broken link](TODO) here",
        "lazy continuation with [another](TODO) too",
        "> ```md",
        "> [in code]()",
        "> ```",
        "> Done [ok](./a.md).",
        "",
      ].join("\n"),
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: two undescribed images", () => {
  it("adds both descriptions and preserves both image sources", () => {
    const rules = [ruleMissingAltText];
    const doc = [
      "# Gallery",
      "",
      "![](./img/one.png?v=1#top)",
      "",
      '![   ](../img/two image.svg "Second")',
      "",
    ].join("\n");
    const violations = lintDocument(doc, { rules });
    expect(violations.map((v) => v.ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);

    const fixed = applyAllFixes(doc, violations);

    expect(fixed).toBe(
      [
        "# Gallery",
        "",
        "![TODO: describe image](./img/one.png?v=1#top)",
        "",
        '![TODO: describe image](../img/two image.svg "Second")',
        "",
      ].join("\n"),
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("autofix: an invalid link on a wrapped line of a bulleted list item", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["-", "\n"],
    ["*", "\r\n"],
    ["+", "\n"],
  ])("sets the href to TODO on the continuation line and keeps marker %j, the first line and line ending %j", (marker, nl) => {
    const lines = (href: string) => [
      `${marker} First line of the item, see [a](./a.md)`,
      `  and the wrapped part with [broken *link*](${href}) inside,`,
      `  then more text.`,
      `${marker} Second item.`,
      "",
    ];
    const doc = lines("#").join(nl);
    const expected = lines("TODO").join(nl);

    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

// ─── Empty document ──────────────────────────────────────────────────────────

describe("autofix on an empty document", () => {
  it("finds nothing to fix and returns empty content without placeholders", () => {
    const violations = lintDocument("");

    expect(violations).toEqual([]);
    const fixed = applyAllFixes("", violations);
    expect(fixed).toBe("");
    expect(fixed).not.toContain("TODO");
    expect(applyAllFixes(fixed, lintDocument(fixed))).toBe("");
  });

  it("returns empty content when every built-in rule is enabled", () => {
    const violations = lintDocument("", { rules: BUILTIN_RULES });

    expect(violations).toEqual([]);
    expect(applyAllFixes("", violations)).toBe("");
  });

  it.each(
    BUILTIN_RULES.map((rule) => [rule.id, rule] as const),
  )("autofix returns an empty document for rule %s on its own", (_id, rule) => {
    const violations = lintDocument("", { rules: [rule] });

    expect(violations).toEqual([]);
    expect(applyAllFixes("", violations)).toBe("");
  });
});

// ─── Undescribed image with multiline surrounding text ───────────────────────

describe("autofix on an undescribed image amid multiline text", () => {
  it.each([
    "\n",
    "\r\n",
  ])("inserts the placeholder and keeps every surrounding line in order (line ending %j)", (newline) => {
    const lines = [
      "# Gallery",
      "",
      "Intro line one.",
      "Intro line two with café.",
      "![](images/chart.png)",
      "Closing line one.",
      "",
      "Closing paragraph.",
    ];
    const doc = lines.join(newline) + newline;
    const expectedLines = [...lines];
    expectedLines[4] = "![TODO: describe image](images/chart.png)";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expectedLines.join(newline) + newline);
    // Only the image line changed; the rest keep their text and order.
    const fixedLines = fixed.split(newline);
    expect(fixedLines).toHaveLength(lines.length + 1);
    fixedLines.forEach((line, index) => {
      if (index !== 4 && index < lines.length) expect(line).toBe(lines[index]);
    });
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("describes two undescribed images in one table row, including a repeated source, and keeps both sources (line endings %j)", (nl) => {
    const doc = `| A | B |${nl}| --- | --- |${nl}| ![](img/x.png?v=1#a) | ![](img/x.png?v=1#a "Same") |${nl}`;
    const expected = `| A | B |${nl}| --- | --- |${nl}| ![TODO: describe image](img/x.png?v=1#a) | ![TODO: describe image](img/x.png?v=1#a "Same") |${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.ruleId === "missing-alt-text")).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("rule:missing-alt-text undescribed image beside a described image in a table row", () => {
  it.each([
    "\n",
    "\r\n",
  ])("describes only the undescribed cell image and keeps the described one exactly with %j line endings", (newline) => {
    const described = '![Chart](images/a.png?v=2#top "Q1")';
    const doc =
      [
        "| Before | After |",
        "| ------ | ----- |",
        `| ${described} | ![](images/b.png) |`,
      ].join(newline) + newline;
    const expected = doc.replace(
      "![](images/b.png)",
      "![TODO: describe image](images/b.png)",
    );
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(described);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("rule:missing-alt-text undescribed image on the last line without a final newline", () => {
  it.each([
    ["list item", "- Intro\n- ![](a.png)", "- Intro\n- ![TODO: describe image](a.png)"],
    ["heading", "# Title ![](a.png)", "# Title ![TODO: describe image](a.png)"],
    [
      "blockquote",
      "> Quote\n> ![](a.png)",
      "> Quote\n> ![TODO: describe image](a.png)",
    ],
    [
      "table cell",
      "| A |\n| - |\n| ![](a.png) |",
      "| A |\n| - |\n| ![TODO: describe image](a.png) |",
    ],
    [
      "whitespace-only alt",
      "Text.\n\n![ ](a.png)",
      "Text.\n\n![TODO: describe image](a.png)",
    ],
    [
      "trailing spaces",
      "Text.\n\n![](a.png)  ",
      "Text.\n\n![TODO: describe image](a.png)  ",
    ],
    [
      "prose after the image",
      "Text.\n\nSee ![](a.png) for the layout.",
      "Text.\n\nSee ![TODO: describe image](a.png) for the layout.",
    ],
    [
      "linked image",
      "Docs\n\n[![](a.png)](https://example.com/a)",
      "Docs\n\n[![TODO: describe image](a.png)](https://example.com/a)",
    ],
    ["image-only document", "![](a.png)", "![TODO: describe image](a.png)"],
  ])("adds the description and no final newline (%s)", (_name, doc, expected) => {
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: undescribed image on the second line", () => {
  it.each([
    ["LF, trailing newline", "\n", "\n"],
    ["LF, no trailing newline", "\n", ""],
    ["CRLF, trailing newline", "\r\n", "\r\n"],
    ["CRLF, no trailing newline", "\r\n", ""],
  ])("keeps the first line and describes the second-line image (%s)", (_name, nl, end) => {
    const firstLine = "Opening paragraph with *emphasis* and [a link](./docs.md).";
    const src = "images/chart.png?v=2#top";
    const doc = `${firstLine}${nl}![](${src})${end}`;
    const expected = `${firstLine}${nl}![TODO: describe image](${src})${end}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const { from, to } = violations[0].range!;
    expect(from.line).toBe(2);
    expect(doc.slice(from.offset, to.offset)).toBe(`![](${src})`);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Acceptance: the first line is preserved byte for byte.
    expect(fixed.split(nl)[0]).toBe(firstLine);
    expect(fixed.startsWith(`${firstLine}${nl}`)).toBe(true);
    // Acceptance: the image received the placeholder description.
    expect(fixed).toContain(`![TODO: describe image](${src})`);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(expected);
  });

  it.each([
    "\n",
    "\r\n",
  ])("describes a second-line image amid prose and keeps both lines (line endings %j)", (nl) => {
    const firstLine = "# Quarterly report";
    const doc = `${firstLine}${nl}See ![](images/chart.png) for the chart.${nl}`;
    const expected = `${firstLine}${nl}See ![TODO: describe image](images/chart.png) for the chart.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    expect(violations[0].range!.from.line).toBe(2);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const fixedLines = fixed.split(nl);
    expect(fixedLines[0]).toBe(firstLine);
    expect(fixedLines[1]).toBe(
      "See ![TODO: describe image](images/chart.png) for the chart.",
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("rule:missing-alt-text trailing newline preservation", () => {
  it.each([
    ["LF", "Text.\n\n![](a.png)\n", "Text.\n\n![TODO: describe image](a.png)\n"],
    [
      "CRLF",
      "Text.\r\n\r\n![](a.png)\r\n",
      "Text.\r\n\r\n![TODO: describe image](a.png)\r\n",
    ],
    ["image-only document", "![](a.png)\n", "![TODO: describe image](a.png)\n"],
    [
      "several final newlines",
      "![](a.png)\n\n\n",
      "![TODO: describe image](a.png)\n\n\n",
    ],
  ])("inserts the description placeholder and retains the final newline (%s)", (_name, doc, expected) => {
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("rule:missing-alt-text undescribed image in a loose ordered list with continuation content", () => {
  it.each([
    ["\n"],
    ["\r\n"],
  ])("fills images in a continuation paragraph, an angle-bracket source and a blockquote, keeping markers and sources (line ending %j)", (nl) => {
    const doc = [
      "7. First step.",
      "",
      "   ![](images/cont.png)",
      "",
      "8) Two in one: ![](<my images/a b.png>) and ![](b.png#frag).",
      "",
      "> 9. ![](images/quoted.png)",
      "",
    ].join(nl);
    const expected = [
      "7. First step.",
      "",
      "   ![TODO: describe image](images/cont.png)",
      "",
      "8) Two in one: ![TODO: describe image](<my images/a b.png>) and ![TODO: describe image](b.png#frag).",
      "",
      "> 9. ![TODO: describe image](images/quoted.png)",
      "",
    ].join(nl);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(4);
    for (const v of violations) expect(v.fix).not.toBeNull();
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("rule:missing-alt-text undescribed image on a wrapped line of a list item", () => {
  const rules = [ruleMissingAltText];

  it.each([
    ["-", "", "\n"],
    ["*", " ", "\r\n"],
    ["+", "", "\n"],
    ["1.", " ", "\r\n"],
    ["12)", "", "\n"],
  ])("inserts the placeholder on the continuation line and keeps marker %j, the first line and neighbouring items (alt %j, line ending %j)", (marker, alt, nl) => {
    const indent = " ".repeat(marker.length + 1);
    const image = `![${alt}](img/chart.png?v=2#top "Chart")`;
    const lines = (a: string) => [
      `${marker} First line of the item with ![Kept](kept.png),`,
      `${indent}wrapped to a second line showing ![${a}](img/chart.png?v=2#top "Chart"),`,
      `${indent}then a third line, still one item.`,
      `${marker} Second item.`,
      "",
    ];
    const doc = lines(alt).join(nl);
    const expected = lines("TODO: describe image").join(nl);
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The marker, both items and the described image are byte-identical.
    expect(fixed).toContain(`${marker} First line`);
    expect(fixed).toContain(`${marker} Second item.`);
    expect(fixed).toContain("![Kept](kept.png)");
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["- [ ]", "\n"],
    ["* [x]", "\r\n"],
    ["+ [X]", "\n"],
  ])("inserts the placeholder in an image-only task item and keeps marker and box %j (line ending %j)", (marker, nl) => {
    const doc = [
      `${marker} ![](img/check.png)`,
      `${marker} ![Done](img/done.png)`,
      `${marker} text only`,
      "",
    ].join(nl);
    const expected = [
      `${marker} ![TODO: describe image](img/check.png)`,
      `${marker} ![Done](img/done.png)`,
      `${marker} text only`,
      "",
    ].join(nl);
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Box and marker are untouched: the placeholder went inside the brackets.
    expect(fixed).toContain(`${marker} ![TODO: describe image](img/check.png)`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["\n"],
    ["\r\n"],
  ])("under the full default rule set keeps the marker and a code-span decoy while filling the wrapped-line image (line ending %j)", (nl) => {
    const doc = [
      "---",
      "title: Figures",
      "---",
      "",
      "# Figures",
      "",
      "Items:",
      "",
      "- First line of the item,",
      "  wrapped to show ![](img/chart.png) beside a `![](fake.png)` decoy,",
      "  then a third line.",
      "- Second item.",
      "",
    ].join(nl);
    const violations = lintDocument(doc);

    expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      doc.replace("![](img/chart.png)", "![TODO: describe image](img/chart.png)"),
    );
    // The masked code span is left alone and every list marker is intact.
    expect(fixed).toContain("![](fake.png)`");
    expect(fixed).toContain("- First line of the item,");
    expect(fixed).toContain("- Second item.");
    expect(lintDocument(fixed)).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed))).toBe(fixed);
  });
});

describe("invalid-link-target autofix: invalid link at the start of a paragraph", () => {
  it.each([
    [
      "LF",
      "[broken]() Please read the docs.\n",
      "[broken](TODO) Please read the docs.\n",
    ],
    [
      "CRLF",
      "[broken]() Please read the docs.\r\n",
      "[broken](TODO) Please read the docs.\r\n",
    ],
    [
      "preceded by a paragraph",
      "Previous paragraph.\n\n[broken]() Start of this paragraph.\n",
      "Previous paragraph.\n\n[broken](TODO) Start of this paragraph.\n",
    ],
  ])("inserts TODO and preserves following prose (%s)", (_name, doc, expected) => {
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix of an invalid link between two paragraphs with varied separators", () => {
  it.each([
    ["one blank line", "\n\n"],
    ["three blank lines", "\n\n\n\n"],
    ["CRLF blank lines", "\r\n\r\n"],
    ["spaces on the blank line", "\n   \n"],
    ["tab on the blank line", "\n\t\n"],
  ])("changes only the invalid href and keeps the paragraph spacing (%s)", (_name, gap) => {
    const first = "First paragraph with a [valid](./ok.md) link.";
    const last = "Closing paragraph.";
    const doc = `${first}${gap}Go to [broken]() now.${gap}${last}\n`;
    const expected = doc.replace("[broken]()", "[broken](TODO)");
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    // Single-fix path and bulk path agree, and only the href bytes differ.
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.length - doc.length).toBe("TODO".length);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("applying only the invalid-link violation from the default rule set keeps the spacing", () => {
    const doc = "Alpha.\n\n\nSee [broken]().\n\nOmega.\n";
    const violations = lintDocument(doc).filter(
      (v) => v.ruleId === "invalid-link-target",
    );

    expect(violations).toHaveLength(1);
    expect(applyAllFixes(doc, violations)).toBe(
      "Alpha.\n\n\nSee [broken](TODO).\n\nOmega.\n",
    );
  });

  it("replaces an invalid href in a multi-paragraph document and keeps the absence of a final newline", () => {
    const doc =
      "# Notes\n\nSee [broken]() for details.\n\nLast line stays [ok](./a.md)";
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "# Notes\n\nSee [broken](TODO) for details.\n\nLast line stays [ok](./a.md)",
    );
    expect(fixed.endsWith("\n")).toBe(false);
    // A second pass finds nothing and changes nothing.
    expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
    expect(
      applyAllFixes(fixed, lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })),
    ).toBe(fixed);
  });
});

describe("invalid-link autofix idempotence across markdown contexts", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("a second autofix pass returns exactly the first pass's output for invalid links in prose, list, table, blockquote, fence and inline code (%s)", (_name, nl) => {
    const doc = [
      "# Links",
      "",
      "Read [empty]() and [hash](#) and [ok](./ok.md).",
      "",
      "- item [list link]()",
      "",
      "| col | link |",
      "| --- | --- |",
      "| a | [cell]() |",
      "",
      "> quoted [quote]()",
      "",
      "Inline `[code]()` stays.",
      "",
      "```md",
      "[fenced]()",
      "```",
      "",
    ].join(nl);
    const rules = [ruleInvalidLinkTarget];

    const firstViolations = lintDocument(doc, { rules });
    expect(firstViolations.length).toBeGreaterThanOrEqual(5);
    const once = applyAllFixes(doc, firstViolations);
    expect(once).not.toBe(doc);
    expect(once).toContain("[empty](TODO)");
    expect(once).toContain("[ok](./ok.md)");

    const secondViolations = lintDocument(once, { rules });
    expect(secondViolations).toEqual([]);
    expect(applyAllFixes(once, secondViolations)).toBe(once);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the description for an undescribed image ending a paragraph and keeps the preceding prose (%s)", (_name, nl) => {
    const prose = "Café notes, with *emphasis* and a [kept link](./kept.md), end with";
    const src = 'images/chart.png?size=2#data "Title"';
    const doc = `Intro.${nl}${nl}${prose} ![](${src})${nl}${nl}Next paragraph.${nl}`;
    const expected = `Intro.${nl}${nl}${prose} ![TODO: describe image](${src})${nl}${nl}Next paragraph.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.startsWith(`Intro.${nl}${nl}${prose} `)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

// ─── [sic] followed by parenthesised prose, code, and the default rule set ───

describe("autofix: [sic] beside parentheses and code under the fixable rules", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
  const fixDefault = (doc: string) => applyAllFixes(doc, lintDocument(doc, { rules }));

  it.each([
    ["space then parenthetical", "She wrote teh [sic] (as quoted) and moved on.\n"],
    ["parenthetical around it", "The memo (it said recieve [sic]) was short.\n"],
    ["inline code mentions it", "Editors add `[sic]` after errors, e.g. teh [sic].\n"],
    [
      "fenced code mentions it",
      "Text [sic].\n\n```\nteh [sic] ()\n```\n\nEnd [sic].\n",
    ],
    ["CRLF endings", "He said teh [sic] (twice).\r\nNext [sic] line.\r\n"],
  ])("leaves %s byte-for-byte unchanged", (_name, doc) => {
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(fixDefault(doc)).toBe(doc);
  });

  it("fixes only the real broken link and keeps [sic] (parenthetical) exact", () => {
    const doc = "Teh [sic] (as quoted); see [guide]() and `[sic]`.\n";
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("Teh [sic] (as quoted); see [guide](TODO) and `[sic]`.\n");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["inline", "![Quarterly revenue](charts/q3.png)"],
    ["collapsed reference", "![Quarterly revenue][q3]\n\n[q3]: charts/q3.png"],
    ["full reference", '![Quarterly revenue][q3]\n\n[q3]: charts/q3.png "Q3"'],
    [
      "several in one paragraph",
      '![One](a.png) and ![Two words](b.png "B") and ![Three](<c d.png>)',
    ],
  ])("autofix leaves a nonempty image description and its source unchanged (%s)", (_name, body) => {
    for (const newline of ["\n", "\r\n"]) {
      const doc = `# Report${newline}${newline}${body.replace(/\n/g, newline)}${newline}`;
      for (const rules of [
        [ruleInvalidLinkTarget, ruleMissingAltText],
        BUILTIN_RULES,
      ]) {
        const violations = lintDocument(doc, { rules }).filter(
          (v) => v.ruleId === "missing-alt-text" || v.ruleId === "invalid-link-target",
        );
        expect(violations).toEqual([]);
        expect(applyAllFixes(doc, violations)).toBe(doc);
      }
    }
  });
});

// ─── Plain paragraph preservation ────────────────────────────────────────────

describe("autofix: plain paragraph preservation", () => {
  const defaultRules = BUILTIN_RULES.filter((rule) =>
    LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
  );
  // frontmatter-required deliberately inserts a block into any document without one.
  const withoutFrontmatterRule = BUILTIN_RULES.filter(
    (rule) => rule.id !== "frontmatter-required",
  );
  const paragraph =
    'Well, that was "unexpected": isn\'t it? Yes -- (mostly); see e.g. [1], 3 < 5 & 7 > 2... Done!\n';

  it.each([
    ["every built-in rule except frontmatter-required", withoutFrontmatterRule],
    ["the default rule set", defaultRules],
  ])("leaves an ordinary paragraph and its final newline unchanged under %s", (_label, rules) => {
    const violations = lintDocument(paragraph, { rules });
    expect(violations).toEqual([]);
    const fixed = applyAllFixes(paragraph, violations);
    expect(fixed).toBe(paragraph);
    expect(fixed.endsWith("\n")).toBe(true);
    expect(fixed.endsWith("\n\n")).toBe(false);
  });

  it("does not add a newline when the paragraph has none", () => {
    const doc = paragraph.trimEnd();
    const violations = lintDocument(doc, { rules: withoutFrontmatterRule });
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });
});

describe("autofix: document without links or images", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("leaves a structured document unchanged with %s line endings", (_label, newline) => {
    const doc = [
      "---",
      "title: Field notes",
      "---",
      "",
      "# Field notes",
      "",
      "A short introduction with Unicode: café and 雪.",
      "",
      "## Observations",
      "",
      "- First observation",
      "- Second observation",
      "",
      "> Keep the original wording.",
      "",
      "```text",
      "Some example text.",
      "```",
      "",
    ].join(newline);
    const violations = lintDocument(doc);

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });
});

// ─── valid mailto links beside real violations ───────────────────────────────

describe("autofix: valid mailto link preserved next to a broken link", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["plain address", "[Email the team](mailto:team@example.com)"],
    [
      "multiple recipients",
      "[Write us](mailto:a@example.com,b@example.com?subject=Hi)",
    ],
    ["uppercase scheme", "[Contact](MAILTO:Team@Example.com)"],
  ])("keeps the %s address and link text while fixing only the broken link", (_name, mail) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `Mail ${mail} or see [guide]().${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(`Mail ${mail} or see [guide](TODO).${nl}`);
      expect(fixed).toContain(mail);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });
});

describe("autofix keeps [TODO] prose at document edges, in tables and in fences", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    ["start and end with no final newline", "[TODO] first and last [TODO]"],
    ["a table cell", "| a | b |\n|---|---|\n| [TODO] | done |\n"],
    ["a fenced code block", "```md\n[TODO] [bad]()\n```\n\nAfter [TODO].\n"],
  ])("leaves [TODO] byte-for-byte unchanged in %s", (_label, doc) => {
    expect(fixPass(doc)).toBe(doc);
  });

  it("fixes a broken link beside [TODO] at both document edges", () => {
    const doc = "[TODO] mid [bad]() end [TODO]";
    expect(fixPass(doc)).toBe("[TODO] mid [bad](TODO) end [TODO]");
  });
});

describe("autofix preserves [TODO] prose in masked regions and touching a repair", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    "\n",
    "\r\n",
  ])("keeps every [TODO] in front matter, indented code and prose while fixing only the body's broken link (%j endings)", (nl) => {
    // Front matter and indented code are masked for the link and image
    // rules: their [TODO] spans — and the code's own [bad]() — stay text.
    const doc = [
      "---",
      "tags: [TODO]",
      "---",
      "",
      "Para line.",
      "",
      "    code [TODO] and [bad]() here",
      "",
      "Body [TODO] and [bad]().",
      "",
    ].join(nl);
    const expected = [
      "---",
      "tags: [TODO]",
      "---",
      "",
      "Para line.",
      "",
      "    code [TODO] and [bad]() here",
      "",
      "Body [TODO] and [bad](TODO).",
      "",
    ].join(nl);
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[bad]()");

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // All three bracketed [TODO] spans survive; the inserted placeholder
    // adds no brackets of its own.
    expect(fixed.match(/\[TODO\]/g)).toHaveLength(3);
    expect(fixed.split("[TODO]").length).toBe(doc.split("[TODO]").length);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(fixPass(fixed)).toBe(fixed);
  });

  it.each([
    ["before the link", "x[TODO][bad]() y.\n", "x[TODO][bad](TODO) y.\n"],
    ["after the link", "[bad]()[TODO] end.\n", "[bad](TODO)[TODO] end.\n"],
  ])("retains the brackets of a [TODO] touching the repaired link (%s)", (_label, doc, expected) => {
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("[TODO]");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix preserves [TODO] prose alongside undescribed images", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

  it.each([
    "\n",
    "\r\n",
  ])("preserves [TODO] prose brackets and adds the image description placeholder with %j line endings", (newline) => {
    const doc = `Review [TODO] before merging. See ![](chart.png) for data.${newline}`;
    const expected = `Review [TODO] before merging. See ![TODO: describe image](chart.png) for data.${newline}`;
    const violations = lintDocument(doc, { rules });

    // The linter should find only the missing-alt-text violation,
    // not flag [TODO] as an invalid link.
    expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);

    // Idempotent: a second pass produces the same result.
    const fixedViolations = lintDocument(fixed, { rules });
    expect(fixedViolations).toEqual([]);
    expect(applyAllFixes(fixed, fixedViolations)).toBe(fixed);

    // [TODO] prose bracket count is preserved.
    expect(fixed.split("[TODO]").length).toBe(doc.split("[TODO]").length);
  });

  it("handles [TODO] prose and an undescribed image in different paragraphs", () => {
    const doc = `Step [TODO] is pending.\n\n![](diagram.png)\n`;
    const expected = `Step [TODO] is pending.\n\n![TODO: describe image](diagram.png)\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(applyAllFixes(doc, violations)).toBe(expected);
  });

  it.each([
    "\n",
    "\r\n",
  ])("keeps [TODO] intact when fixing both an invalid link and an undescribed image with %j line endings", (newline) => {
    const doc = [
      "Task [TODO] is open. See [draft]() for details.",
      "Also check ![](graph.png) and [notes](#) below.",
    ].join(newline);
    const expected = [
      "Task [TODO] is open. See [draft](TODO) for details.",
      "Also check ![TODO: describe image](graph.png) and [notes](TODO) below.",
    ].join(newline);
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
      "invalid-link-target",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);

    // Idempotent: a second pass is clean.
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);

    // [TODO] bracket count preserved.
    expect(fixed.split("[TODO]").length).toBe(doc.split("[TODO]").length);
  });
});

describe("autofix keeps [1] prose at document edges, in tables and in fences", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    ["start and end with no final newline", "[1] first and last [1]"],
    ["a table cell", "| a | b |\n|---|---|\n| [1] | done |\n"],
    ["a fenced code block", "```md\n[1] [bad]()\n```\n\nAfter [1].\n"],
  ])("leaves [1] byte-for-byte unchanged in %s", (_label, doc) => {
    expect(fixPass(doc)).toBe(doc);
  });

  it("fixes a broken link beside [1] at both document edges", () => {
    const doc = "[1] mid [bad]() end [1]";
    expect(fixPass(doc)).toBe("[1] mid [bad](TODO) end [1]");
  });
});

describe("invalid-link autofix idempotence in task lists and nested ordered lists", () => {
  const opts = { rules: [ruleInvalidLinkTarget] };
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, opts));

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("a second autofix pass equals the first for checkbox items and nested numbering (%s)", (_name, nl) => {
    const doc = [
      "- [ ] task [a]()",
      "- [x] done [b](#)",
      "1. [c](  )",
      "   1. [d](?) and [kept](./kept.md)",
      "",
    ].join(nl);
    const expected = [
      "- [ ] task [a](TODO)",
      "- [x] done [b](TODO)",
      "1. [c](TODO)",
      "   1. [d](TODO) and [kept](./kept.md)",
      "",
    ].join(nl);

    const once = fixPass(doc);
    const twice = fixPass(once);

    expect(once).toBe(expected);
    expect(twice).toBe(once);
    expect(lintDocument(once, opts)).toEqual([]);
  });
});

describe("invalid-link autofix idempotence across entry points and default rules", () => {
  const rules = [ruleInvalidLinkTarget];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  beforeEach(() => {
    clearLintHistory();
  });

  it.each([
    "\n",
    "\r\n",
  ])("applyFix, applyAllFixes and Fix All reach one fixpoint for an invalid link with %j line endings", (nl) => {
    const doc = `Read [draft]() then [guide](./guide.md) today.${nl}`;
    const expected = `Read [draft](TODO) then [guide](./guide.md) today.${nl}`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    expect(violations[0].fix).not.toBeNull();
    // Every autofix entry point produces the same single-link fixpoint.
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(fixAllViolations(doc, violations)).toBe(expected);
    expect(getLintHistory().map((entry) => entry.ruleId)).toEqual([
      "invalid-link-target",
    ]);

    // A second autofix lints clean, returns the first pass's document
    // byte-for-byte and records no new history.
    const second = lintDocument(expected, { rules });
    expect(second).toEqual([]);
    expect(fixPass(expected)).toBe(expected);
    expect(fixPass(fixPass(doc))).toBe(expected);
    const history = [...getLintHistory()];
    expect(fixAllViolations(expected, second)).toBe(expected);
    expect(getLintHistory()).toEqual(history);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("a second Fix All returns the first pass's document byte-for-byte under the default rules, even with a warning left over (%s)", (_name, nl) => {
    const defaultRules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const doc = [
      "# Draft",
      "",
      "## Notes",
      "",
      "Open [guide]() and [refs](#) here.   ",
      "",
    ].join(nl);
    const expected = [
      "# Draft",
      "",
      "## Notes",
      "",
      "Open [guide](TODO) and [refs](TODO) here.",
      "",
    ].join(nl);
    const violations = lintDocument(doc, { rules: defaultRules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "orphaned-heading",
      "invalid-link-target",
      "invalid-link-target",
      "no-trailing-spaces",
    ]);

    const once = fixAllViolations(doc, violations);
    expect(once).toBe(expected);
    expect(getLintHistory().map((entry) => entry.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "no-trailing-spaces",
    ]);

    // The orphaned-heading warning persists but has no fix, so a second
    // autofix returns the first pass's document byte-for-byte and appends
    // nothing to the history.
    const remaining = lintDocument(once, { rules: defaultRules });
    expect(remaining.map((violation) => violation.ruleId)).toEqual([
      "orphaned-heading",
    ]);
    expect(remaining[0].fix).toBeNull();
    const history = [...getLintHistory()];
    expect(fixAllViolations(once, remaining)).toBe(once);
    expect(applyAllFixes(once, remaining)).toBe(once);
    expect(getLintHistory()).toEqual(history);
  });
});

describe("autofix idempotence for undescribed images: inline wrappers, attributes and skipped forms", () => {
  const rules = [ruleMissingAltText];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    "\n",
    "\r\n",
  ])("fixing twice equals fixing once for emphasis-wrapped, attribute-suffixed and nested-list images, leaving comments, code and reference images alone (%j)", (nl) => {
    const doc = [
      "~~![](a.png)~~ **![](b.png)**",
      "![](c.png){width=50}",
      "1. ![](d.png)",
      "   - ![](e.png)",
      "<!-- ![](hidden.png) -->",
      "`![](code.png)` ![](f.png)",
      "![][ref]",
      "",
      "[ref]: ref.png",
      "",
    ].join(nl);
    const fixed = "![TODO: describe image]";
    const expected = [
      `~~${fixed}(a.png)~~ **${fixed}(b.png)**`,
      `${fixed}(c.png){width=50}`,
      `1. ${fixed}(d.png)`,
      `   - ${fixed}(e.png)`,
      "<!-- ![](hidden.png) -->",
      `\`![](code.png)\` ${fixed}(f.png)`,
      "![][ref]",
      "",
      "[ref]: ref.png",
      "",
    ].join(nl);

    const once = fixPass(doc);
    const twice = fixPass(once);

    expect(once).toBe(expected);
    expect(twice).toBe(once);
    expect(lintDocument(twice, { rules })).toEqual([]);
  });
});

describe("autofix: [1] prose preservation across block contexts", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText, ruleNoTrailingSpaces];
  const fixAll = (doc: string) => applyAllFixes(doc, lintDocument(doc, { rules }));

  it.each([
    "\n",
    "\r\n",
  ])("leaves [1] in a heading, list, blockquote and table byte-for-byte unchanged (line endings %j)", (nl) => {
    const doc = [
      "# Results [1]",
      "",
      "- item [1]",
      "1. ordered [1], then [2]",
      "> quoted [1] text",
      "",
      "| a [1] | b |",
      "| --- | --- |",
      "| [1] | c |",
      "",
    ].join(nl);

    expect(fixAll(doc)).toBe(doc);
    expect(fixAll(fixAll(doc))).toBe(doc);
  });

  it.each([
    "\n",
    "\r\n",
  ])("keeps [1] and its neighbours exactly while fixing a link, an image and trailing spaces together (line endings %j)", (nl) => {
    const doc = [
      "Claim [1] here.   ",
      "See [guide]() [1] and ![](a.png)[1] too.",
      "",
    ].join(nl);
    const expected = [
      "Claim [1] here.",
      "See [guide](TODO) [1] and ![TODO: describe image](a.png)[1] too.",
      "",
    ].join(nl);

    const fixed = fixAll(doc);
    expect(fixed).toBe(expected);
    expect(fixed.match(/\[1\]/g)).toHaveLength(3);
    expect(fixAll(fixed)).toBe(fixed);
  });
});

// ─── Valid link + described image: autofix is a no-op ──────────────────────────

describe("autofix: valid link and described image no-op", () => {
  const pair = [ruleInvalidLinkTarget, ruleMissingAltText];

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("preserves a valid link, a described image and their surrounding text byte-for-byte (%s endings)", (_name, nl) => {
    const link = '[the guide](./docs/guide.md "Setup guide")';
    const image = '![Architecture diagram](images/arch.png "Overview")';
    const doc = [
      "---",
      "title: Guide",
      "---",
      "",
      "# Guide",
      "",
      `Read ${link} before the install.`,
      "",
      image,
      "",
      "Questions? Email [support](mailto:support@example.com) anytime.",
      "",
    ].join(nl);

    // Neither the fixable pair nor the full default rule set finds anything.
    expect(lintDocument(doc, { rules: pair })).toEqual([]);
    expect(lintDocument(doc)).toEqual([]);

    // Autofix is a byte-for-byte no-op under both rule sets.
    for (const fixed of [
      applyAllFixes(doc, lintDocument(doc, { rules: pair })),
      applyAllFixes(doc, lintDocument(doc)),
    ]) {
      expect(fixed).toBe(doc);
      // Both constructs and the text around them survive exactly.
      expect(fixed).toContain(`Read ${link} before the install.`);
      expect(fixed).toContain(image);
      expect(fixed).toContain("[support](mailto:support@example.com)");
    }
  });

  it.each([
    "\n",
    "\r\n",
  ])("leaves a valid link and a described image untouched when they sit inline amid prose punctuation (%j)", (nl) => {
    const link = "[docs](https://example.com/docs)";
    const image = "![flow](img/flow.svg)";
    const sentence = `See ${link}, then ${image} — done!`;
    const doc = `---${nl}title: Notes${nl}---${nl}${nl}${sentence}${nl}`;
    const violations = lintDocument(doc, { rules: pair });

    expect(violations).toEqual([]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(doc);
    expect(fixed).toContain(sentence);
    // Idempotent: a second lint-and-fix pass changes nothing.
    expect(applyAllFixes(fixed, lintDocument(fixed))).toBe(fixed);
  });

  it.each([
    "\n",
    "\r\n",
  ])("adds the placeholder only to the undescribed image between described ones (line ending %j)", (newline) => {
    const described = [
      "![Chart of results](images/one.png)",
      '![Café *diagram*](<images/two three.png?v=2#top> "Title")',
    ];
    const bare = '![](images/bare.png "T")';
    const doc = `${described[0]} then ${bare} and ${described[1]}.${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `${described[0]} then ![TODO: describe image](images/bare.png "T") and ${described[1]}.${newline}`,
    );
    expect(fixed.match(/TODO: describe image/g)).toHaveLength(1);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("inserts the placeholder for an undescribed image ending a paragraph and keeps the prose before it (line ending %j)", (newline) => {
    const prose =
      "Intro café with *emphasis*, [local](./local.md) and `code`, then the chart: ";
    const image = '![](images/end.png?v=2#top "T")';
    const doc = `# Title${newline}${newline}${prose}${image}${newline}${newline}Next paragraph.${newline}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `# Title${newline}${newline}${prose}![TODO: describe image](images/end.png?v=2#top "T")${newline}${newline}Next paragraph.${newline}`,
    );
    expect(fixed.startsWith(`# Title${newline}${newline}${prose}`)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("keeps a valid link and a described image verbatim while fixing violations on another line (%s endings)", (_name, nl) => {
    const link = '[guide](./docs/guide.md "Setup")';
    const image = '![Team photo](images/team.png "The team")';
    const intact = `Intro keeps ${link} and ${image} here.`;
    const doc = `${intact}${nl}${nl}Fix [broken]() and ![](images/bare.png) below.   ${nl}`;
    const expected = `${intact}${nl}${nl}Fix [broken](TODO) and ![TODO: describe image](images/bare.png) below.${nl}`;
    const rules = [ruleNoTrailingSpaces, ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
      "no-trailing-spaces",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The valid constructs and every character around them survive a real fix pass.
    expect(fixed.startsWith(`${intact}${nl}`)).toBe(true);
    expect(fixed).toContain(link);
    expect(fixed).toContain(image);
    // Post-fix lint is clean and a second pass is a no-op.
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("autofix idempotence for undescribed images: headings, tables and fenced decoys", () => {
  const rules = [ruleMissingAltText];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it.each([
    "\n",
    "\r\n",
  ])("a second autofix produces exactly the first result (line ending %j)", (nl) => {
    const doc = [
      "# Title ![](logo.png)",
      "",
      "| a | b |",
      "| - | - |",
      '| ![](cell.png "T") | ![kept](ok.png) |',
      "",
      "```md",
      "![](fenced.png)",
      "```",
      "",
    ].join(nl);
    const expected = [
      "# Title ![TODO: describe image](logo.png)",
      "",
      "| a | b |",
      "| - | - |",
      '| ![TODO: describe image](cell.png "T") | ![kept](ok.png) |',
      "",
      "```md",
      "![](fenced.png)",
      "```",
      "",
    ].join(nl);

    const first = fixPass(doc);
    expect(first).toBe(expected);
    expect(fixPass(first)).toBe(first);
    expect(lintDocument(first, { rules })).toEqual([]);
  });
});

// ─── Described relative image survives autofix alongside a real fix ──────────

describe("autofix: described relative image preservation", () => {
  it.each([
    ["dot-slash", "![Team photo](./img/team.png)"],
    ["parent directory", "![Team photo](../img/team.png)"],
    ["bare filename", "![Team photo](team.png)"],
    ["percent-encoded path", "![Café photo](img/caf%C3%A9.png)"],
    ["titled", '![Team photo](./img/team.png "The team")'],
  ])("leaves the description and relative source unchanged (%s)", (_name, image) => {
    const doc = `---\ntitle: Team\n---\n\n# Team\n\nMeet us: ${image} today.\n`;
    for (const rules of [[ruleInvalidLinkTarget, ruleMissingAltText], BUILTIN_RULES]) {
      const violations = lintDocument(doc, { rules });
      expect(violations.filter((v) => v.ruleId === "missing-alt-text")).toEqual([]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(doc);
      expect(fixed).toContain(image);
    }
  });

  it("fixes only the empty link and keeps the described relative image byte-identical", () => {
    const image = "![Team photo](./img/team.png)";
    const doc = `# Team\n\n${image} and [bio]().\n`;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const fixed = applyAllFixes(doc, lintDocument(doc, { rules }));

    expect(fixed).toBe(`# Team\n\n${image} and [bio](TODO).\n`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix preserves [1] prose brackets", () => {
  it.each([
    "\n",
    "\r\n",
  ])("keeps [1] and its neighbors when it sits next to a fixed link and image (line endings %j)", (nl) => {
    const doc = `- Cite [1][draft]() then ![](a.png) [1].${nl}- ([1]) and [1]: note, [1]${nl}`;
    const expected = `- Cite [1][draft](TODO) then ![TODO: describe image](a.png) [1].${nl}- ([1]) and [1]: note, [1]${nl}`;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const fixed = applyAllFixes(doc, lintDocument(doc, { rules }));

    expect(fixed).toBe(expected);
    expect(fixed.match(/\[1\]/g)).toHaveLength(doc.match(/\[1\]/g)?.length ?? -1);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["before the image", "Cited [1], see ![](fig.png) here."],
    ["after the image", "See ![](fig.png), cited [1] here."],
    ["on both sides", "Refs [1] and ![](fig.png) again [1]."],
    ["touching the image", "Cite [1]![](fig.png) done."],
    ["adjacent after the image", "Inline ![](fig.png)[1] done."],
  ])("inserts the image placeholder and keeps the [1] prose bracket verbatim (%s)", (_name, line) => {
    for (const nl of ["\n", "\r\n"]) {
      const image = "![](fig.png)";
      const doc = `${line}${nl}`;
      const expected = `${line.replace(image, "![TODO: describe image](fig.png)")}${nl}`;
      const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
      const violations = lintDocument(doc, { rules });

      // The image is the only finding; [1] is prose, not a link or image.
      expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
      expect(
        doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
      ).toBe(image);

      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(applyFix(doc, violations[0])).toBe(expected);
      expect(fixed.match(/\[1\]/g)).toHaveLength(doc.match(/\[1\]/g)!.length);
      expect(lintDocument(fixed, { rules })).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });

  it.each([
    "\n",
    "\r\n",
  ])("keeps [1] verbatim in link-shaped prose — ([1]), [1] (note), **[1]** and [1][2] — while fixing a real broken link (%j line endings)", (nl) => {
    // None of these spans is a link: a `(` only follows a space, a paren wraps
    // the bracket, emphasis hugs it, and [1][2] has no destination.
    const doc = [
      "Cite ([1]) and [1] (see notes) plus **bold [1]** end.",
      "Cluster [1][2] beside [broken]() done.",
      "",
    ].join(nl);
    const expected = [
      "Cite ([1]) and [1] (see notes) plus **bold [1]** end.",
      "Cluster [1][2] beside [broken](TODO) done.",
      "",
    ].join(nl);
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    // The empty-href link is the only finding; every bracketed digit is prose.
    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe("[broken]()");

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyFix(doc, violations[0])).toBe(expected);
    // Every bracketed citation survives: no bracket or paren gained or lost.
    expect(fixed.match(/\[\d+\]/g)).toHaveLength(doc.match(/\[\d+\]/g)!.length);
    for (const span of ["([1])", "[1] (see notes)", "**bold [1]**", "[1][2]"])
      expect(fixed).toContain(span);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("autofix describes two undescribed images", () => {
  it.each([
    "\n",
    "\r\n",
  ])("gives both images a description and keeps both sources (line endings %j)", (nl) => {
    const first = "images/a.png?size=2#top";
    const second = "https://example.com/b.svg";
    const doc = `Intro.${nl}${nl}![](${first}) and ![](${second} "B").${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    const fixed = applyAllFixes(doc, violations);

    expect(fixed).toBe(
      `Intro.${nl}${nl}![TODO: describe image](${first}) and ![TODO: describe image](${second} "B").${nl}`,
    );
    expect(fixed.match(/!\[TODO: describe image\]/g)).toHaveLength(2);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: described image beside an undescribed image", () => {
  it.each([
    [true, "\n"],
    [false, "\n"],
    [true, "\r\n"],
    [false, "\r\n"],
  ])("inserts the placeholder only into the undescribed image of a directly adjacent pair (described first: %s, %j line endings)", (describedFirst, nl) => {
    const described = '![Architecture diagram](img/arch.svg "System overview")';
    const undescribed = "![](img/screenshot.png?w=640#full)";
    const repaired = "![TODO: describe image](img/screenshot.png?w=640#full)";
    const pair = (a: string, b: string) => (describedFirst ? `${a}${b}` : `${b}${a}`);
    const doc = `Gallery:${nl}${nl}See ${pair(described, undescribed)} end.${nl}`;
    const expected = `Gallery:${nl}${nl}See ${pair(described, repaired)} end.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    // Only the undescribed image is flagged, and its range covers it exactly.
    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(violations[0].range?.from.offset).toBe(doc.indexOf(undescribed));
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe(undescribed);
    expect(violations[0].fix).not.toBeNull();

    // The single-fix path and the batch path produce the same document.
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);

    // The described image is byte-for-byte preserved; exactly one
    // placeholder was inserted and the undescribed syntax is gone.
    expect(fixed).toContain(described);
    expect(fixed.split("TODO: describe image")).toHaveLength(2);
    expect(fixed).not.toContain(undescribed);

    // Clean after the fix and stable under a second pass.
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    "\n",
    "\r\n",
  ])("describes both undescribed images flanking a described one and leaves the described image byte-identical (%j line endings)", (nl) => {
    const first = "![](img/before.png)";
    const described = "![Team photo](img/team.jpg)";
    const second = "![](img/after.png)";
    const doc = `Line one.${nl}${first}${described}${second} trailing.${nl}`;
    const expected =
      `Line one.${nl}![TODO: describe image](img/before.png)${described}` +
      `![TODO: describe image](img/after.png) trailing.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(described);
    expect(fixed.match(/!\[TODO: describe image\]/g)).toHaveLength(2);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    "\n",
    "\r\n",
  ])("changes only the undescribed image when a described image precedes it in an earlier paragraph (%j line endings)", (nl) => {
    const described = '![Roadmap *Q4*](<img/road map.png> "Plan")';
    const undescribed = "![](img/after.png?v=2#top)";
    const doc = [
      "# Gallery",
      "",
      `First ${described} here.`,
      "",
      `Then ${undescribed} there, café.`,
      "",
    ].join(nl);
    const expected = [
      "# Gallery",
      "",
      `First ${described} here.`,
      "",
      "Then ![TODO: describe image](img/after.png?v=2#top) there, café.",
      "",
    ].join(nl);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    // Only the undescribed image is flagged, so only it can change.
    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(violations[0].range?.from.offset).toBe(doc.indexOf(undescribed));

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Everything before the undescribed image is byte-identical.
    expect(fixed.startsWith(doc.slice(0, doc.indexOf(undescribed)))).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it("fixAllViolations under the default-enabled rules describes only the undescribed image beside a described one and records one history entry", () => {
    clearLintHistory();
    const described = "![Team photo](img/team.jpg)";
    const undescribed = "![](img/chart.png)";
    const doc = `# Report\n\nFigures: ${described} ${undescribed} done.\n`;
    const expected = `# Report\n\nFigures: ${described} ![TODO: describe image](img/chart.png) done.\n`;
    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);

    const fixed = fixAllViolations(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(described);
    expect(fixed.split("TODO: describe image")).toHaveLength(2);
    expect(fixed).not.toContain(undescribed);

    const history = [...getLintHistory()];
    expect(history.map((entry) => entry.ruleId)).toEqual(["missing-alt-text"]);
    expect(history[0].fixedAt).toBeGreaterThan(0);
    expect(history[0].docSnippet).toContain("img/chart.png");

    // Clean after the fix; a second Fix All pass changes nothing and logs nothing.
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(fixAllViolations(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    expect(getLintHistory()).toEqual(history);
  });
});

// ─── Bracketed prose spans: [1], [sic], [TODO] ───────────────────────────────

describe("autofix: bracketed prose [1], [sic] and [TODO]", () => {
  const spans = ["[1]", "[sic]", "[TODO]"];
  const rules = BUILTIN_RULES.filter((rule) =>
    LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
  );

  it("leaves a doc containing all three spans untouched and lint-clean", () => {
    const doc =
      "# Notes\n\nCited once [1], quoted as written [sic], still open [TODO] for review.\n";
    expect(lintDocument(doc, { rules })).toEqual([]);
    expect(applyAllFixes(doc, lintDocument(doc, { rules }))).toBe(doc);
  });

  it("preserves all three spans and surrounding prose while fixing a real violation beside them", () => {
    const doc =
      "# Notes\n\nSee [1] and teh [sic] quote, plus [TODO] later, then [broken]() here.\n";
    const expected =
      "# Notes\n\nSee [1] and teh [sic] quote, plus [TODO] later, then [broken](TODO) here.\n";
    const fixed = applyAllFixes(doc, lintDocument(doc, { rules }));
    expect(fixed).toBe(expected);
    for (const span of spans) expect(fixed).toContain(span);
    expect(fixed).toContain("See [1] and teh [sic] quote, plus [TODO] later, then ");
    // Idempotent: a second pass changes nothing.
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("invalid-link-target autofix: placeholder and prefix in a blockquote", () => {
  it.each([
    [
      "spaced prefix",
      "> See [the docs]() for more.\n",
      "> See [the docs](TODO) for more.\n",
    ],
    [
      "tight prefix",
      ">See [the docs]() for more.\n",
      ">See [the docs](TODO) for more.\n",
    ],
    [
      "blank quoted line",
      "> One\n>\n> See [the docs](#) now.\n",
      "> One\n>\n> See [the docs](TODO) now.\n",
    ],
  ])("keeps the TODO placeholder and the blockquote prefix in the fixed output (%s)", (_name, doc, expected) => {
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("](TODO)");
    for (const line of fixed.trimEnd().split("\n"))
      expect(line.startsWith(">")).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("invalid-link-target autofix: invalid link at the start of a line", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the TODO href into a link at column 0 and preserves the remaining line, including a second invalid link (%s)", (_name, nl) => {
    const head = "Intro line with [ok](./ok.md).";
    const line = "[lead](#) opens the line, cites [1], and ends with [tail](  ).";
    const doc = [head, "", line, "Closing line stays.", ""].join(nl);
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    const { from, to } = violations[0].range!;
    expect(from).toMatchObject({ line: 3, col: 0 });
    expect(doc.slice(from.offset, to.offset)).toBe("[lead](#)");
    expect(
      doc.slice(violations[1].range!.from.offset, violations[1].range!.to.offset),
    ).toBe("[tail](  )");

    // A single fix rewrites only its own href: the rest of the line, including
    // the still-invalid sibling link, stays byte-for-byte identical.
    expect(applyFix(doc, violations[0])).toBe(
      [
        head,
        "",
        "[lead](TODO) opens the line, cites [1], and ends with [tail](  ).",
        "Closing line stays.",
        "",
      ].join(nl),
    );
    expect(applyFix(doc, violations[1])).toBe(
      [
        head,
        "",
        "[lead](#) opens the line, cites [1], and ends with [tail](TODO).",
        "Closing line stays.",
        "",
      ].join(nl),
    );

    const fixed = applyAllFixes(doc, violations);
    const fixedLine =
      "[lead](TODO) opens the line, cites [1], and ends with [tail](TODO).";
    expect(fixed).toBe([head, "", fixedLine, "Closing line stays.", ""].join(nl));
    // The remainder of the repaired line survives untouched, and both the
    // line above and the line below are byte-for-byte the original.
    expect(fixed.split(nl)[2].slice("[lead](TODO)".length)).toBe(
      fixedLine.slice("[lead](TODO)".length),
    );
    expect(fixed.startsWith(`${head}${nl}${nl}`)).toBe(true);
    expect(fixed.endsWith(`${nl}Closing line stays.${nl}`)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \t "],
    ["lone hash", "#"],
    ["lone question mark", "?"],
  ])("preserves the remaining line byte-for-byte when a link with a %s href opens the line", (_name, href) => {
    const link = `[docs](${href})`;
    // The remainder ends in two trailing spaces: only invalid-link-target is
    // enabled, so the fix must leave every byte after the link untouched.
    const rest = " — see [guide](./guide.md) and [sic]  ";
    const doc = `Intro.\n\n${link}${rest}\n`;
    const expected = `Intro.\n\n[docs](TODO)${rest}\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const { from, to } = violations[0].range!;
    expect(from).toMatchObject({ line: 3, col: 0 });
    expect(doc.slice(from.offset, to.offset)).toBe(link);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Everything after the repaired link is byte-for-byte the original line.
    expect(fixed.slice(from.offset + "[docs](TODO)".length)).toBe(doc.slice(to.offset));
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \t "],
    ["lone hash", "#"],
    ["lone question mark", "?"],
  ])("inserts TODO into a link at the very start of the document and keeps the prose tail byte-for-byte (%s href)", (_name, href) => {
    for (const nl of ["\n", "\r\n"]) {
      const link = `[lead](${href})`;
      const tail = " opens the file — keep `code [x](#)` and [ok](./ok.md)  ";
      const doc = `${link}${tail}${nl}Next line stays.${nl}`;
      const expected = `[lead](TODO)${tail}${nl}Next line stays.${nl}`;
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      // The link inside the code span is masked, so only the document's
      // first bytes are flagged.
      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      const { from, to } = violations[0].range!;
      expect(from).toMatchObject({ line: 1, col: 0, offset: 0 });
      expect(doc.slice(from.offset, to.offset)).toBe(link);
      expect(violations[0].fix).not.toBeNull();
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // Everything after the repaired link is the original tail, byte-for-byte.
      expect(fixed.slice("[lead](TODO)".length)).toBe(doc.slice(link.length));
      expect(lintDocument(fixed, { rules })).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("fixes a link at the start of the line after a fenced code block and preserves the fence and the prose tail (%s)", (_name, nl) => {
    const fence = ["```md", "[fenced]() stays code.", "```"].join(nl);
    const tail = " opens after `[decoy](#)` code, cites [1] and [ok](./ok.md)  ";
    const doc = `${fence}${nl}[lead](#)${tail}${nl}Closing line stays.${nl}`;
    const expected = `${fence}${nl}[lead](TODO)${tail}${nl}Closing line stays.${nl}`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    // Only the prose link is flagged: the copy inside the fence and the code
    // span decoy are masked, and the fix splices TODO at the real offsets.
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(from).toMatchObject({ line: 4, col: 0 });
    expect(doc.slice(from.offset, to.offset)).toBe("[lead](#)");
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The masked fence is untouched and the line after the repaired link is
    // byte-for-byte the original tail.
    expect(fixed.startsWith(`${fence}${nl}`)).toBe(true);
    expect(fixed.split(nl)[3]).toBe(`[lead](TODO)${tail}`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("fixes invalid links at the start of consecutive wrapped lines and keeps each line's prose (%s)", (_name, nl) => {
    const doc = [
      "Intro paragraph stays.",
      "",
      "[first]() opens its line and cites [1],",
      "[second](#) opens the next line — `code` stays,",
      "[third]( \t) opens the last wrapped line; [ok](./a.md) ends it.",
      "",
      "Closing paragraph stays.",
      "",
    ].join(nl);
    const expected = [
      "Intro paragraph stays.",
      "",
      "[first](TODO) opens its line and cites [1],",
      "[second](TODO) opens the next line — `code` stays,",
      "[third](TODO) opens the last wrapped line; [ok](./a.md) ends it.",
      "",
      "Closing paragraph stays.",
      "",
    ].join(nl);
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    // One soft-wrapped paragraph, three violations — each at column 0 of its
    // own line; the fixes must compose without disturbing the prose.
    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.map((v) => v.range!.from.line)).toEqual([3, 4, 5]);
    expect(violations.every((v) => v.range!.from.col === 0)).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

// ─── Undescribed image at the start of a document or a line ──────────────────

describe("rule:missing-alt-text undescribed image at the start", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the placeholder into a document-start image and preserves the following prose byte-for-byte (%s)", (_name, nl) => {
    const src = "images/chart.png?v=2#top";
    const image = `![](${src})`;
    // Tricky prose — brackets, a valid link, inline code and trailing spaces —
    // must survive untouched; only the image's empty alt may change.
    const prose = " Lead *sentence* cites [1], keeps `code` and [a link](./docs.md)  ";
    const rest = `Second paragraph stays.${nl}`;
    const doc = `${image}${prose}${nl}${nl}${rest}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const { from, to } = violations[0].range!;
    expect(from).toMatchObject({ line: 1, col: 0, offset: 0 });
    expect(doc.slice(from.offset, to.offset)).toBe(image);

    const placeholder = `![TODO: describe image](${src})`;
    const expected = `${placeholder}${prose}${nl}${nl}${rest}`;
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Acceptance: everything after the image is the original tail, byte-for-byte.
    expect(fixed.slice(placeholder.length)).toBe(doc.slice(to.offset));
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the placeholder into a line-start image mid-document and keeps the rest of the line exactly (%s)", (_name, nl) => {
    const head = "Intro paragraph with [sic] prose.";
    const src = "a.png";
    const image = `![](${src})`;
    const tail = " tails the image — see *note* and [1]  ";
    const last = "Closing line stays.";
    const doc = [head, "", `${image}${tail}`, last, ""].join(nl);
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const { from, to } = violations[0].range!;
    expect(from).toMatchObject({ line: 3, col: 0 });
    expect(doc.slice(from.offset, to.offset)).toBe(image);

    const placeholder = `![TODO: describe image](${src})`;
    const expected = [head, "", `${placeholder}${tail}`, last, ""].join(nl);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Acceptance: the lines before and after and the rest of the image's own
    // line — trailing spaces included — are byte-for-byte the original.
    expect(fixed.startsWith(`${head}${nl}${nl}`)).toBe(true);
    expect(fixed.endsWith(`${nl}${last}${nl}`)).toBe(true);
    expect(fixed.split(nl)[2].slice(placeholder.length)).toBe(tail);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["empty alt", "![]"],
    ["whitespace alt", "![ ]"],
  ])("describes a %s image at offset 0 and leaves every byte after it untouched", (_name, open) => {
    const src = "chart.png";
    const image = `${open}(${src})`;
    const prose =
      " Prose follows immediately, with [brackets] and punctuation — kept!  ";
    // Single line, no newline anywhere: the fix must still be a pure splice.
    const doc = `${image}${prose}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const { from, to } = violations[0].range!;
    expect(from).toMatchObject({ line: 1, col: 0, offset: 0 });
    expect(doc.slice(from.offset, to.offset)).toBe(image);

    const placeholder = `![TODO: describe image](${src})`;
    const expected = `${placeholder}${prose}`;
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.slice(placeholder.length)).toBe(doc.slice(to.offset));
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("autofix: described image with a relative path", () => {
  it.each([
    "./img/a.png",
    "../../docs/img/a b.png",
    "img/sub/a.png?v=2",
  ])("preserves the image exactly while fixing a neighbouring empty link (%s)", (path) => {
    const dest = path.includes(" ") ? `<${path}>` : path;
    const image = `![Relative diagram](${dest} "Diagram")`;
    for (const nl of ["\n", "\r\n"]) {
      const doc = `# Title${nl}${nl}${image} and [draft]() here.${nl}`;
      const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
      const fixed = applyAllFixes(doc, lintDocument(doc, { rules }));

      expect(fixed).toBe(`# Title${nl}${nl}${image} and [draft](TODO) here.${nl}`);
      expect(fixed).toContain(image);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });

  it("leaves a document with only a described relative image byte-identical", () => {
    const doc =
      "---\ntitle: Doc\n---\n\n# Title\n\n![Relative diagram](../img/a.png)\n";
    expect(applyAllFixes(doc, lintDocument(doc))).toBe(doc);
  });

  it.each([
    [
      "heading",
      "## Overview ![](logo.svg)\n",
      "## Overview ![TODO: describe image](logo.svg)\n",
    ],
    [
      "table cell",
      '| a | b |\n| - | - |\n| ![](x.png "T") | y |\n',
      '| a | b |\n| - | - |\n| ![TODO: describe image](x.png "T") | y |\n',
    ],
  ])("sets an empty image description in a %s to the placeholder and preserves the source", (_name, doc, expected) => {
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("undescribed image in a heading", () => {
  it.each([
    "\n",
    "\r\n",
  ])("inserts a description while preserving the destination and heading (%j)", (nl) => {
    const destination = '../images/chart%20one.png?size=2&view=full#preview "Chart"';
    const image = `![](${destination})`;
    const doc = `## Quarterly ${image} results ##${nl}Body text.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `## Quarterly ![TODO: describe image](${destination}) results ##${nl}Body text.${nl}`,
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

// ─── Undescribed image followed by a newline and ordinary prose ──────────────
describe("undescribed image followed by a newline and ordinary prose", () => {
  it.each([
    ["empty alt, plain destination", "![](chart.png)"],
    ["whitespace alt, query and fragment", "![  ](img/chart.png?v=2#top)"],
    ["tab alt, titled destination", '![\t](img/chart.png "Chart")'],
  ])("inserts the image description only (%s); the line break and the prose stay byte-identical", (_name, image) => {
    for (const nl of ["\n", "\r\n"]) {
      const dest = image.slice(image.indexOf("]") + 1);
      const prose = "Ordinary prose follows — see [1] and [ok](./ok.md), then done.";
      const doc = `${image}${nl}${prose}${nl}`;
      const rules = [ruleMissingAltText];
      const violations = lintDocument(doc, { rules });

      expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
      const { from, to } = violations[0].range!;
      expect(from).toMatchObject({ line: 1, col: 0, offset: 0 });
      expect(doc.slice(from.offset, to.offset)).toBe(image);

      const placeholder = `![TODO: describe image]${dest}`;
      const expected = `${placeholder}${nl}${prose}${nl}`;
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // Everything after the repaired image — the line break and the whole
      // prose line, valid link and bracketed citation included — is
      // byte-for-byte the original tail.
      expect(fixed.slice(placeholder.length)).toBe(doc.slice(to.offset));
      expect(fixed.split(nl)).toHaveLength(doc.split(nl).length);
      expect(lintDocument(fixed, { rules })).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });
});

describe("whitespace-only image description that spans a line break", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("becomes the placeholder and keeps the source and surrounding lines (%s)", (_name, nl) => {
    const source = "images/chart.png?v=2#top";
    const doc = `Before${nl}![ ${nl} ](${source})${nl}After [ok](./ok.md).${nl}`;
    const expected = `Before${nl}![TODO: describe image](${source})${nl}After [ok](./ok.md).${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`(${source})`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("invalid link at the end of a CRLF line", () => {
  it.each([
    ["empty", "[guide]()"],
    ["bare hash", "[guide](#)"],
  ])("replaces the %s destination and keeps the CRLF right after it", (_name, link) => {
    const doc = `First line.\r\nSee ${link}\r\nLast line.\r\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("First line.\r\nSee [guide](TODO)\r\nLast line.\r\n");
    expect(fixed.match(/\r\n/g)).toHaveLength(3);
    expect(fixed.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("invalid link on a CRLF-delimited line", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["empty", "[guide]()"],
    ["whitespace-only", "[guide](   )"],
    ["bare hash", "[guide](#)"],
    ["bare query", "[guide](?)"],
  ])("writes the TODO placeholder into the %s destination and keeps every CRLF", (_name, link) => {
    // The link is the whole content of its line, with a CRLF on both sides.
    const doc = `# Links\r\n\r\n${link}\r\n\r\nTrailing line.\r\n`;
    const expected = `# Links\r\n\r\n[guide](TODO)\r\n\r\nTrailing line.\r\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    // The reported range covers the link only — not the \r that ends its line.
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(link);
    expect(doc[to.offset]).toBe("\r");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The placeholder landed exactly once and every line ending is still CRLF.
    expect(fixed.match(/\]\(TODO\)/g)).toHaveLength(1);
    expect(fixed.match(/\r\n/g)).toHaveLength(doc.match(/\r\n/g)!.length);
    expect(fixed.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("keeps the CRLF of a lone CRLF-delimited line inside an LF document", () => {
    // Mixed endings: the fix must not normalize or drop the one \r.
    const doc = "Intro.\nSee [guide]() mid-line.\r\nOutro.\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("Intro.\nSee [guide](TODO) mid-line.\r\nOutro.\n");
    expect(fixed.match(/\r\n/g)).toHaveLength(1);
    expect(fixed).toContain("\nSee [guide](TODO) mid-line.\r\n");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("rule:missing-alt-text autofix", () => {
  it("describes an image at the end of a CRLF-delimited line without changing line endings", () => {
    const doc = "First line.\r\nSee ![](images/chart.png)\r\nLast line.\r\n";
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "First line.\r\nSee ![TODO: describe image](images/chart.png)\r\nLast line.\r\n",
    );
    expect(fixed.match(/\r\n/g)).toHaveLength(3);
    expect(fixed.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("inserts the description placeholder for an undescribed image and keeps the surrounding text (line endings %j)", (nl) => {
    const doc = `Intro café.${nl}${nl}Before ![](img/photo.png) after, with *emphasis*.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `Intro café.${nl}${nl}Before ![TODO: describe image](img/photo.png) after, with *emphasis*.${nl}`,
    );
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes an undescribed image that is the last thing in the document without adding a final newline with %j line endings", (newline) => {
    const doc = `Intro.${newline}${newline}![](images/last.png "Last")`;
    const expected = `Intro.${newline}${newline}![TODO: describe image](images/last.png "Last")`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).not.toMatch(/[\r\n]$/);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("undescribed-image autofix idempotence: generated documents", () => {
  const rules = [ruleMissingAltText];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  // Every fragment is placed in every position so each pairing is exercised,
  // including shapes the rule only half-understands (nested parens, brackets).
  const fragments = [
    "![](a.png)",
    '![ \t](<b c.png> "T")',
    "![ok](d.png)",
    "[![](e.png)](https://example.com)",
    "![](f(1).png)",
    "![](g$&$1.png)",
    "`![](code.png)`",
    "[x]()",
    "plain café 🚀",
    "",
  ];
  const prefixes = ["", "- ", "> ", "# ", "| "];

  it.each([
    "\n",
    "\r\n",
  ])("a second pass equals the first for every ordered pair of fragments and block prefix (line ending %j)", (nl) => {
    let checked = 0;
    for (const prefix of prefixes) {
      for (const a of fragments) {
        for (const b of fragments) {
          const doc = `${prefix}${a} ${b}${nl}tail${nl}`;
          const once = fixPass(doc);

          expect(fixPass(once), JSON.stringify(doc)).toBe(once);
          // Clean after one pass, or nothing the rule can touch was present.
          expect(lintDocument(once, { rules }), JSON.stringify(doc)).toEqual([]);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(prefixes.length * fragments.length ** 2);
  });

  it("the default and built-in rule sets reach a fixed point after the first autofix too", () => {
    const doc = fragments
      .map((fragment) => `- ${fragment}`)
      .join("\n")
      .concat("\n");
    for (const set of [
      BUILTIN_RULES.filter(({ id }) => LINTER_DEFAULT_ENABLED_RULES.includes(id)),
      // frontmatter-required is left out: its stub (`title: `) is trimmed by
      // no-trailing-spaces on the next pass, which is unrelated to images.
      BUILTIN_RULES.filter(({ id }) => id !== "frontmatter-required"),
    ]) {
      const pass = (text: string) =>
        applyAllFixes(text, lintDocument(text, { rules: set }));
      const once = pass(doc);

      expect(once).toContain("![TODO: describe image]");
      expect(pass(once)).toBe(once);
    }
  });
});

describe("autofix: a described image in a document without a final newline", () => {
  const rulesets = [
    [ruleMissingAltText],
    [ruleInvalidLinkTarget, ruleMissingAltText],
    BUILTIN_RULES.filter((rule) => LINTER_DEFAULT_ENABLED_RULES.includes(rule.id)),
  ];

  it.each([
    ["image only", "![Revenue chart](images/revenue.png)"],
    ["image after prose", "Intro café.\n\n![Revenue chart](images/revenue.png)"],
    ["image inside prose", "See ![Revenue chart](images/revenue.png) for *details*"],
    ["image in a list item", "- one\n- ![Revenue chart](images/revenue.png)"],
    ["image with title and query", '![Café chart](img/café.png?v=2#top "Revenue")'],
    ["image with a remote source", "![Chart](https://cdn.example.com/c.png?s=2)"],
    ["CRLF line endings", "# Report\r\n\r\n![Revenue chart](images/revenue.png)"],
  ])("reports nothing, leaves the document unchanged and adds no newline (%s)", (_name, doc) => {
    expect(doc.endsWith("\n")).toBe(false);
    for (const rules of rulesets) {
      const violations = lintDocument(doc, { rules }).filter(
        (v) => v.ruleId === "missing-alt-text" || v.ruleId === "invalid-link-target",
      );
      expect(violations).toEqual([]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(doc);
      expect(
        applyAllFixes(
          fixed,
          lintDocument(fixed, { rules }).filter(
            (v) =>
              v.ruleId === "missing-alt-text" || v.ruleId === "invalid-link-target",
          ),
        ),
      ).toBe(doc);
    }
  });

  it.each([
    ["dash", "- ", "\n"],
    ["star", "* ", "\r\n"],
    ["plus", "+ ", "\n"],
    ["ordered", "12. ", "\r\n"],
    ["task", "- [ ] ", "\n"],
    ["nested", "  - ", "\n"],
  ])("adds the alt-text placeholder to an undescribed image on a %s list-item line and keeps the marker", (_name, marker, nl) => {
    const doc = `Intro.${nl}${nl}${marker}![](img/fig.png "Fig") after${nl}${marker}keep${nl}`;
    const expected = `Intro.${nl}${nl}${marker}![TODO: describe image](img/fig.png "Fig") after${nl}${marker}keep${nl}`;
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`${marker}![TODO: describe image]`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: undescribed image between Unicode words", () => {
  const rules = [ruleMissingAltText];

  it.each([
    ["CJK neighbors", "単語", "単語", "words/chart.png"],
    ["emoji neighbors", "🌸", "🐈", "photos/cat.png"],
    ["ZWJ and skin-tone neighbors", "👨‍👩‍👧‍👦", "👩🏽‍💻", "img/family.png"],
    ["combining-mark neighbors", "cafe\u0301", "nai\u0308ve", "assets/dia.png"],
    ["mixed-script neighbors", "مرحبا", "こんにちは", "i18n/view.png"],
    ["fullwidth neighbors", "Ｗｏｒｄ", "Ｔｅｘｔ", "img/wide.png"],
  ])("inserts the description and preserves the abutting prose (%s)", (_name, before, after, src) => {
    for (const newline of ["\n", "\r\n"]) {
      const image = `![](${src})`;
      const repaired = `![TODO: describe image](${src})`;
      const doc = `${before}${image}${after}${newline}`;
      const expected = `${before}${repaired}${after}${newline}`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("missing-alt-text");
      expect(violations[0].range).toEqual({
        from: { offset: before.length, line: 1, col: before.length },
        to: {
          offset: before.length + image.length,
          line: 1,
          col: before.length + image.length,
        },
      });
      expect(
        doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
      ).toBe(image);

      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed.startsWith(before)).toBe(true);
      expect(fixed.endsWith(`${after}${newline}`)).toBe(true);
      expect(fixed).toContain(repaired);
      expect(lintDocument(fixed, { rules })).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes the image mid-sentence between spaced and unspaced Unicode words (%j line endings)", (newline) => {
    const before = "前文と🗺️ 博物館";
    const after = "駅へ🚶 مرحبا.";
    const image = "![](img/地図.png)";
    const doc = `# メモ${newline}${newline}${before}${image} ${after}${newline}終わり${newline}`;
    const expected = `# メモ${newline}${newline}${before}![TODO: describe image](img/地図.png) ${after}${newline}終わり${newline}`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe(image);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(before);
    expect(fixed).toContain(after);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("missing-alt-text autofix in a blockquote", () => {
  it.each([
    ["single level", "> ", "\n"],
    ["nested levels", "> > ", "\n"],
    ["no space after the marker", ">", "\r\n"],
  ])("describes an undescribed image and keeps the quote marker (%s)", (_name, marker, nl) => {
    const doc = `Intro.${nl}${nl}${marker}![](images/a.png "T") tail${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `Intro.${nl}${nl}${marker}![TODO: describe image](images/a.png "T") tail${nl}`,
    );
    expect(fixed).toContain(`${marker}![TODO: describe image]`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("reports an undescribed image after ordinary text at its exact position, then fixes only the alt text", () => {
    const lead = "Ordinary text before the figure: ";
    const doc = `# Title\n\n${lead}![](assets/fig one.png?v=2#top "Fig") and more.\n`;
    const expected = `# Title\n\n${lead}![TODO: describe image](assets/fig one.png?v=2#top "Fig") and more.\n`;
    const defaultRules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );

    for (const rules of [[ruleMissingAltText], defaultRules]) {
      const violations = lintDocument(doc, { rules }).filter(
        (violation) => violation.ruleId === "missing-alt-text",
      );
      expect(violations).toHaveLength(1);
      const { from } = violations[0].range!;
      expect(from.line).toBe(3);
      expect(doc.slice(from.offset)).toMatch(/^!\[\]\(assets\/fig one\.png/);
      expect(applyAllFixes(doc, violations)).toBe(expected);
    }
  });
});

describe("invalid-link-target autofix with Unicode link text in block containers", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["list item", "- ", "\n"],
    ["ordered list item", "1. ", "\r\n"],
    ["blockquote", "> ", "\n"],
    ["heading", "## ", "\n"],
    ["task list item", "- [ ] ", "\n"],
  ])("keeps the Unicode text and sets the destination to TODO in a %s", (_name, prefix, nl) => {
    for (const label of ["Руководство 日本語", "café 👩🏽‍💻", "دليل المستخدم"]) {
      const doc = `Intro.${nl}${nl}${prefix}See [${label}]() today${nl}`;
      const expected = `Intro.${nl}${nl}${prefix}See [${label}](TODO) today${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(`[${label}]()`);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it("keeps Unicode link text in a table cell and fixes only the invalid destination", () => {
    const doc =
      "| Имя | Ссылка |\n| --- | --- |\n| A | [Руководство 日本語]() |\n| B | [ok](./b.md) |\n";
    const expected = doc.replace(
      "[Руководство 日本語]()",
      "[Руководство 日本語](TODO)",
    );
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("invalid-link-target autofix with a valid link on the same line", () => {
  const valid = "[docs](./guide.md#intro)";
  const invalid = "[home](#)";

  it.each([
    [
      "invalid first",
      `${invalid} and ${valid}`,
      "[home](TODO) and [docs](./guide.md#intro)",
    ],
    [
      "valid first",
      `${valid} and ${invalid}`,
      "[docs](./guide.md#intro) and [home](TODO)",
    ],
  ])("replaces only the invalid destination (%s)", (_name, line, expectedLine) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `# Title${nl}${nl}See ${line}.${nl}`;
      const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(invalid);

      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(`# Title${nl}${nl}See ${expectedLine}.${nl}`);
      expect(fixed).toContain(valid);
      expect(lintDocument(fixed, { rules: [ruleInvalidLinkTarget] })).toEqual([]);
    }
  });
});

describe("autofix: undescribed image with a Unicode source", () => {
  const rules = [ruleMissingAltText];

  it.each([
    [
      "remote URL with a Unicode domain, path, query and fragment",
      "https://例え.テスト/画像/星🌟.png?言語=日本語#詳細",
      "",
    ],
    [
      "remote URL with a ZWJ emoji file name",
      "https://example.com/相册/familie-👨‍👩‍👧‍👦.webp?size=2#预览",
      " ",
    ],
    [
      "angle-bracket path with a space and a Unicode title",
      '<my 画像/星 星.png?言語=日本語> "タイトル 🌃"',
      "\t",
    ],
    [
      "decomposed accents with a Unicode query and fragment",
      "galerie/café-大学.png?größe=2#vorschau",
      "",
    ],
  ])("inserts the placeholder and preserves the source exactly (%s)", (_name, source, alt) => {
    for (const newline of ["\n", "\r\n"]) {
      const image = `![${alt}](${source})`;
      const repaired = `![TODO: describe image](${source})`;
      const doc = `# Report${newline}${newline}See ${image} for details.${newline}`;
      const expected = doc.replace(image, repaired);
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("missing-alt-text");
      expect(violations[0].fix).not.toBeNull();
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(image);
      expect(doc.slice(to.offset)).toBe(` for details.${newline}`);
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // The fix may add only the placeholder: the source bytes are identical.
      expect(fixed.indexOf(`](${source})`)).toBe(
        doc.indexOf(`](${source})`) + "TODO: describe image".length - alt.length,
      );
      expect(lintDocument(fixed, { rules })).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });

  it("preserves a Unicode source under the default-enabled rules", () => {
    const source = "画像/星🌟-café.png?言語=日本語#詳細";
    const doc = `# Gallery\n\n前置き ![](${source}) 後文, trailing   \n`;
    const expected = `# Gallery\n\n前置き ![TODO: describe image](${source}) 後文, trailing\n`;
    const defaultRules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(doc, { rules: defaultRules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "no-trailing-spaces",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`](${source})`);
    expect(lintDocument(fixed, { rules: defaultRules })).toEqual([]);
  });
});

// ─── Undescribed image on the final line after a valid paragraph ─────────────

describe("autofix: undescribed image on the final line after a valid paragraph", () => {
  const rules = [ruleMissingAltText];

  it.each([
    ["LF, trailing newline", "\n", "\n"],
    ["LF, no trailing newline", "\n", ""],
    ["CRLF, trailing newline", "\r\n", "\r\n"],
    ["CRLF, no trailing newline", "\r\n", ""],
  ])("inserts the description placeholder and preserves the preceding paragraph (%s)", (_name, nl, end) => {
    const paragraph = `A valid paragraph, wrapped${nl}over two lines with *emphasis* and [a link](./guide.md).`;
    const doc = `${paragraph}${nl}${nl}![](images/final.png)${end}`;
    const expected = `${paragraph}${nl}${nl}![TODO: describe image](images/final.png)${end}`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("![](images/final.png)");
    // The image is the last thing in the document, before any final newline.
    expect(to.offset).toBe(doc.length - end.length);

    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The paragraph ahead of the image is byte-identical.
    expect(fixed.startsWith(`${paragraph}${nl}${nl}`)).toBe(true);
    // Removing the inserted placeholder restores the original document.
    expect(fixed.replace("TODO: describe image", "")).toBe(doc);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(expected);
  });

  it.each([
    ["empty alt", ""],
    ["space-only alt", " "],
    ["tab-only alt", "\t"],
  ])("describes a final-line image with %s and keeps the paragraph under the default-enabled rules", (_name, alt) => {
    const paragraph = "Closing notes paragraph.";
    const doc = `${paragraph}\n\n![${alt}](img/end.png)\n`;
    const expected = `${paragraph}\n\n![TODO: describe image](img/end.png)\n`;
    const defaultRules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(doc, { rules: defaultRules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.startsWith(`${paragraph}\n\n`)).toBe(true);
    expect(lintDocument(fixed, { rules: defaultRules })).toEqual([]);
  });

  it.each([
    ".",
    ",",
    "!",
    "?",
    ";",
    ":",
    "...",
    "…",
    ").",
    "?!",
    "。",
  ])("describes an undescribed image followed by punctuation %j and leaves the punctuation unchanged", (punct) => {
    const rules = [ruleMissingAltText];
    for (const newline of ["\n", "\r\n"]) {
      const doc = `See the chart ![](images/chart.png?v=2#top "Chart")${punct} Next.${newline}`;
      const expected = `See the chart ![TODO: describe image](images/chart.png?v=2#top "Chart")${punct} Next.${newline}`;
      const violations = lintDocument(doc, { rules });

      expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed).toContain(`")${punct} Next.`);
      expect(lintDocument(fixed, { rules })).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });

  it("keeps punctuation that ends the document right after an undescribed image", () => {
    const rules = [ruleMissingAltText];
    const doc = "Look: ![](a.png).";
    const fixed = applyAllFixes(doc, lintDocument(doc, { rules }));
    expect(fixed).toBe("Look: ![TODO: describe image](a.png).");
  });

  it.each([
    ["spaced marker", "> "],
    ["tight marker", ">"],
    ["indented marker", "   > "],
    ["nested markers", "> > "],
    ["tab after marker", ">\t"],
  ])("inserts the placeholder for an undescribed image in a blockquote (%s) and keeps the quote and source", (_name, prefix) => {
    const rules = [ruleMissingAltText];
    const source = '<images/my chart.png?v=2#top> "Chart"';
    for (const newline of ["\n", "\r\n"]) {
      for (const alt of ["", "   "]) {
        const doc = `Intro.${newline}${newline}${prefix}![${alt}](${source})${newline}${prefix}Caption.${newline}`;
        const expected = `Intro.${newline}${newline}${prefix}![TODO: describe image](${source})${newline}${prefix}Caption.${newline}`;
        const violations = lintDocument(doc, { rules });

        expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
        const fixed = applyAllFixes(doc, violations);
        expect(fixed).toBe(expected);
        expect(lintDocument(fixed, { rules })).toEqual([]);
        expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
      }
    }
  });
});
