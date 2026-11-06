import { describe, it, expect } from "vitest";
import {
  applyFix,
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";


describe("autofix: invalid link and undescribed image on separate lines", () => {
  const LINK_LINE = "Read [the guide]() for details.";
  const IMAGE_LINE = 'See ![](images/chart.png?size=2#top "Chart") here.';
  const FIXED_LINK_LINE = "Read [the guide](TODO) for details.";
  const FIXED_IMAGE_LINE =
    'See ![TODO: describe image](images/chart.png?size=2#top "Chart") here.';
  const countOf = (text: string, needle: string) => text.split(needle).length - 1;

  it.each([
    ["LF around the link, CRLF around the image", "\n", "\r\n"],
    ["CRLF around the link, LF around the image", "\r\n", "\n"],
  ])("puts each fix on its original line and leaves every other line and line ending untouched (%s)", (_name, linkBreak, imageBreak) => {
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    const doc =
      `Intro: café keeps *its* prose.${linkBreak}` +
      `${LINK_LINE}${linkBreak}` +
      `Middle \`code\` and [ok](./ok.md) stay.${imageBreak}` +
      `${IMAGE_LINE}${imageBreak}` +
      `Tail:  spaced  text.${imageBreak}`;
    const expected =
      `Intro: café keeps *its* prose.${linkBreak}` +
      `${FIXED_LINK_LINE}${linkBreak}` +
      `Middle \`code\` and [ok](./ok.md) stay.${imageBreak}` +
      `${FIXED_IMAGE_LINE}${imageBreak}` +
      `Tail:  spaced  text.${imageBreak}`;

    const violations = lintDocument(doc, { rules });
    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    // The link sits on line 2 and the image on line 4.
    expect(violations.map((v) => v.range?.from.line)).toEqual([2, 4]);
    expect(
      doc.slice(violations[0].range!.from.offset, violations[0].range!.to.offset),
    ).toBe("[the guide]()");
    expect(
      doc.slice(violations[1].range!.from.offset, violations[1].range!.to.offset),
    ).toBe('![](images/chart.png?size=2#top "Chart")');

    // Each single fix repairs only its own violation's line.
    const linkOnly = applyFix(doc, violations[0]);
    expect(linkOnly.split(/\r\n|\n/)[1]).toBe(FIXED_LINK_LINE);
    expect(linkOnly).toContain(IMAGE_LINE);
    const imageOnly = applyFix(doc, violations[1]);
    expect(imageOnly.split(/\r\n|\n/)[3]).toBe(FIXED_IMAGE_LINE);
    expect(imageOnly).toContain(LINK_LINE);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(expected);
    // Same line count, same line endings, and every line but the two
    // violation lines byte-for-byte identical.
    const before = doc.split(/\r\n|\n/);
    const after = fixed.split(/\r\n|\n/);
    expect(after).toHaveLength(before.length);
    before.forEach((line, i) => {
      if (i !== 1 && i !== 3) expect(after[i]).toBe(line);
    });
    expect(after[1]).toBe(FIXED_LINK_LINE);
    expect(after[3]).toBe(FIXED_IMAGE_LINE);
    expect(countOf(fixed, "\r\n")).toBe(countOf(doc, "\r\n"));
    expect(countOf(fixed, "\n")).toBe(countOf(doc, "\n"));
    expect(lintDocument(fixed, { rules })).toEqual([]);
    expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(fixed);
  });

  it("fixes a first-line link and a last-line image and keeps the untouched middle lines", () => {
    const rules = [ruleInvalidLinkTarget, ruleMissingAltText];
    // No final newline: the image fix must not add one.
    const doc = "[broken]()\nplain middle — stays.\n![](pic.png)";
    const violations = lintDocument(doc, { rules });

    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "invalid-link-target",
      "missing-alt-text",
    ]);
    expect(violations.map((v) => v.range?.from.line)).toEqual([1, 3]);

    const fixed = applyAllFixes(doc, violations);
    expect(fixed).toBe(
      "[broken](TODO)\nplain middle — stays.\n![TODO: describe image](pic.png)",
    );
    const after = fixed.split("\n");
    expect(after).toHaveLength(3);
    expect(after[1]).toBe("plain middle — stays.");
    expect(fixed.endsWith("\n")).toBe(false);
    expect(lintDocument(fixed, { rules })).toEqual([]);
  });
});
