import { describe, expect, it } from "vitest";
import {
  applyAllFixes,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
  ruleNoBareUrls,
} from "./mdlint";

describe("link and image autofix idempotence", () => {
  it.each(["\n", "\r\n"])("fixes bare URLs once with line ending %j", (newline) => {
    const rules = [ruleNoBareUrls];
    const doc = [
      "Café: https://example.com/a?x=1#part and http://example.org/path",
      "Keep [linked](https://example.com) and `https://example.net`.",
    ].join(newline);
    const expected = [
      "Café: [https://example.com/a?x=1#part](https://example.com/a?x=1#part) and [http://example.org/path](http://example.org/path)",
      "Keep [linked](https://example.com) and `https://example.net`.",
    ].join(newline);
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const once = applyAllFixes(doc, violations);
    expect(once).toBe(expected);
    const remaining = lintDocument(once, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(once, remaining)).toBe(once);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes invalid link targets once with line ending %j", (newline) => {
    const rules = [ruleInvalidLinkTarget];
    const doc = [
      "Café [empty]() [space]( \t ) [hash](#) [query](?)",
      "Keep [valid](./guide.md#part) and `[code]()`.",
    ].join(newline);
    const expected = [
      "Café [empty](TODO) [space](TODO) [hash](TODO) [query](TODO)",
      "Keep [valid](./guide.md#part) and `[code]()`.",
    ].join(newline);
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(4);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const once = applyAllFixes(doc, violations);
    expect(once).toBe(expected);
    const remaining = lintDocument(once, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(once, remaining)).toBe(once);
  });

  it.each([
    "\n",
    "\r\n",
  ])("fixes missing image alt text once with line ending %j", (newline) => {
    const rules = [ruleMissingAltText];
    const doc = [
      "Café ![](images/a.png?size=2#preview) ![ \t ](../b.svg)",
      "Keep ![A chart](chart.png) and `![](code.png)`.",
    ].join(newline);
    const expected = [
      "Café ![TODO: describe image](images/a.png?size=2#preview) ![TODO: describe image](../b.svg)",
      "Keep ![A chart](chart.png) and `![](code.png)`.",
    ].join(newline);
    const violations = lintDocument(doc, { rules });

    expect(violations).toHaveLength(2);
    expect(violations.every((violation) => violation.fix !== null)).toBe(true);
    const once = applyAllFixes(doc, violations);
    expect(once).toBe(expected);
    const remaining = lintDocument(once, { rules });
    expect(remaining).toEqual([]);
    expect(applyAllFixes(once, remaining)).toBe(once);
  });
});
