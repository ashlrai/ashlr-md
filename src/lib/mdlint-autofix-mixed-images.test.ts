import { describe, expect, it } from "vitest";
import { applyAllFixes, applyFix, lintDocument, ruleMissingAltText } from "./mdlint";

describe("autofix mixed image descriptions", () => {
  it.each([
    ["\n", "", true],
    ["\n", "", false],
    ["\n", " \t ", true],
    ["\n", " \t ", false],
    ["\r\n", "", true],
    ["\r\n", "", false],
    ["\r\n", " \t ", true],
    ["\r\n", " \t ", false],
  ])("preserves the described image with newline %j, missing alt %j, described first %s", (newline, alt, describedFirst) => {
    const source = 'images/caf%C3%A9.png?size=2#preview "Café"';
    const described = `![A café at sunset](${source})`;
    const undescribed = `![${alt}](${source})`;
    const repaired = `![TODO: describe image](${source})`;
    const before = describedFirst ? described : undescribed;
    const after = describedFirst ? undescribed : described;
    const doc = `Intro ☕${newline}Before ${before} and ${after} after.${newline}End.`;
    const expected = `Intro ☕${newline}Before ${describedFirst ? described : repaired} and ${describedFirst ? repaired : described} after.${newline}End.`;
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
    const remaining = lintDocument(fixed, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(fixed, remaining)).toBe(expected);
  });
});
