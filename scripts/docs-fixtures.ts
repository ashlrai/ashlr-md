import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const groups = [
  ["Link fixtures", "rule:invalid-link-target"],
  ["Image fixtures", "rule:missing-alt-text"],
  ["Mixed-rule fixtures", "chained violations and multi-line fixes"],
] as const;

export const formatMarker = "<!-- fixture-index-format: 1 -->";

/** Index direct test declarations; table rows do not change the declaration name. */
export function fixtureIndex(source: string): string {
  const file = ts.createSourceFile("fixtures.ts", source, ts.ScriptTarget.Latest, true);
  const sections = groups.map(([heading, name]) => {
    const block = file.statements.find((statement) =>
      ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) &&
      statement.expression.expression.getText(file) === "describe" &&
      statement.expression.arguments[0]?.getText(file) === JSON.stringify(name),
    );
    if (!block || !ts.isExpressionStatement(block) || !ts.isCallExpression(block.expression)) {
      throw new Error(`Missing describe block: ${name}`);
    }
    const callback = block.expression.arguments[1];
    if (!callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body)) {
      throw new Error(`Invalid describe block: ${name}`);
    }
    const names = callback.body.statements.flatMap((statement) => {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
      const call = statement.expression;
      const table = ts.isCallExpression(call.expression) && call.expression.expression.getText(file) === "it.each";
      if (!table && call.expression.getText(file) !== "it") return [];
      const title = call.arguments[0];
      if (!title || (!ts.isStringLiteral(title) && !ts.isNoSubstitutionTemplateLiteral(title))) {
        throw new Error(`Expected a literal test name in ${name}`);
      }
      return [`- ${table ? "[table] " : ""}${JSON.stringify(title.text)}`];
    });
    return `## ${heading} (${names.length})\n\n\`describe(${JSON.stringify(name)})\`\n\n\`\`\`text\n${names.join("\n")}\n\`\`\``;
  });
  return `# mdlint autofix fixture index\n\n${formatMarker}\n\nGenerated from [mdlint-autofix.test.ts](../src/lib/mdlint-autofix.test.ts).\nRun \`bun run docs:fixtures\` to refresh this lookup. Counts are test declarations;\n[table] declarations run once per row. Search the test file for a name.\n\n${sections.join("\n\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = readFileSync(new URL("../src/lib/mdlint-autofix.test.ts", import.meta.url), "utf8");
  writeFileSync(new URL("../docs/mdlint-autofix-fixture-index.md", import.meta.url), fixtureIndex(source));
}
