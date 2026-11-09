import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  applyFix,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
  ruleNoTrailingSpaces,
} from "./mdlint";

describe("invalid-link autofix on a final line with no trailing newline (default rules)", () => {
  it("inserts the documented TODO href and appends no newline", () => {
    const doc = "# Guide\n\nSee [valid](./a.md) first.\nLast: [draft]()";
    const violations = lintDocument(doc).filter(
      (v) => v.ruleId === "invalid-link-target",
    );

    expect(violations).toHaveLength(1);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe("# Guide\n\nSee [valid](./a.md) first.\nLast: [draft](TODO)");
    expect(fixed.endsWith("\n")).toBe(false);
    expect(
      lintDocument(fixed).filter((v) => v.ruleId === "invalid-link-target"),
    ).toEqual([]);
  });
});

describe("autofix: undescribed image inside a blockquote", () => {
  const rules = [ruleMissingAltText];

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the placeholder and keeps every blockquote marker, including a quoted fence's decoy image (%s)", (_name, nl) => {
    // A fence may open inside a blockquote; the `![](decoy.png)` line inside
    // it is code and is not flagged, and each `>` prefix stays in place.
    const doc = [
      "> Example:",
      "> ```md",
      "> ![](decoy.png)",
      "> ```",
      '> Real ![](shots/real%20one.png?v=2#top "Real") here.',
      "",
    ].join(nl);
    const expected = [
      "> Example:",
      "> ```md",
      "> ![](decoy.png)",
      "> ```",
      '> Real ![TODO: describe image](shots/real%20one.png?v=2#top "Real") here.',
      "",
    ].join(nl);
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(
      '![](shots/real%20one.png?v=2#top "Real")',
    );
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The placeholder went in once and every line's `>` marker survived.
    expect(fixed.match(/TODO: describe image/g)).toHaveLength(1);
    expect(fixed.split(nl).filter((line) => line.startsWith(">"))).toHaveLength(5);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("fixes only the quoted occurrence when an identical image sits in an earlier fenced block (%s)", (_name, nl) => {
    const doc = [
      "```md",
      "![](same.png)",
      "```",
      "",
      "> Quote ![](same.png) end.",
      "",
    ].join(nl);
    const expected = [
      "```md",
      "![](same.png)",
      "```",
      "",
      "> Quote ![TODO: describe image](same.png) end.",
      "",
    ].join(nl);
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("![](same.png)");
    // The violation's line opens with `> `, so the fix splices inside the
    // quote and cannot rewrite the fenced copy or drop the marker.
    const lineStart = doc.lastIndexOf(nl, from.offset) + nl.length;
    expect(doc.slice(lineStart, from.offset)).toBe("> Quote ");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.split(nl)[1]).toBe("![](same.png)");
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the placeholder on a quote line ending in a hard break and keeps the break spaces (%s)", (_name, nl) => {
    const doc = `> Text ![](a.png)  ${nl}> Next.${nl}`;
    const expected = `> Text ![TODO: describe image](a.png)  ${nl}> Next.${nl}`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("![](a.png)");
    // The image's range ends before the two-space break, which the fix keeps.
    expect(doc.slice(to.offset, to.offset + 2)).toBe("  ");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.startsWith("> ")).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("autofix: undescribed image on the final line without a trailing newline", () => {
  it.each([
    ["only line", "![](shot.png)", "![TODO: describe image](shot.png)"],
    [
      "after other lines",
      'Intro.\n\n![](images/a%20b.png?v=2#top "Chart")',
      'Intro.\n\n![TODO: describe image](images/a%20b.png?v=2#top "Chart")',
    ],
    [
      "inline with text",
      "Before ![](a.png) after.",
      "Before ![TODO: describe image](a.png) after.",
    ],
    [
      "CRLF document",
      "Intro.\r\n![](a.png)",
      "Intro.\r\n![TODO: describe image](a.png)",
    ],
  ])("inserts the placeholder and adds no newline (%s)", (_name, doc, expected) => {
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: link placeholder idempotence", () => {
  it.each([
    "\n",
    "\r\n",
  ])("leaves the first pass unchanged on a second pass with %j line endings", (nl) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = `See [docs]() and [home](#) now.${nl}`;
    const violations = lintDocument(doc, { rules });
    expect(violations.length).toBeGreaterThan(0);

    const once = applyAllFixes(doc, violations);
    expect(once).toContain("[docs](TODO)");
    expect(once).not.toBe(doc);

    const secondPassViolations = lintDocument(once, { rules });
    expect(secondPassViolations).toEqual([]);
    expect(applyAllFixes(once, secondPassViolations)).toBe(once);
  });
});

describe("autofix: document mixing several described and undescribed images", () => {
  const rules = [ruleMissingAltText];
  const doc = [
    "# Gallery",
    "",
    "![Logo](logo.png) and ![](one.png)",
    "",
    '- ![Chart **Q3**](q3.png "Q3") ![ ](two.png)',
    "",
    "![](three.png)",
    "![Team photo](team%20photo.png?v=2#top)",
    "",
  ].join("\n");
  const placeholder = "![TODO: describe image]";
  const expected = [
    "# Gallery",
    "",
    `![Logo](logo.png) and ${placeholder}(one.png)`,
    "",
    `- ![Chart **Q3**](q3.png "Q3") ${placeholder}(two.png)`,
    "",
    `${placeholder}(three.png)`,
    "![Team photo](team%20photo.png?v=2#top)",
    "",
  ].join("\n");

  it("reports one violation per undescribed image and none for described ones", () => {
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
      "missing-alt-text",
    ]);
  });

  it("applyAllFixes repairs every undescribed image and keeps every described one", () => {
    const fixed = applyAllFixes(doc, lintDocument(doc, { rules }));

    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(expected);
  });

  it("applying fixes one at a time converges to the same document", () => {
    let current = doc;
    for (let remaining = 3; remaining > 0; remaining--) {
      const violations = lintDocument(current, { rules });
      expect(violations).toHaveLength(remaining);
      current = applyFix(current, violations[0]);
    }

    expect(current).toBe(expected);
  });
});

describe("autofix: undescribed image at the start of a paragraph", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the description placeholder and preserves the preceding paragraph and following prose (%s)", (_name, nl) => {
    const src = "images/chart.png";
    const image = `![](${src})`;
    const placeholder = `![TODO: describe image](${src})`;

    // Paragraph before the blank-line separator (a separate paragraph).
    const preceding = "Previous paragraph with [a link](./guide.md).";
    // Image at the very start of a new paragraph, with prose on the same line.
    const proseAfter = " This sentence follows the image with *emphasis* and `code`.";
    // Continuation of the same paragraph (soft line break).
    const continuation = ` Final sentence stays.${nl}`;

    const doc = `${preceding}${nl}${nl}${image}${proseAfter}${nl}${continuation}`;
    const expected = `${preceding}${nl}${nl}${placeholder}${proseAfter}${nl}${continuation}`;

    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(image);

    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);

    // Acceptance: the preceding paragraph is untouched.
    expect(fixed.startsWith(`${preceding}${nl}${nl}`)).toBe(true);
    // Acceptance: the prose after the image on the same line is preserved.
    expect(fixed.split(nl)[2].slice(placeholder.length)).toBe(proseAfter);
    // Acceptance: the continuation line of the paragraph is preserved.
    expect(fixed.split(nl)[3]).toBe(continuation.slice(0, -nl.length));
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the placeholder for an image alone on the paragraph-start line with prose on the next line (%s)", (_name, nl) => {
    const src = "photo.jpg";
    const image = `![](${src})`;
    const placeholder = `![TODO: describe image](${src})`;

    // A preceding paragraph separated by a blank line.
    const preceding = "Intro text with [refs](./a.md).";
    // Image alone on its line (start of new paragraph), prose on the next line
    // which is a soft break continuing the same paragraph.
    const proseLine = "Body prose with **bold** and [links](./b.md) here.";
    const last = "Closing paragraph.";

    const doc = [preceding, "", image, proseLine, "", last, ""].join(nl);
    const expected = [preceding, "", placeholder, proseLine, "", last, ""].join(nl);

    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);

    // Acceptance: the preceding paragraph is byte-for-byte preserved.
    expect(fixed.startsWith(`${preceding}${nl}${nl}`)).toBe(true);
    // Acceptance: the prose line after the image is preserved.
    expect(fixed.split(nl)[3]).toBe(proseLine);
    // Acceptance: the closing paragraph is preserved.
    expect(fixed.endsWith(`${nl}${last}${nl}`)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("autofix: undescribed image with a Unicode path in block containers", () => {
  // NFC "é" (U+00E9) and NFD "e" + U+0301 must stay distinct, byte for byte.
  const nfc = "img/café/日本語 図.png";
  const nfd = "img/café/日本語 図.png";

  it.each([
    ["list item", "- ", `<${nfc}> "図"`],
    ["blockquote", "> ", `<${nfd}> "図"`],
    ["nested quote list", "> - ", "img/東京/ملف.png?言語=日本語#詳細"],
  ])("fills the placeholder and keeps the exact path (%s)", (_name, prefix, dest) => {
    const rules = [ruleMissingAltText];
    const doc = `前文\n\n${prefix}見て ![](${dest}) 後\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`前文\n\n${prefix}見て ![TODO: describe image](${dest}) 後\n`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("keeps NFC and NFD paths distinct when both images need a placeholder", () => {
    const rules = [ruleMissingAltText];
    const doc = `![](<${nfc}>) ![ ](<${nfd}>)\n`;
    const fixed = applyAllFixes(doc, lintDocument(doc, { rules }));

    expect(fixed).toBe(
      `![TODO: describe image](<${nfc}>) ![TODO: describe image](<${nfd}>)\n`,
    );
  });
});

describe("autofix: invalid link with a Unicode label from other scripts", () => {
  it.each([
    ["Hangul", "한국어 가이드"],
    ["Thai", "คู่มือภาษาไทย"],
    ["Devanagari with conjuncts", "हिन्दी मार्गदर्शिका"],
    ["bidi controls around Hebrew", "‫מדריך‬ ‏עברית‏"],
    ["fullwidth punctuation", "ガイド（第１章）！"],
  ])("keeps the %s label exactly and sets the destination to TODO", (_kind, label) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = `前 [${label}]() 後\n`;
    const expected = `前 [${label}](TODO) 後\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.slice(fixed.indexOf("[") + 1, fixed.indexOf("](TODO)"))).toBe(label);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: described and undescribed images sharing a destination", () => {
  it.each([
    true,
    false,
  ])("preserves the described image bytes under default rules (described first: %s)", (describedFirst) => {
    const described = '![Cafe\u0301 東京](images/shared.png?v=2#top "Figure")';
    const missing = '![](images/shared.png?v=2#top "Figure")';
    const repaired = '![TODO: describe image](images/shared.png?v=2#top "Figure")';
    const pair = (image: string) =>
      describedFirst ? `${described} ${image}` : `${image} ${described}`;
    const doc = `---\r\ntitle: Gallery\r\n---\r\n\r\n${pair(missing)}\r\n`;
    const expected = `---\r\ntitle: Gallery\r\n---\r\n\r\n${pair(repaired)}\r\n`;
    const violations = lintDocument(doc);

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe(missing);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    const preserved = fixed.slice(
      fixed.indexOf(described),
      fixed.indexOf(described) + described.length,
    );
    expect(new TextEncoder().encode(preserved)).toEqual(
      new TextEncoder().encode(described),
    );
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(lintDocument(fixed)).toEqual([]);
  });
});

describe("autofix: undescribed image with a deeply nested path", () => {
  it.each([
    ["five levels deep", "assets/images/2024/screenshots/ui/dashboard.png"],
    ["dot-segment directories", "my.project/assets_v2/img.v3/final-shot.png"],
    [
      "hyphenated and underscored directories",
      "docs/user-guide/screens_hot/app/main_window.png",
    ],
    ["a ../ segment mid-path", "assets/../shared/img/icons/app.svg"],
    ["leading ../ segments", "../../shared/img/icons/app.svg"],
    ["nested path with query and fragment", "assets/img/ui/panels/nav.png?w=640#top"],
    ["nested path with a title", 'assets/img/ui/panels/nav.png "Navigation"'],
  ])("inserts the description placeholder and preserves the full path (%s)", (_name, src) => {
    for (const alt of ["", "  "]) {
      const doc = `Intro. ![${alt}](${src}) outro.\n`;
      const expected = `Intro. ![TODO: describe image](${src}) outro.\n`;
      const rules = [ruleMissingAltText];
      const violations = lintDocument(doc, { rules });

      expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
      const { from, to } = violations[0].range!;
      // The violation covers the whole image markup, so the fix cannot
      // truncate the nested destination.
      expect(doc.slice(from.offset, to.offset)).toBe(`![${alt}](${src})`);
      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed).toContain(`![TODO: describe image](${src})`);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("preserves the full nested path byte-for-byte under the default rules (%s line endings)", (_name, nl) => {
    const src = "assets/images/2024/q4/screenshots/ui/dashboard.png";
    const doc = [
      "---",
      "title: Report",
      "---",
      "",
      "Quarterly summary.",
      "",
      `![ ](${src})`,
      "",
      "End.",
      "",
    ].join(nl);
    const expected = doc.replace(`![ ](${src})`, `![TODO: describe image](${src})`);
    const violations = lintDocument(doc);

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe(`![ ](${src})`);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`![TODO: describe image](${src})`);
    // The only change is the inserted placeholder: the whitespace-only
    // description becomes "TODO: describe image".
    expect(fixed.length).toBe(doc.length + "TODO: describe image".length - 1);
    expect(lintDocument(fixed)).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed))).toBe(fixed);
  });
});

describe("autofix: undescribed image in a nested or continued list item", () => {
  it.each([
    [
      "child of a nested bullet",
      "- Parent\n  - ![](deep/one.png)\n  - Sibling\n",
      "- Parent\n  - ![TODO: describe image](deep/one.png)\n  - Sibling\n",
    ],
    [
      "continuation paragraph of an ordered item",
      '1. First\n\n   ![ ](img/two.png?v=2#top "Two")\n\n2. Second\n',
      '1. First\n\n   ![TODO: describe image](img/two.png?v=2#top "Two")\n\n2. Second\n',
    ],
    [
      "item inside a blockquote",
      "> - ![](q/three.png)\n> - Plain\n",
      "> - ![TODO: describe image](q/three.png)\n> - Plain\n",
    ],
  ])("keeps the list marker and image path (%s)", (_name, doc, expected) => {
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: invalid link and undescribed image on separate lines", () => {
  it.each([
    [
      "link first",
      ["Read [the guide]() now.", "Plain  middle line.", "Then ![](pic.png) here."],
    ],
    [
      "image first",
      ["Then ![](pic.png) here.", "Plain  middle line.", "Read [the guide]() now."],
    ],
  ])("puts each placeholder on its original line and keeps the other text (%s)", (_name, lines) => {
    const doc = `${lines.join("\n")}\n`;
    const expectedLines = lines.map((line) =>
      line.replace("]()", "](TODO)").replace("![]", "![TODO: describe image]"),
    );
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const violations = lintDocument(doc, { rules });
    expect(violations.map(({ ruleId }) => ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed.split("\n")).toEqual([...expectedLines, ""]);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: undescribed image on a later line", () => {
  it.each([
    "\n",
    "\r\n",
  ])("gives only the targeted image the placeholder and leaves every preceding line unchanged with %j line endings", (nl) => {
    const preceding = [
      "# Gallery",
      "",
      "Opening café paragraph.",
      "![Logo](logo.png)",
      "```md",
      "![](in-code.png)",
      "```",
      "",
    ].join(nl);
    const doc = `${preceding}${nl}Chart: ![](images/chart.png "Chart") end.${nl}Tail line.${nl}`;
    const expected = `${preceding}${nl}Chart: ![TODO: describe image](images/chart.png "Chart") end.${nl}Tail line.${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(violations[0].range?.from.line).toBe(9);
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toBe(expected);
    expect(fixed.startsWith(`${preceding}${nl}`)).toBe(true);
    expect(fixed.endsWith(`${nl}Tail line.${nl}`)).toBe(true);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: invalid link at the end of a paragraph", () => {
  it.each([
    ["empty href", "()", "."],
    ["empty href, no trailing punctuation", "()", ""],
    ["fragment-only href", "(#)", "."],
    ["whitespace href", "( )", ""],
  ])("%s: href becomes TODO and the preceding prose is kept", (_name, dest, tail) => {
    const prose = "Intro sentence with *emphasis*, then read ";
    const doc = `${prose}[the guide]${dest}${tail}\n\nNext paragraph.\n`;
    const expected = `${prose}[the guide](TODO)${tail}\n\nNext paragraph.\n`;
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyFix(doc, violations[0]);
    expect(fixed).toBe(expected);
    expect(fixed.startsWith(prose)).toBe(true);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes the link ending a final paragraph with no trailing newline", () => {
    const doc = "First.\n\nSee [docs]()";
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(applyAllFixes(doc, violations)).toBe("First.\n\nSee [docs](TODO)");
  });
});

describe("autofix: invalid link inside a heading", () => {
  it.each([
    [
      "an ATX heading",
      "## Read [the guide]() first\n",
      "## Read [the guide](TODO) first\n",
      "## Read ",
      " first",
    ],
    [
      "an ATX heading with closing hashes",
      "# Intro [the guide]() #\n",
      "# Intro [the guide](TODO) #\n",
      "# Intro ",
      " #",
    ],
    [
      "a CRLF heading",
      "### Intro [the guide]()\r\n\r\nBody.\r\n",
      "### Intro [the guide](TODO)\r\n\r\nBody.\r\n",
      "### Intro ",
      "",
    ],
    [
      "a setext heading",
      "Intro [the guide]()\n===\n",
      "Intro [the guide](TODO)\n===\n",
      "Intro ",
      "",
    ],
  ])("sets the href to TODO and keeps the heading text and link label intact in %s", (_kind, doc, expected, headPrefix, headSuffix) => {
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["invalid-link-target"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyFix(doc, violations[0])).toBe(expected);
    // The href is now exactly TODO, and the label and heading text are untouched.
    expect(fixed).toContain("[the guide](TODO)");
    expect(fixed).not.toContain("[the guide]()");
    expect(fixed).toContain(`${headPrefix}[the guide]`);
    expect(fixed).toContain(`(TODO)${headSuffix}`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: invalid link at the start of a line keeps the prose that follows", () => {
  it.each([
    ["no indent, no final newline", "[a]() then prose.", "[a](TODO) then prose."],
    [
      "indented up to three spaces",
      "Intro.\n\n   [a]() then *prose*.\nTail.\n",
      "Intro.\n\n   [a](TODO) then *prose*.\nTail.\n",
    ],
    [
      "a valid link later on the line",
      "[a]() and [b](./b.md) end.\n",
      "[a](TODO) and [b](./b.md) end.\n",
    ],
    [
      "an invalid link later on the line too",
      "[a]() and [b]() end.\n",
      "[a](TODO) and [b](TODO) end.\n",
    ],
    [
      "a following blank line and paragraph",
      "[a]()\n\nNext paragraph.\n",
      "[a](TODO)\n\nNext paragraph.\n",
    ],
  ])("turns the empty destination into TODO with %s", (_name, doc, expected) => {
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules });

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.ruleId === "invalid-link-target")).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
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

describe("autofix: an invalid link in a loose list item", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["-", "  ", "\n"],
    ["1.", "   ", "\r\n"],
  ])("keeps the label, marker %j and indented continuation paragraph (line ending %j)", (marker, indent, nl) => {
    const doc = [
      `${marker} Café [**guía** 🎉]() first.`,
      "",
      `${indent}Second paragraph, see [notes](  ) and [ok](./a.md).`,
      "",
      `${marker} [last]()`,
      "",
    ].join(nl);
    const expected = [
      `${marker} Café [**guía** 🎉](TODO) first.`,
      "",
      `${indent}Second paragraph, see [notes](TODO) and [ok](./a.md).`,
      "",
      `${marker} [last](TODO)`,
      "",
    ].join(nl);

    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(
      Array(3).fill("invalid-link-target"),
    );
    expect(
      violations.map((v) => doc.slice(v.range!.from.offset, v.range!.to.offset)),
    ).toEqual(["[**guía** 🎉]()", "[notes](  )", "[last]()"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyAllFixes(doc, [...violations].reverse())).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("autofix: undescribed images each alone on consecutive lines", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("describes both images and keeps the %s line breaks and neighbours intact", (_name, nl) => {
    const rules = [ruleMissingAltText];
    const doc = [
      "Before",
      "![](one.png)",
      '![ ](two%20b.png?v=2#x "Two")',
      "After",
      "",
    ].join(nl);
    const expected = [
      "Before",
      "![TODO: describe image](one.png)",
      '![TODO: describe image](two%20b.png?v=2#x "Two")',
      "After",
      "",
    ].join(nl);
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    // Each fix alone touches only its own image; together they match the expected text.
    expect(applyFix(doc, violations[0])).toBe(
      doc.replace("![](one.png)", "![TODO: describe image](one.png)"),
    );
    expect(applyFix(doc, violations[1])).toBe(
      doc.replace(
        '![ ](two%20b.png?v=2#x "Two")',
        '![TODO: describe image](two%20b.png?v=2#x "Two")',
      ),
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/\r\n|\n|\r/g)).toEqual(doc.match(/\r\n|\n|\r/g));
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: already-described image", () => {
  it.each([
    ["plain alt text", "![A bar chart](images/chart.png)\n"],
    [
      "alt text with a title, query and fragment",
      'Before ![Q3 revenue](images/a%20b.png?v=2#top "Chart") after.\n',
    ],
    ["alt text with Unicode and an emoji", "![図 😀 café](日本語/図.png)\n"],
    ["alt text that is the placeholder", "![TODO: describe image](a.png)\n"],
    ["a reference-style image", "![Logo][logo]\n\n[logo]: logo.svg\n"],
    ["a CRLF document without a final newline", "Intro\r\n\r\n![Logo](logo.svg)"],
  ])("leaves the alt text and source unchanged for %s", (_name, doc) => {
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toEqual([]);
    expect(applyAllFixes(doc, violations)).toBe(doc);
    expect(lintDocument(applyAllFixes(doc, violations), { rules })).toEqual([]);
  });

  it("fixes only the undescribed image and leaves the described one byte-identical", () => {
    const rules = [ruleMissingAltText];
    const doc = '![Kept alt](keep.png?v=1#x "T") and ![](new.png)\n';
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(applyAllFixes(doc, violations)).toBe(
      '![Kept alt](keep.png?v=1#x "T") and ![TODO: describe image](new.png)\n',
    );
  });
});

describe("autofix: invalid link beside punctuation at line edges", () => {
  it.each([
    ["punctuation before at line start", "...", "", "", "... "],
    ["colon-terminated lead-in", "Note:", "", ".", " "],
    ["comma, colon and question mark in the label", "", "", "?", " "],
  ])("%s keeps the placeholder documented and the punctuation unchanged", (name, lead, _unused, tail, gap) => {
    const label = name.startsWith("comma") ? "Why, exactly: this?" : "broken";
    for (const target of ["", "   ", "#"]) {
      for (const nl of ["\n", "\r\n"]) {
        const link = `[${label}](${target})`;
        const doc = `${lead}${gap}${link}${tail}${nl}- item;${link},${nl}`;
        const expected = `${lead}${gap}[${label}](TODO)${tail}${nl}- item;[${label}](TODO),${nl}`;
        const rules = [ruleInvalidLinkTarget];
        const violations = lintDocument(doc, { rules });

        expect(violations).toHaveLength(2);
        const fixed = applyAllFixes(doc, violations);
        expect(fixed).toBe(expected);
        expect(lintDocument(fixed, { rules })).toEqual([]);
      }
    }
  });
});

describe("missing-alt-text autofix: whitespace-only alt image at the end of a line", () => {
  it.each([
    "\n",
    "\r\n",
  ])("fixes the image and leaves the preceding prose byte-for-byte unchanged with %j line endings", (newline) => {
    const prose = [
      "Hard break above.  ",
      "Use `code`, *emphasis*, &amp; café → see ",
    ].join(newline);
    const image = '![ \t ](<my dir/a (1).png> "Chart")';
    const fixedImage = '![TODO: describe image](<my dir/a (1).png> "Chart")';
    const tail = `${newline}Next line.${newline}`;
    const doc = `${prose}${image}${tail}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(violations[0].range!.from.offset).toBe(prose.length);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`${prose}${fixedImage}${tail}`);
    expect(fixed.slice(0, prose.length)).toBe(prose);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: undescribed image whose source has a directory path", () => {
  it.each([
    ["nested relative", "assets/img/diagrams/a.png"],
    ["dot-slash", "./assets/a.png"],
    ["parent traversal", "../../shared/assets/a.png"],
    ["root-absolute", "/static/images/2024/a.png"],
    ["trailing-dot directories", "docs.v2/img.d/a.png"],
    ["backslash separators", "assets\\img\\a.png"],
    ["directory with query and title", 'assets/img/a.png?v=2#top "Chart"'],
  ])("keeps the full source path (%s)", (_kind, dest) => {
    const rules = [ruleMissingAltText];
    const doc = `Before ![](${dest}) after.\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`Before ![TODO: describe image](${dest}) after.\n`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes several directory-path images on one line independently", () => {
    const rules = [ruleMissingAltText];
    const doc = "![](a/b/one.png) and ![ ](../c/d/two.png)\n";
    const fixed = applyAllFixes(doc, lintDocument(doc, { rules }));
    expect(fixed).toBe(
      "![TODO: describe image](a/b/one.png) and ![TODO: describe image](../c/d/two.png)\n",
    );
  });
});

describe("autofix: described and undescribed images on adjacent lines", () => {
  const described = '![Team photo](images/team.jpg "Retreat")';
  const undescribed = "![](images/chart.png?v=2#top)";
  const repaired = "![TODO: describe image](images/chart.png?v=2#top)";

  it.each([
    ["\n", "described first", [described, undescribed], [described, repaired]],
    ["\n", "undescribed first", [undescribed, described], [repaired, described]],
    ["\r\n", "described first", [described, undescribed], [described, repaired]],
    ["\r\n", "undescribed first", [undescribed, described], [repaired, described]],
  ])("gives the placeholder only to the undescribed image with %j line endings (%s)", (nl, _order, before, after) => {
    const rules = [ruleMissingAltText];
    const doc = `${before.join(nl)}${nl}`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    expect(violations[0].range?.from.offset).toBe(doc.indexOf(undescribed));

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(`${after.join(nl)}${nl}`);
    expect(fixed.split("TODO: describe image")).toHaveLength(2);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
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

describe("autofix: undescribed image with a Unicode destination", () => {
  it.each([
    ["Cyrillic path", "картинки/схема.png"],
    ["right-to-left path", "صور/مخطط.png"],
    [
      "internationalized host, path, query and fragment",
      "https://例え.jp/画像/図.png?名前=値#見出し",
    ],
    ["angle-bracketed path with spaces", "<изображения/моя схема (1).png>"],
  ])("keeps the destination and adds the placeholder next to a described sibling (%s)", (_name, target) => {
    const sibling = "![Диаграмма](схема.svg)";
    const doc = `Начало.\n\n![](${target}) и ${sibling} конец.\n`;
    const expected = `Начало.\n\n![TODO: describe image](${target}) и ${sibling} конец.\n`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("missing-alt-text");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain(`(${target})`);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: undescribed image after a parenthesis, tab or checked-task list marker", () => {
  it.each([
    ["parenthesis ordered marker", "1) ", "\n"],
    ["tab-indented dash", "\t- ", "\r\n"],
    ["plus nested four spaces", "    + ", "\n"],
    ["checked task item", "* [x] ", "\r\n"],
  ])("adds the placeholder and leaves the marker unchanged (%s)", (_kind, marker, nl) => {
    // Tab/4-space indents only form a list item under a parent item; alone they are code.
    const parent =
      marker.startsWith(" ") || marker.startsWith("\t") ? `- Parent${nl}` : "";
    const doc = `${parent}${marker}![](a.png)${nl}${marker}![ ](dir/b%20c.png?v=1#x "B")${nl}${marker}![Ok](ok.png)${nl}`;
    const expected = `${parent}${marker}![TODO: describe image](a.png)${nl}${marker}![TODO: describe image](dir/b%20c.png?v=1#x "B")${nl}${marker}![Ok](ok.png)${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "missing-alt-text",
    ]);
    expect(applyFix(doc, violations[0])).toBe(
      `${parent}${marker}![TODO: describe image](a.png)${nl}${marker}![ ](dir/b%20c.png?v=1#x "B")${nl}${marker}![Ok](ok.png)${nl}`,
    );
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("invalid-link-target autofix: Unicode link text", () => {
  it.each([
    ["Café", ""],
    ["cafe\u0301", " \t "],
    ["日本語 🔗", "#"],
    ["مرحبا 👩🏽‍💻", "?"],
  ])("preserves the label %s while replacing href %j", (label, href) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = `Read [${label}](${href}) next.\r\n`;
    const expected = `Read [${label}](TODO) next.\r\n`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(doc, violations[0])).toBe(expected);
    expect(applyAllFixes(doc, violations)).toBe(expected);
    expect(lintDocument(expected, { rules })).toEqual([]);
  });
});

describe("autofix: undescribed image preserves unrelated following lines", () => {
  it.each([
    ["\n", ""],
    ["\r\n", ""],
    ["\n", " \t "],
    ["\r\n", " \t "],
  ])("changes only the missing image description with %j line endings and alt %j", (newline, alt) => {
    const image = `![${alt}](images/chart.png?v=2#top "Chart")`;
    const repaired = `![TODO: describe image](images/chart.png?v=2#top "Chart")`;
    // A battery of unrelated lines after the image: a heading, list items, a
    // blockquote, a fenced code block holding an undescribed-image lookalike,
    // a table row holding a described image, and a Unicode tail line. None of
    // them may change or produce a finding of their own.
    const following = [
      "## Results",
      "",
      "- First finding stays.",
      "- Second `code` finding stays.",
      "",
      "> Quoted [context](./context.md) stays.",
      "",
      "```",
      "![](skip.png) stays code, not a finding.",
      "```",
      "",
      "| Kind | Value |",
      "| ---- | ----- |",
      '| Image | ![described](ok.png "Ok") |',
      "",
      "Tail café ☕ line.",
      "",
    ];
    const lines = (img: string) =>
      [
        ["---", "title: Report", "---"].join(newline),
        "",
        "# Report",
        "",
        "Intro paragraph with [a link](./guide.md).",
        "",
        img,
        "",
        ...following,
      ].join(newline);
    const doc = lines(image);
    const expected = lines(repaired);
    const rules = [ruleMissingAltText];

    // The document is clean under the full default rule set except for the
    // undescribed image, so only the missing image description may change.
    for (const violations of [lintDocument(doc, { rules }), lintDocument(doc)]) {
      expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
      const { from, to } = violations[0].range!;
      expect(doc.slice(from.offset, to.offset)).toBe(image);

      expect(applyFix(doc, violations[0])).toBe(expected);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);

      // The diff is confined to the image range: the prefix before it and
      // every following line after it are byte-for-byte the original.
      expect(fixed.slice(0, from.offset)).toBe(doc.slice(0, from.offset));
      expect(fixed.slice(from.offset + repaired.length)).toBe(doc.slice(to.offset));
      expect(fixed.length - doc.length).toBe(repaired.length - image.length);

      // Line-for-line, not just a matching tail: the image's line is the
      // repaired image and all lines below it are identical.
      const docLines = doc.split(newline);
      const fixedLines = fixed.split(newline);
      expect(fixedLines).toHaveLength(docLines.length);
      expect(fixedLines[from.line - 1]).toBe(repaired);
      expect(fixedLines.slice(from.line)).toEqual(docLines.slice(from.line));

      expect(lintDocument(fixed, { rules })).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });
});

describe("invalid-link-target autofix: an invalid link inside emphasis", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["asterisk italic", "*", "*"],
    ["underscore italic", "_", "_"],
    ["asterisk bold", "**", "**"],
    ["underscore bold", "__", "__"],
    ["asterisk bold italic", "***", "***"],
    ["strikethrough", "~~", "~~"],
  ])("replaces an invalid href with TODO inside %s and keeps the delimiters and link text", (_name, open, close) => {
    for (const target of ["", "  ", "#", "?"]) {
      for (const nl of ["\n", "\r\n"]) {
        const link = `[the guide](${target})`;
        const doc = `See ${open}${link}${close} for details.${nl}`;
        const expected = `See ${open}[the guide](TODO)${close} for details.${nl}`;
        const violations = lintDocument(doc, { rules });

        expect(violations).toHaveLength(1);
        expect(violations[0].ruleId).toBe("invalid-link-target");
        // The violation range is the link alone: the emphasis delimiters
        // sit outside it and are no part of the repair.
        const { from, to } = violations[0].range!;
        expect(doc.slice(from.offset, to.offset)).toBe(link);
        expect(applyFix(doc, violations[0])).toBe(expected);
        const fixed = applyAllFixes(doc, violations);
        expect(fixed).toBe(expected);
        expect(fixed).toContain(`${open}[the guide](TODO)${close}`);
        expect(lintDocument(fixed, { rules })).toEqual([]);
        expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(expected);
      }
    }
  });

  it("fixes an invalid link inside emphasis that also spans the words around it", () => {
    const doc = "*see the [guide]() for details*, then [ok](./ok.md).\n";
    const expected = "*see the [guide](TODO) for details*, then [ok](./ok.md).\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[guide]()");
    expect(applyFix(doc, violations[0])).toBe(expected);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The emphasized prose around the link is byte-for-byte identical.
    expect(fixed.startsWith("*see the [guide](TODO) for details*")).toBe(true);
    expect(fixed).toContain("[ok](./ok.md)");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("keeps emphasis inside the label of an emphasized invalid link", () => {
    const doc = "See **[a _very_ bold guide]()** now.\n";
    const expected = "See **[a _very_ bold guide](TODO)** now.\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const { from, to } = violations[0].range!;
    expect(doc.slice(from.offset, to.offset)).toBe("[a _very_ bold guide]()");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // The nested `_very_` inside the label survives untouched.
    expect(fixed).toContain("[a _very_ bold guide](TODO)");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes an invalid link inside emphasis in a heading", () => {
    const doc = "## See *the [guide]() now*\n\nBody text.\n";
    const expected = "## See *the [guide](TODO) now*\n\nBody text.\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("invalid-link-target");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("fixes every emphasized invalid link in a document and keeps each emphasis pair", () => {
    const doc = "*[one]()* then **[two](#)** and _three [three](  )_ end.\n";
    const expected =
      "*[one](TODO)* then **[two](TODO)** and _three [three](TODO)_ end.\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(3);
    expect(violations.every((v) => v.ruleId === "invalid-link-target")).toBe(true);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/\]\(TODO\)/g)).toHaveLength(3);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });

  it("inserts TODO into an emphasized link whose label is empty", () => {
    const doc = "Note *[]()* here.\n";
    const expected = "Note *[](TODO)* here.\n";
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("[link](empty)");
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("autofix: invalid link on the final line after a valid paragraph", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["LF, trailing newline", "\n", "\n"],
    ["LF, no trailing newline", "\n", ""],
    ["CRLF, trailing newline", "\r\n", "\r\n"],
    ["CRLF, no trailing newline", "\r\n", ""],
  ])("replaces the destination and preserves the preceding paragraph byte-for-byte (%s)", (_name, nl, end) => {
    const paragraph = [
      "A valid paragraph citing [docs](./guide.md) with *emphasis* and café text",
      "that wraps onto a second line, both of which stay untouched.",
    ].join(nl);
    const doc = `${paragraph}${nl}${nl}[broken]()${end}`;
    const expected = `${paragraph}${nl}${nl}[broken](TODO)${end}`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
    expect(violations[0].fix).not.toBeNull();
    const { from, to } = violations[0].range!;
    // The link alone is the final line: it starts at column 0 right after
    // the blank line and ends at the document's last byte before `end`.
    const lastLine = doc.split("\n").length - (end === "" ? 0 : 1);
    expect(from.line).toBe(lastLine);
    expect(to.line).toBe(lastLine);
    expect(from.col).toBe(0);
    expect(from.offset).toBe(paragraph.length + nl.length * 2);
    expect(doc.slice(from.offset, to.offset)).toBe("[broken]()");
    expect(to.offset).toBe(doc.length - end.length);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(applyFix(doc, violations[0])).toBe(expected);
    // Acceptance: the preceding paragraph is preserved byte-for-byte.
    expect(fixed.slice(0, paragraph.length)).toBe(paragraph);
    expect(fixed.endsWith(`${nl}[broken](TODO)${end}`)).toBe(true);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \t "],
    ["a bare fragment marker", "#"],
    ["a bare query marker", "?"],
  ])("replaces %s destination when the link is the whole final line", (_name, href) => {
    for (const nl of ["\n", "\r\n"]) {
      for (const end of [nl, ""]) {
        const paragraph = "Intro paragraph with [a valid link](./a.md).";
        const link = `[see more](${href})`;
        const doc = `${paragraph}${nl}${nl}${link}${end}`;
        const expected = `${paragraph}${nl}${nl}[see more](TODO)${end}`;
        const violations = lintDocument(doc, { rules });

        expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
        const { from, to } = violations[0].range!;
        expect(doc.slice(from.offset, to.offset)).toBe(link);
        expect(applyFix(doc, violations[0])).toBe(expected);
        const fixed = applyAllFixes(doc, violations);
        expect(fixed).toBe(expected);
        expect(fixed.slice(0, paragraph.length)).toBe(paragraph);
        expect(lintDocument(fixed, { rules })).toEqual([]);
      }
    }
  });

  it("fixes only the destination under the full default rule set and keeps the paragraph", () => {
    for (const nl of ["\n", "\r\n"]) {
      const paragraph = "A valid paragraph citing [docs](./guide.md).";
      const doc = `---${nl}title: Notes${nl}---${nl}${nl}${paragraph}${nl}${nl}[broken](#)${nl}`;
      const expected = doc.replace("[broken](#)", "[broken](TODO)");
      const violations = lintDocument(doc);

      expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed).toContain(`${nl}${nl}${paragraph}${nl}${nl}`);
      expect(lintDocument(fixed)).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed))).toBe(expected);
    }
  });

  it("repairs the link when its final line continues the paragraph without a blank line", () => {
    for (const nl of ["\n", "\r\n"]) {
      const paragraph = "First line of a valid paragraph with [docs](./guide.md).";
      const doc = `${paragraph}${nl}[broken]()${nl}`;
      const expected = `${paragraph}${nl}[broken](TODO)${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations.map((v) => v.ruleId)).toEqual(["invalid-link-target"]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(expected);
      expect(fixed.slice(0, paragraph.length)).toBe(paragraph);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });

  it("repairs the final-line link while a trailing-spaces fix cleans the paragraph above", () => {
    const doc = "Paragraph with trailing spaces.   \n\n[broken]()";
    const expected = "Paragraph with trailing spaces.\n\n[broken](TODO)";
    const both = [ruleNoTrailingSpaces, ruleInvalidLinkTarget];
    const violations = lintDocument(doc, { rules: both });

    expect(violations.map((v) => v.ruleId)).toEqual([
      "no-trailing-spaces",
      "invalid-link-target",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(lintDocument(fixed, { rules: both })).toEqual([]);
  });
});

describe("invalid-link-target autofix beside a described image", () => {
  const image = "![Architecture diagram](img/arch.png)";
  const invalid = "[home](#)";

  it.each([
    ["image first", `${image} ${invalid}`, `${image} [home](TODO)`],
    ["link first", `${invalid} ${image}`, `[home](TODO) ${image}`],
  ])("fixes the link and preserves the image exactly (%s)", (_name, line, expectedLine) => {
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    for (const nl of ["\n", "\r\n"]) {
      const doc = `# Title${nl}${nl}${line}${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleId).toBe("invalid-link-target");

      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(`# Title${nl}${nl}${expectedLine}${nl}`);
      expect(fixed).toContain(image);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });
});

describe("missing-alt-text autofix beside a valid link", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
  const link = '[guide](./guide.md?view=full#intro "Guide")';
  const image = '![](images/chart.png "Chart")';
  const described = '![TODO: describe image](images/chart.png "Chart")';

  it.each([
    ["image first", `${image} ${link}`, `${described} ${link}`],
    ["link first", `${link} ${image}`, `${link} ${described}`],
  ])("describes only the image when the %s appears on the same line", (_name, line, expected) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `# Guide${nl}${nl}See ${line} today.${nl}`;
      const violations = lintDocument(doc, { rules });

      expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(`# Guide${nl}${nl}See ${expected} today.${nl}`);
      expect(fixed).toContain(link);
      expect(lintDocument(fixed, { rules })).toEqual([]);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
    }
  });
});

describe("autofix: invalid link beside an undescribed image", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText];

  it.each([
    "\n",
    "\r\n",
  ])("inserts both placeholders and leaves the surrounding prose unchanged (%j)", (nl) => {
    const doc = `Intro prose.${nl}${nl}Read [the guide]() first, then look at ![](chart.png) closely.${nl}${nl}Closing prose.${nl}`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `Intro prose.${nl}${nl}Read [the guide](TODO) first, then look at ![TODO: describe image](chart.png) closely.${nl}${nl}Closing prose.${nl}`,
    );
    // Both placeholders are present, each exactly once.
    expect(fixed.match(/\(TODO\)/g)).toHaveLength(1);
    expect(fixed.match(/!\[TODO: describe image\]/g)).toHaveLength(1);
    // Prose between and around the two constructs is byte-identical.
    for (const prose of [
      "Intro prose.",
      "Read ",
      " first, then look at ",
      " closely.",
      "Closing prose.",
    ]) {
      expect(fixed).toContain(prose);
    }
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("invalid-link-target autofix: blockquote marker styles", () => {
  const rules = [ruleInvalidLinkTarget];

  it.each([
    ["no space after the marker", ">See [tight]() here.", ">See [tight](TODO) here."],
    ["tab after the marker", ">\tSee [tabbed](#) here.", ">\tSee [tabbed](TODO) here."],
    [
      "marker indented three spaces",
      "   > See [indented]( ) here.",
      "   > See [indented](TODO) here.",
    ],
    [
      "blockquote inside a list item",
      "- item\n  > See [nested]() here.",
      "- item\n  > See [nested](TODO) here.",
    ],
    [
      "quote nested without spaces",
      ">> See [deep](?) here.",
      ">> See [deep](TODO) here.",
    ],
  ])("keeps the blockquote and link text, replacing only the destination (%s)", (_name, body, expected) => {
    for (const nl of ["\n", "\r\n"]) {
      const doc = `${body.replace(/\n/g, nl)}${nl}`;
      const violations = lintDocument(doc, { rules });
      expect(violations).toHaveLength(1);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(`${expected.replace(/\n/g, nl)}${nl}`);
      expect(lintDocument(fixed, { rules })).toEqual([]);
    }
  });
});

describe("rule:missing-alt-text undescribed image on the line after ordinary prose", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the description placeholder and keeps the preceding prose line byte-identical (%s)", (_name, nl) => {
    const prose = "Ordinary prose with café, 100% *sure*, a_b_c & (parens) [brackets].";
    const image = '![](images/chart.png "Chart")';
    const doc = `${prose}${nl}${image}${nl}`;
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map((v) => v.ruleId)).toEqual(["missing-alt-text"]);
    // The image is reported on the line right after the prose line.
    expect(violations[0].range!.from.line).toBe(2);
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe(image);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      `${prose}${nl}![TODO: describe image](images/chart.png "Chart")${nl}`,
    );
    // Only the image line changed; the preceding prose line is untouched.
    expect(fixed.split(nl)).toHaveLength(doc.split(nl).length);
    expect(fixed.split(nl)[0]).toBe(prose);
    expect(fixed.startsWith(`${prose}${nl}`)).toBe(true);
    expect(applyFix(doc, violations[0])).toBe(fixed);
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });
});

describe("invalid-link-target autofix: adjacent links in block contexts", () => {
  it.each([
    "\n",
    "\r\n",
  ])("applying autofix twice equals once for back-to-back invalid links in a list, quote and table (%j)", (nl) => {
    const doc = [
      "# Links",
      "",
      "- [a]()[b](#) tail",
      "> [c](?) and [d](  )",
      "",
      "| col | link |",
      "| --- | --- |",
      "| x | [e]() |",
      "",
    ].join(nl);
    const rules = [ruleInvalidLinkTarget];
    const fix = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

    const once = fix(doc);
    expect(once).not.toBe(doc);
    expect(once.match(/\]\(TODO\)/g)).toHaveLength(5);
    expect(fix(once)).toBe(once);
    expect(lintDocument(once, { rules })).toEqual([]);
  });
});

describe("whitespace-only description on an image wrapped in a valid link", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("inserts the placeholder and keeps both the image destination and the link target (%s)", (_name, nl) => {
    const rules = [ruleMissingAltText, ruleInvalidLinkTarget];
    const doc = `Click [![  \t](images/thumb.png?size=2#full "Thumb")](https://example.com/full.png) now.${nl}`;
    const expected = `Click [![TODO: describe image](images/thumb.png?size=2#full "Thumb")](https://example.com/full.png) now.${nl}`;
    const violations = lintDocument(doc, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
    ]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed).toContain('(images/thumb.png?size=2#full "Thumb")');
    expect(fixed).toContain("(https://example.com/full.png)");
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});

describe("link and image autofix: mixed invalid link and undescribed image", () => {
  const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
  const fixPass = (text: string) => applyAllFixes(text, lintDocument(text, { rules }));

  it("first pass fixes one invalid link and one undescribed image; a second pass changes nothing", () => {
    const doc = '# Mixed\n\nSee [docs]() and ![](pic.png "A title") here.\n';
    const violations = lintDocument(doc, { rules });
    expect(violations.map((violation) => violation.ruleId).sort()).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);

    const once = applyAllFixes(doc, violations);
    expect(once).toBe(
      '# Mixed\n\nSee [docs](TODO) and ![TODO: describe image](pic.png "A title") here.\n',
    );
    expect(lintDocument(once, { rules })).toEqual([]);
    expect(fixPass(once)).toBe(once);
  });
});

describe("autofix: bracketed number [1] beside an undescribed image", () => {
  it.each([
    [
      "list item",
      "- Claim [1] ![](a.png) end [1]\n",
      "- Claim [1] ![TODO: describe image](a.png) end [1]\n",
    ],
    [
      "blockquote",
      "> Claim [1] ![](a.png) [1]\n",
      "> Claim [1] ![TODO: describe image](a.png) [1]\n",
    ],
    [
      "touching on both sides",
      "x[1]![](a.png)[1]y\n",
      "x[1]![TODO: describe image](a.png)[1]y\n",
    ],
    [
      "CRLF paragraph",
      "Claim [1]\r\n![](a.png) [1]\r\n",
      "Claim [1]\r\n![TODO: describe image](a.png) [1]\r\n",
    ],
  ])("repairs the image and keeps every [1] verbatim (%s)", (_name, doc, expected) => {
    const rules = [ruleMissingAltText];
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual(["missing-alt-text"]);
    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    expect(fixed.match(/\[1\]/g)).toHaveLength(doc.match(/\[1\]/g)!.length);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});
