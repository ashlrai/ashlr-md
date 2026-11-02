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
});

// ─── 3. Rule: missing-alt-text ────────────────────────────────────────────────

describe("rule:missing-alt-text", () => {
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
});

describe("autofix: empty document", () => {
  it("returns an empty document without throwing, across all built-in rules", () => {
    const violations = lintDocument("", { rules: BUILTIN_RULES });
    expect(() => applyAllFixes("", violations)).not.toThrow();
    expect(applyAllFixes("", violations)).toBe("");
  });

  it("returns an empty document when given no violations", () => {
    expect(applyAllFixes("", [])).toBe("");
  });

  it("fixAllViolations returns an empty document and records no history", () => {
    clearLintHistory();
    const violations = lintDocument("", { rules: BUILTIN_RULES });
    expect(fixAllViolations("", violations)).toBe("");
    expect(getLintHistory()).toEqual([]);
  });
});

describe("autofix: whitespace-only document", () => {
  it.each([
    ["spaces only", "   "],
    ["blank lines only", "\n\n"],
    ["mixed spaces, tabs and blank lines", " \t \n\n  \n"],
    ["CRLF blank lines with spaces", "\r\n  \r\n"],
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
});
