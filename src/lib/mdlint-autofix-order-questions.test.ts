import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const note = readFileSync("docs/mdlint-autofix-order-questions.md", "utf8");
const source = readFileSync("src/lib/mdlint-autofix.test.ts", "utf8");

describe("mixed-rule ordering questions", () => {
  it("references existing, uniquely named source tests in each case", () => {
    const cases = [...note.matchAll(/<!-- case: (.+?) -->\s*`([^`]+)`/g)];
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map(([, name]) => name)).size).toBe(cases.length);

    for (const [, name, label] of cases) {
      expect(label).toBe(name);
      expect(source.split(`"${name}"`).length - 1).toBe(1);
    }
  });
});
