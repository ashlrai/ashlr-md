import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("invalid-link-target autofix: surrounding punctuation", () => {
  // Mirror of the trailing-punctuation cases above: these marks abut the
  // link's `[` with no space, and only the href may change.
  it.each([
    ";",
    ":",
    "!",
    "?",
    "…",
    "—",
    "–",
    "---",
    "”",
    "'",
    '"',
    "(",
    "<",
    "|",
    "•",
    "§",
    "†",
    "¡",
    "¿",
    "»",
  ])("keeps leading punctuation %j touching the link while the href becomes TODO", (punct) => {
    const rules = [ruleInvalidLinkTarget];
    for (const destination of ["", "  ", "#", "?"]) {
      for (const nl of ["\n", "\r\n"]) {
        const link = `[draft](${destination})`;
        const doc = `See${punct}${link} next.${nl}`;
        const expected = `See${punct}[draft](TODO) next.${nl}`;
        const violations = lintDocument(doc, { rules });

        expect(violations).toHaveLength(1);
        expect(violations[0].ruleId).toBe("invalid-link-target");
        const { from, to } = violations[0].range!;
        // The reported range covers the link only, not the abutting mark.
        expect(doc.slice(from.offset, to.offset)).toBe(link);
        expect(doc.slice(0, from.offset)).toBe(`See${punct}`);
        expect(applyFix(doc, violations[0])).toBe(expected);
        const fixed = applyAllFixes(doc, violations);
        expect(fixed).toBe(expected);
        expect(lintDocument(fixed, { rules })).toEqual([]);
      }
    }
  });

  // `!` abutting the `[` makes the link look like an image. An empty href is
  // not an image match, and a flagged one is reported as a link either way:
  // the `!` is outside the link's span and stays.
  it.each([
    ["an empty destination", "See ![draft]() next.", "See ![draft](TODO) next."],
    ["a lone fragment", "See ![draft](#) next.", "See ![draft](TODO) next."],
    [
      "a whitespace-only destination",
      "See ![draft](  ) next.",
      "See ![draft](TODO) next.",
    ],
  ])("keeps the image marker when the link has %s", (_name, line, expectedLine) => {
    const rules = [ruleInvalidLinkTarget];
    for (const nl of ["\n", "\r\n"]) {
      const doc = `${line}${nl}`;
      const expected = `${expectedLine}${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      const { from } = violations[0].range!;
      expect(doc[from.offset - 1]).toBe("!");
      expect(applyFix(doc, violations[0])).toBe(expected);
      expect(applyAllFixes(doc, violations)).toBe(expected);
      expect(lintDocument(expected, { rules })).toEqual([]);
    }
  });

  // Emphasis-style delimiter runs hugging both brackets are punctuation the
  // fix must leave in place: the delimiters, not the link text, carry them.
  it.each([
    ["strikethrough", "~~[draft]()~~ reads.", "~~[draft](TODO)~~ reads."],
    ["highlight", "==[draft](#)== reads.", "==[draft](TODO)== reads."],
    ["single tilde", "~[draft](  )~ reads.", "~[draft](TODO)~ reads."],
    ["strong underscores", "__[draft](?)__ reads.", "__[draft](TODO)__ reads."],
    ["triple emphasis", "***[draft]()*** reads.", "***[draft](TODO)*** reads."],
  ])("keeps %s delimiters hugging the link while the href becomes TODO", (_name, line, expectedLine) => {
    const rules = [ruleInvalidLinkTarget];
    for (const nl of ["\n", "\r\n"]) {
      const doc = `${line}${nl}`;
      const expected = `${expectedLine}${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  // Mismatched marks on the two sides — not an open/close pair — survive too.
  it.each([
    ["(see [draft]()!) end.", "(see [draft](TODO)!) end."],
    ["»[draft](). end.", "»[draft](TODO). end."],
    ["\"[draft](#)' end.", "\"[draft](TODO)' end."],
    ["([draft](  )… end.", "([draft](TODO)… end."],
    ["x—[draft]().—y", "x—[draft](TODO).—y"],
  ])("keeps mismatched marks on both sides while fixing %j", (line, expectedLine) => {
    const rules = [ruleInvalidLinkTarget];
    for (const nl of ["\n", "\r\n"]) {
      const doc = `${line}${nl}`;
      const expected = `${expectedLine}${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");
      expect(applyFix(doc, violations[0])).toBe(expected);
      expect(applyAllFixes(doc, violations)).toBe(expected);
      expect(lintDocument(expected, { rules })).toEqual([]);
    }
  });

  it("keeps a parenthesized aside touching the link's closing paren", () => {
    const rules = [ruleInvalidLinkTarget];
    for (const nl of ["\n", "\r\n"]) {
      // "(as amended)" is prose parens, not part of the link; it may not be
      // rewritten or swallowed by the fix.
      const doc = `Read [draft]()(as amended), ok.${nl}`;
      const expected = `Read [draft](TODO)(as amended), ok.${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe("[draft]()");
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed).toContain("(TODO)(as amended)");
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it("repairs punctuation-separated invalid links with no spaces between them", () => {
    const rules = [ruleInvalidLinkTarget];
    for (const nl of ["\n", "\r\n"]) {
      const doc = `[a](),[b]();[c](#) done.${nl}`;
      const expected = `[a](TODO),[b](TODO);[c](TODO) done.${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(3);
      expect(
        violations.map((v) => doc.slice(v.range!.from.offset, v.range!.to.offset)),
      ).toEqual(["[a]()", "[b]()", "[c](#)"]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // Only the three hrefs changed: undoing the placeholders restores the input.
      expect(
        fixed
          .replace("[a](TODO)", "[a]()")
          .replace("[b](TODO)", "[b]()")
          .replace("[c](TODO)", "[c](#)"),
      ).toBe(doc);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it("keeps punctuation touching an invalid link at the document's edges", () => {
    const rules = [ruleInvalidLinkTarget];
    for (const nl of ["\n", "\r\n"]) {
      const doc = `[draft](), opens here${nl}tail—[draft](#)`;
      const expected = `[draft](TODO), opens here${nl}tail—[draft](TODO)`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(2);
      expect(applyAllFixes(doc, violations)).toBe(expected);
      expect(lintDocument(expected, { rules })).toEqual([]);
    }
  });

  // Punctuation can also delimit a region where there is no link to fix at
  // all: a label separated from its parens by a space is prose, and a link
  // inside a code span or inline math is masked. Nothing may change.
  it.each([
    ["a space before the parens", "See [draft] () next."],
    ["a code span", "See `[draft]()` next."],
    ["inline math", "See $[draft]()$ next."],
  ])("leaves %j wrapping a link shape untouched", (_name, line) => {
    const rules = [ruleInvalidLinkTarget];
    for (const nl of ["\n", "\r\n"]) {
      const doc = `${line}${nl}`;
      expect(lintDocument(doc, { rules })).toEqual([]);
      expect(applyAllFixes(doc, lintDocument(doc, { rules }))).toBe(doc);
    }
  });

  it("repairs every invalid href in a punctuated sentence and keeps every mark", () => {
    const rules = [ruleInvalidLinkTarget];
    for (const nl of ["\n", "\r\n"]) {
      const doc = `Wow—[draft]()! Really? (see [more](#)); ok.${nl}`;
      const expected = `Wow—[draft](TODO)! Really? (see [more](TODO)); ok.${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(2);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // Only the two hrefs changed: undoing the placeholders restores the input.
      expect(
        fixed
          .replace("[draft](TODO)", "[draft]()")
          .replace("[more](TODO)", "[more](#)"),
      ).toBe(doc);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });
});
