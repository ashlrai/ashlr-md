import { describe, expect, it } from "vitest";
import { applyFix, lintDocument, ruleInvalidLinkTarget } from "./mdlint";

describe("invalid-link fixes after earlier edits shift identical links", () => {
  it.each([
    "\n",
    "\r\n",
  ])("repairs the nearest live occurrence before the recorded offset (%j)", (nl) => {
    const doc = [
      "`[同じ](#)` [wide](             ) then [同じ](#).",
      "Keep this separator and the later [同じ](#).",
      "",
    ].join(nl);
    const violations = lintDocument(doc, { rules: [ruleInvalidLinkTarget] });
    expect(violations).toHaveLength(3);
    const once = applyFix(doc, violations[0]);
    expect(once).toBe(doc.replace("[wide](             )", "[wide](TODO)"));
    const twice = applyFix(once, violations[1]);
    expect(twice).toBe(
      [
        "`[同じ](#)` [wide](TODO) then [同じ](TODO).",
        "Keep this separator and the later [同じ](#).",
        "",
      ].join(nl),
    );
    expect(applyFix(twice, violations[2])).toBe(
      twice.replace("later [同じ](#)", "later [同じ](TODO)"),
    );
  });
});
