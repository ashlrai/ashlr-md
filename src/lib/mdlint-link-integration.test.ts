import { describe, expect, it } from "vitest";
import { clearLintHistory, fixAllViolations } from "../components/LinterToast";
import { applyAllFixes, applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

// Consolidated link-autofix regressions from the verified backlog PR heads.
// Source mappings and preservation evidence are in BRIDGE_NOTES.md.

describe("invalid-link autofix: replaying stale violations", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("applying the same first-pass violations a second time leaves the fixed text unchanged (%s)", (_name, nl) => {
    const doc = [
      "Read [a]() and [b](   ) and [c](#) and [d](?) here.",
      "Keep [ok](./guide.md) and `[code]()`.",
      "",
    ].join(nl);
    const violations = lintDocument(doc, { rules });
    expect(violations).toHaveLength(4);

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(
      [
        "Read [a](TODO) and [b](TODO) and [c](TODO) and [d](TODO) here.",
        "Keep [ok](./guide.md) and `[code]()`.",
        "",
      ].join(nl),
    );
    // The editor may fire fix-all again with the lint result it already holds.
    expect(applyAllFixes(once, violations)).toBe(once);
    expect(fixAllViolations(once, violations)).toBe(once);
  });
});

// ─── Invalid link with a Unicode label ──────────────────────────────────────

describe("invalid-link-target autofix: Unicode label preserved exactly", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["empty", ""],
    ["whitespace-only", " \t "],
    ["lone hash", "#"],
    ["lone question mark", "?"],
  ])("replaces a %s href with TODO and keeps the Unicode label byte-for-byte", (_name, href) => {
    const label = "日本語ガイド café 資料 👩🏽‍💻";
    const link = `[${label}](${href})`;
    // The label also appears as bare prose before the link; the flag and the
    // fix target the bracketed link only.
    const doc = `🌍 ${label} — see ${link} and [ok](./ok.md).\n`;
    const expected = `🌍 ${label} — see [${label}](TODO) and [ok](./ok.md).\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(link);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`[${label}](TODO)`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["a dollar-ampersand", "料金 $& 円"],
    ["a dollar-quote", "説明 $' 後"],
    ["a dollar-number", "手順 $1 円"],
  ])("keeps a Unicode label containing %s verbatim when the href becomes TODO", (_name, label) => {
    // The fix splices rather than substitutes: `$` sequences in the label can
    // never expand into the matched text.
    const doc = `See [${label}](#) now.\n`;
    const expected = `See [${label}](TODO) now.\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });

  it("keeps NFC and NFD labels byte-for-byte distinct while fixing each at its own offset", () => {
    const nfc = "café"; // U+00E9
    const nfd = "café"; // e + U+0301
    expect(nfc).not.toBe(nfd);
    const doc = `[${nfc}](#) and [${nfd}](#).\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(
      violations.map((v) => doc.slice(v.range!.from.offset, v.range!.to.offset)),
    ).toEqual([`[${nfc}](#)`, `[${nfd}](#)`]);
    expect(applyFix(doc, violations[0])).toBe(`[${nfc}](TODO) and [${nfd}](#).\n`);
    expect(applyFix(doc, violations[1])).toBe(`[${nfc}](#) and [${nfd}](TODO).\n`);
    const expected = `[${nfc}](TODO) and [${nfd}](TODO).\n`;
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    // Nothing was normalized: the NFD label still differs from the NFC one.
    expect(fixed.normalize("NFC")).toBe(`[${nfc}](TODO) and [${nfc}](TODO).\n`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes the recorded link, not an identical link masked in a code span, when a prior fix shifted the offsets", () => {
    const label = "利用ガイド";
    const decoy = `\`[${label}](#)\``;
    const doc = `${decoy} then [wide](      ) and [${label}](#) end.\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(
      violations.map((v) => doc.slice(v.range!.from.offset, v.range!.to.offset)),
    ).toEqual(["[wide](      )", `[${label}](#)`]);

    // Repairing the wide href first shrinks the document, so the recorded
    // offset of the Unicode-labelled link overshoots it. The fix must still
    // land on the real link — not on the masked twin earlier in the file.
    const once = applyFix(doc, violations[0]);
    expect(once).toBe(`${decoy} then [wide](TODO) and [${label}](#) end.\n`);
    const twice = applyFix(once, violations[1]);
    expect(twice).toBe(`${decoy} then [wide](TODO) and [${label}](TODO) end.\n`);
    // The batched pass reaches the same document.
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(twice);
    expect(fixed).toContain(decoy);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("keeps a long Unicode label whole when the message excerpt cuts a surrogate pair", () => {
    // Code unit 30 sits inside the emoji's surrogate pair: the message shows
    // an excerpt ending mid-pair, but the fix must splice the label whole.
    const label = `${"案".repeat(29)}🌸`;
    expect(label.length).toBeGreaterThan(30);
    const doc = `Read [${label}](#) next.\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toBe(
      `Invalid link target: [${label.slice(0, 30)}](#)`,
    );
    const expected = `Read [${label}](TODO) next.\n`;
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`[${label}](TODO)`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes the link-shaped part of an image while keeping its Unicode alt text", () => {
    const doc = "---\ntitle: Guide\n---\n\n![桜の図](#) and [ok](./ok.md).\n";
    const violations = lintDocument(doc, { rules });

    // The alt text is non-empty, so missing-alt-text stays quiet even under
    // the default rules; only the invalid destination is reported.
    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(lintDocument(doc).map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const expected = "---\ntitle: Guide\n---\n\n![桜の図](TODO) and [ok](./ok.md).\n";
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });
});

describe("invalid-link autofix across separate lines", () => {
  it.each([
    ["empty and fragment", "", "#"],
    ["whitespace-only and bare query", " \t ", "?"],
    ["two whitespace shapes", "  ", "\t"],
  ])("turns both invalid hrefs (%s) into TODO and keeps every surrounding byte", (_name, first, second) => {
    for (const nl of ["\n", "\r\n"]) {
      const head = "Top: café ☕ — [1], `x()` and [ok](./ok.md).";
      const mid = [
        "A [valid](./docs.md) link on its own line.",
        "",
        "> quoted [not a link] and *emphasis*.",
      ].join(nl);
      const tail = "Tail: (parens) &amp; done.";
      const firstLink = `[alpha](${first})`;
      const secondLink = `[omega](${second})`;
      const doc = [
        head,
        `First ${firstLink} mid-sentence.`,
        mid,
        `Last line ends ${secondLink} here.`,
        tail,
        "",
      ].join(nl);
      const expected = doc
        .replace(firstLink, "[alpha](TODO)")
        .replace(secondLink, "[omega](TODO)");
      const rules = [ruleInvalidLinkTarget];
      const violations = lintDocument(doc, { rules });

      expect(violations.map((v) => v.ruleId)).toEqual([
        "invalid-link-target",
        "invalid-link-target",
      ]);
      // Violations arrive in document order, each spanning its own link alone.
      expect(violations[0].range!.from.line).toBe(2);
      expect(violations[1].range!.from.line).toBe(6);
      expect(
        violations.map((v) => doc.slice(v.range!.from.offset, v.range!.to.offset)),
      ).toEqual([firstLink, secondLink]);
      expect(violations.every((v) => v.fix !== null)).toBe(true);

      // Each fix repairs only the href on its own line.
      expect(applyFix(doc, violations[0])).toBe(
        doc.replace(firstLink, "[alpha](TODO)"),
      );
      expect(applyFix(doc, violations[1])).toBe(
        doc.replace(secondLink, "[omega](TODO)"),
      );

      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
      // Both invalid hrefs became TODO …
      expect(fixed).toContain("[alpha](TODO)");
      expect(fixed).toContain("[omega](TODO)");
      expect(fixed.match(/\(TODO\)/g)).toHaveLength(2);
      // … and nothing else moved: the line count is unchanged and removing
      // the two link spans leaves byte-identical surroundings.
      expect(fixed.split(nl)).toHaveLength(doc.split(nl).length);
      expect(fixed.replace("[alpha](TODO)", "").replace("[omega](TODO)", "")).toBe(
        doc.replace(firstLink, "").replace(secondLink, ""),
      );
      const remaining = lintDocument(fixed, { rules });
      expect(remaining).toEqual([]);
      expect(applyAllFixes(fixed, remaining)).toBe(expected);
      // The toast's Fix all entry point produces the same bytes.
      clearLintHistory();
      expect(fixAllViolations(doc, violations)).toBe(expected);
      clearLintHistory();
    }
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes identical invalid links on separate lines and keeps a pre-existing TODO destination untouched (%j)", (nl) => {
    const decoy = "[done](TODO)";
    const link = "[draft](#)";
    const doc = [
      `First ${link} here.`,
      `Middle ${decoy} and [ok](./ok.md).`,
      `Last ${link} there.`,
      "",
    ].join(nl);
    const expected = [
      "First [draft](TODO) here.",
      `Middle ${decoy} and [ok](./ok.md).`,
      "Last [draft](TODO) there.",
      "",
    ].join(nl);
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    // A destination that already reads TODO is a valid link and is not flagged.
    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
    ]);
    expect(violations.map((v) => v.range!.from.offset)).toEqual([
      doc.indexOf(link),
      doc.lastIndexOf(link),
    ]);
    // Each fix rewrites only its own occurrence of the identical link.
    expect(applyFix(doc, violations[0])).toBe(doc.replace(link, "[draft](TODO)"));
    expect(applyFix(doc, violations[1])).toBe(
      `${doc.slice(0, doc.lastIndexOf(link))}[draft](TODO)${doc.slice(doc.lastIndexOf(link) + link.length)}`,
    );

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    // Two fresh TODO destinations plus the pre-existing one; the middle
    // line and both link lines' prose are byte-identical.
    expect(fixed.match(/\(TODO\)/g)).toHaveLength(3);
    expect(fixed.split(nl)[1]).toBe(`Middle ${decoy} and [ok](./ok.md).`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("invalid-link autofix in a list item: marker and prose stay intact", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["-", ""],
    ["*", "#"],
    ["+", "?"],
    ["3.", "  "],
    ["  -", ""],
  ])("puts TODO in the destination and keeps the %j marker and the prose on both sides of the link (invalid href %j)", (marker, href) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `Steps:${nl}${marker} Read [the guide](${href}) before coding.${nl}${marker} Keep [ok](./ok.md) too.${nl}`;
      const expected = `Steps:${nl}${marker} Read [the guide](TODO) before coding.${nl}${marker} Keep [ok](./ok.md) too.${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
      // The flagged range covers the link only: the marker and the prose on
      // either side of it in the item sit outside the span.
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(`[the guide](${href})`);
      expect(doc.slice(0, from.offset)).toBe(`Steps:${nl}${marker} Read `);

      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed).toContain(`${marker} Read [the guide](TODO) before coding.`);
      expect(lintDocument(fixed, { rules })).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });

  it.each([
    ["-", "\n"],
    ["2)", "\r\n"],
    ["  *", "\n"],
  ])("keeps the %j marker and the following item when the invalid link ends the item line (line ending %j)", (marker, nl) => {
    const doc = `${marker} See the [release notes]()${nl}${marker} Next item stays.${nl}`;
    const expected = `${marker} See the [release notes](TODO)${nl}${marker} Next item stays.${nl}`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[release notes]()");
    // The link's `)` is the last byte before the line ending; the fix must
    // stop there and leave the next item's marker untouched.
    expect(doc.slice(to.offset, to.offset + nl.length)).toBe(nl);

    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`${nl}${marker} Next item stays.${nl}`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it("repairs the live link in the item, never its identical twin inside a code span", () => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `- Sample \`[a]()\` shows syntax; the live [a]() needs a target.${nl}- Next.${nl}`;
      const violations = lintDocument(doc, { rules });

      // The code span masks its twin from the rule and from the fix's masked
      // search alike: only the prose link is flagged.
      expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe("[a]()");
      expect(doc.indexOf("[a]()")).toBeLessThan(from.offset);

      const expected = `- Sample \`[a]()\` shows syntax; the live [a](TODO) needs a target.${nl}- Next.${nl}`;
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // Marker, code sample and item prose are byte-for-byte intact.
      expect(fixed).toContain("- Sample `[a]()`");
      // A stale fix finds no live `[a]()` outside the masked span, so it is a
      // no-op rather than a rewrite of the sample.
      expect(applyFix(fixed, violations[0])).toBe(fixed);
      expect(lintDocument(fixed, { rules })).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });

  it.each([
    "\n",
    "\r\n",
  ])("flags only the empty-href link when the item's prose carries look-alike brackets and parens (%j)", (nl) => {
    const doc = `- Note [guide]: call f(a, b), then [guide]() yields g(c) — see (p. 4).${nl}`;
    const expected = `- Note [guide]: call f(a, b), then [guide](TODO) yields g(c) — see (p. 4).${nl}`;
    const violations = lintDocument(doc, { rules });

    // The bare "[guide]" mention, the f(…)/g(…) calls and "(p. 4)" are item
    // prose, not links: only the empty href is flagged.
    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[guide]()");

    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Removing the placeholder restores the original item byte-for-byte —
    // marker and prose included.
    expect(fixed.replace("[guide](TODO)", "[guide]()")).toBe(doc);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("invalid-link-target autofix: a valid link is never modified", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    [
      "an https URL with query and fragment",
      "See [docs](https://example.com/a?x=1#top) here.\n",
    ],
    ["an http URL", "See [docs](http://example.com/page) here.\n"],
    ["a relative path", "See [guide](./docs/guide.md) here.\n"],
    ["a named fragment", "See [section](#setup) here.\n"],
    ["a query-only target", "See [search](?page=2) here.\n"],
    ["a padded '#' target", "See [padded]( # ) here.\n"],
    ["a padded '?' target", "See [spaced]( ? ) here.\n"],
    ["a titled link", 'See [api](./api.md "API ref") here.\n'],
    ["a mailto link", "See [mail](mailto:user@example.com) here.\n"],
    ["the TODO placeholder itself", "See [draft](TODO) here.\n"],
    ["a single-character target", "See [x](a) here.\n"],
    ["a link in a list item", "- See [docs](https://example.com) here.\n"],
    ["a link in a blockquote", "> See [docs](https://example.com) here.\n"],
    ["link-shaped text inside a code span", "Keep `[draft]()` literal in code.\n"],
    ["a CRLF-delimited line", "See [docs](https://example.com) here.\r\n"],
    ["no final newline", "See [docs](https://example.com) here."],
  ])("reports no violation and returns the complete document unchanged for %s", (_name, doc) => {
    const violations = lintDocument(doc, { rules });
    expect(violations).toEqual([]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(doc);
    // A second pass is equally inert.
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(doc);
  });

  it("fixes an invalid link while the valid link beside it stays byte-identical", () => {
    const valid = '[docs](https://example.com/a?x=1#top "Docs")';
    const doc = `See ${valid} and [broken]() too.\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`See ${valid} and [broken](TODO) too.\n`);
    expect(fixed).toContain(valid);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it("returns the complete document unchanged under the default rule set", () => {
    const doc =
      "---\ntitle: Links\n---\n\n# Links\n\nSee [docs](https://example.com/a?x=1#top) and [guide](./g.md) here.\n";
    const violations = lintDocument(doc);
    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
  });
});

describe("invalid-link-target autofix: trailing punctuation", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["a hashtag after a fragment href", "#", "#readme"],
    ["a question mark after a query href", "?", "?"],
    ["empty parentheses", "", "()"],
    ["a sideways smiley", "", ":-)"],
    ["a winking smiley", "#", ";-)"],
    ["a lone closing bracket", "#", "]"],
    ["an image opener", "#", "![x]"],
    ["bracketed prose", "  ", "[later]"],
    ["a parenthesized aside", "#", "(aside)"],
    ["an ellipsis entity", "", "&hellip;"],
    ["an em-dash entity", "#", "&mdash;"],
    ["a possessive 's", "#", "'s"],
    ["a stray asterisk", "", "*"],
    ["a percent sign", "#", "%"],
    ["a tilde pair", "?", "~~"],
    ["an interrobang", "#", "‽"],
    ["an arrow", "", "→"],
  ])("keeps %s touching the closing paren untouched while the destination becomes TODO", (_name, destination, trailing) => {
    const link = `[draft](${destination})`;
    const doc = `See ${link}${trailing} next line.\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    // The reported range stops at the link's closing paren.
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(link);
    const expected = `See [draft](TODO)${trailing} next line.\n`;
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    "？",
    "！",
    "；",
    "：",
    "・",
    "｡",
    "〜",
  ])("keeps the fullwidth mark %j on a link that closes a CJK sentence", (punct) => {
    const doc = `次は[ガイド](#)${punct}続き。\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[ガイド](#)");
    const expected = `次は[ガイド](TODO)${punct}続き。\n`;
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["a heading", "## See [a](#)?\n", "## See [a](TODO)?\n"],
    ["a blockquote", "> Quoth [a](#)! next.\n", "> Quoth [a](TODO)! next.\n"],
    ["a table cell", "| t | See [a](#). | b |\n", "| t | See [a](TODO). | b |\n"],
    ["a task item", "- [ ] Read [a](#)!\n", "- [ ] Read [a](TODO)!\n"],
    [
      "a footnote definition",
      "[^1]: Read [a](#) now.\n",
      "[^1]: Read [a](TODO) now.\n",
    ],
  ])("keeps trailing punctuation on an invalid link inside %s", (_name, doc, expected) => {
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["[a](#),[b](#);[c](?)!\n", "[a](TODO),[b](TODO);[c](TODO)!\n", 3],
    ["[a](#).[b](#)\n", "[a](TODO).[b](TODO)\n", 2],
    ["See [a](#)**[b](#)** ok.\n", "See [a](TODO)**[b](TODO)** ok.\n", 2],
    ["See [a](#)»[b](#)«fin» ok.\n", "See [a](TODO)»[b](TODO)«fin» ok.\n", 2],
    ["See [a](#)→ [b](#) ok.\n", "See [a](TODO)→ [b](TODO) ok.\n", 2],
  ])("keeps the punctuation separating abutting links in %j", (doc, expected, count) => {
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(count);
    expect(
      violations.every((v) => v.ruleId === "invalid-link-target" && v.fix !== null),
    ).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("repairs identical links abutting different punctuation, each at its own offset", () => {
    const doc = "[x](#), [x](#); [x](#)!\n";
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "invalid-link-target",
      "invalid-link-target",
      "invalid-link-target",
    ]);
    // A single fix repairs only its own occurrence.
    expect(applyFix(doc, violations[0])).toBe("[x](TODO), [x](#); [x](#)!\n");
    expect(applyFix(doc, violations[1])).toBe("[x](#), [x](TODO); [x](#)!\n");
    expect(applyFix(doc, violations[2])).toBe("[x](#), [x](#); [x](TODO)!\n");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("[x](TODO), [x](TODO); [x](TODO)!\n");
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it("keeps punctuation in the label, the href marker and after the closing paren at once", () => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `Wait, [what?!](#)?${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe("[what?!](#)");
      const expected = `Wait, [what?!](TODO)?${nl}`;
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      // Only the href changed; undoing the placeholder restores the input.
      expect(fixed.replaceAll("(TODO)", "(#)")).toBe(doc);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });
});

describe("invalid-link-target autofix: Unicode link text", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["empty", ""],
    ["a lone #", "#"],
    ["a lone ?", "?"],
    ["whitespace-only", " \t "],
    ["an ideographic space", "　"],
  ])("keeps the Unicode label byte-for-byte and replaces a %s href with TODO", (_kind, href) => {
    const label = "日本語 の ガイド — café 🧭";
    const doc = `前文 [${label}](${href}) 後文 [ok](./ok.md).\n`;
    const expected = `前文 [${label}](TODO) 後文 [ok](./ok.md).\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`[${label}](${href})`);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["combining marks", "é ñ"],
    ["RTL Arabic", "مرحبا بالعالم"],
    ["a ZWJ emoji sequence", "👩‍💻 dev team"],
    ["astral-plane letters", "𝒳𝒴 𝓏"],
    ["emphasis inside a CJK label", "**重要** ガイド"],
  ])("fixes an empty href and keeps a label with %s", (_kind, label) => {
    const doc = `See [${label}]() now.\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`See [${label}](TODO) now.\n`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("preserves a decomposed (NFD) label without normalizing it to NFC", () => {
    const label = "café au lait";
    // The fixture must be genuinely decomposed for this test to mean anything.
    expect(label).not.toBe(label.normalize("NFC"));
    const doc = `See [${label}](#) now.\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`See [${label}](TODO) now.\n`);
    // "café" below is NFC (́); the fix must not fold the label into it.
    expect(fixed).not.toContain("[café au lait](TODO)");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes two identical Unicode-labelled invalid links independently", () => {
    const doc = "[同じ]() と [同じ]() も。\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(applyFix(doc, violations[1])).toBe("[同じ]() と [同じ](TODO) も。\n");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("[同じ](TODO) と [同じ](TODO) も。\n");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes only the invalid link when a valid Unicode-labelled link shares the line", () => {
    const doc = "案内 [ガイド](./guide.md) と [続き]() おわり\n";
    const expected = "案内 [ガイド](./guide.md) と [続き](TODO) おわり\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[続き]()");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain("[ガイド](./guide.md)");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});
