import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLintHistory,
  fixAllViolations,
  getLintHistory,
} from "../components/LinterToast";
import { BUILTIN_RULES, LINTER_DEFAULT_ENABLED_RULES, lintDocument } from "./mdlint";

const review = readFileSync("docs/mdlint-autofix-review-example.md", "utf8");

function example(name: string): string {
  const sections = review.split(`<!-- example: ${name} -->\n`);
  expect(sections).toHaveLength(2);
  const match = sections[1].match(/^```md\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("autofix review example", () => {
  beforeEach(() => clearLintHistory());

  it("reproduces the combined image and link Fix all case", () => {
    const input = example("input");
    const output = example("output");
    expect(input).toBe(
      "See ![A café map](images/map.svg?view=full#north) beside " +
        "![](images/chart.png?size=2#data), then [details]().\n",
    );
    expect(output).toBe(
      "See ![A café map](images/map.svg?view=full#north) beside " +
        "![TODO: describe image](images/chart.png?size=2#data), then [details](TODO).\n",
    );

    const rules = BUILTIN_RULES.filter((rule) =>
      LINTER_DEFAULT_ENABLED_RULES.includes(rule.id),
    );
    const violations = lintDocument(input, { rules });
    expect(violations.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    expect(fixAllViolations(input, violations)).toBe(output);
    const history = [...getLintHistory()];
    expect(history.map(({ ruleId }) => ruleId)).toEqual([
      "missing-alt-text",
      "invalid-link-target",
    ]);
    const remaining = lintDocument(output, { rules });
    expect(remaining).toEqual([]);
    expect(fixAllViolations(output, remaining)).toBe(output);
    expect(getLintHistory()).toEqual(history);
  });
});
