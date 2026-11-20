import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  clearLintHistory,
  fixAllViolations,
  getLintHistory,
} from "../components/LinterToast";
import {
  applyAllFixes,
  applyFix,
  BUILTIN_RULES,
  LINTER_DEFAULT_ENABLED_RULES,
  lintDocument,
  ruleInvalidLinkTarget,
  ruleMissingAltText,
} from "./mdlint";

const guide = readFileSync("docs/mdlint-autofix-preservation.md", "utf8");

function example(name: string): string {
  const sections = guide.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("autofix preservation guide", () => {
  const singleRules = [ruleInvalidLinkTarget, ruleMissingAltText];

  it("fixes an empty link between words without changing the surrounding text", () => {
    const before = "Before [draft]() after.\n";
    const violations = lintDocument(before, { rules: singleRules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    const fixed = applyAllFixes(before, violations);
    expect(fixed).toBe("Before [draft](TODO) after.\n");
    expect(lintDocument(fixed, { rules: singleRules })).toEqual([]);
  });

  it.each([
    ["link", "invalid-link-target"],
    ["image", "missing-alt-text"],
  ])("shows the %s fix with surrounding prose intact", (name, ruleId) => {
    const before = example(`${name} before`);
    const after = example(`${name} after`);
    const violations = lintDocument(before, { rules: singleRules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([ruleId]);
    expect(violations[0].fix).not.toBeNull();
    expect(applyFix(before, violations[0])).toBe(after);
    expect(applyAllFixes(before, violations)).toBe(after);
    expect(lintDocument(after, { rules: singleRules })).toEqual([]);
  });

  it("shows a single link fix with only the link rule enabled", () => {
    const before = example("link before");
    const rules = [ruleInvalidLinkTarget];
    const violations = lintDocument(before, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "invalid-link-target",
    ]);
    const after = applyFix(before, violations[0]);
    expect(after).toBe(example("link after"));
    expect(lintDocument(after, { rules })).toEqual([]);
  });

  it("shows Fix all preserving both image sources", () => {
    clearLintHistory();
    const before = example("combined before");
    const expected = example("combined after");
    expect(before).toBe(
      "See ![A café map](images/map.svg?view=full#north) beside " +
        "![](images/chart.png?size=2#data), then [details]().\n",
    );
    expect(expected).toBe(
      "See ![A café map](images/map.svg?view=full#north) beside " +
        "![TODO: describe image](images/chart.png?size=2#data), then [details](TODO).\n",
    );
    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(before, { rules });

    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    const after = fixAllViolations(before, violations);
    expect(after).toBe(expected);
    const history = [...getLintHistory()];
    expect(history.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);

    // A second Fix all pass must leave both the text and the fix history alone.
    const remaining = lintDocument(after, { rules });
    expect(remaining).toEqual([]);
    expect(fixAllViolations(after, remaining)).toBe(after);
    expect(getLintHistory()).toEqual(history);
  });
});
