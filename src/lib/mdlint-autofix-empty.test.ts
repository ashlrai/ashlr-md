import { describe, expect, it } from "vitest";
import { fixAllViolations } from "../components/LinterToast";
import {
  applyAllFixes,
  BUILTIN_RULES,
  LINTER_DEFAULT_ENABLED_RULES,
  lintDocument,
  ruleFrontmatterRequired,
  ruleNoTrailingSpaces,
} from "./mdlint";

describe("autofixing empty documents", () => {
  const defaultRules = BUILTIN_RULES.filter((rule) =>
    LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
  );

  it.each([
    "",
    " ",
    "   ",
    "\t \t",
    "\n",
    "   \n \t\n\n",
    "\r\n   \r\n\t\r\n",
    "\u00a0\u2003\n   ",
  ])("preserves %j through lint and repeated autofix passes", (doc) => {
    for (const rules of [BUILTIN_RULES, defaultRules]) {
      const violations = lintDocument(doc, { rules });
      expect(violations).toEqual([]);
      const fixed = applyAllFixes(doc, violations);
      expect(fixed).toBe(doc);
      expect(fixAllViolations(doc, violations)).toBe(doc);
      expect(applyAllFixes(fixed, lintDocument(fixed, { rules }))).toBe(doc);
    }
  });

  it("still fixes trailing spaces and missing frontmatter in nonempty documents", () => {
    const doc = "Content   \n";
    const violations = lintDocument(doc, {
      rules: [ruleFrontmatterRequired, ruleNoTrailingSpaces],
    });
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "no-trailing-spaces",
      "frontmatter-required",
    ]);
    expect(applyAllFixes(doc, violations)).toBe(
      "---\ntitle: \ntags: []\n---\n\nContent\n",
    );
  });
});
