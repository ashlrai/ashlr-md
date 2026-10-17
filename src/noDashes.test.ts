// No em or en dashes in user-facing strings: toasts, labels, tooltips,
// dialogs, placeholders, aria-labels, menu hints and error messages the UI
// shows. The rule is the repo's (see CONTRIBUTING.md). This test parses every
// non-test TS/TSX file under src/ and checks its string literals, template
// text and JSX text for U+2014 and U+2013. Comments are not tokens here, so
// they are not checked. Regular expression sources (`new RegExp(...)`
// arguments and `String.raw` templates) match dashes as document content and
// are skipped, as are CSS comments inside a stylesheet string, which no one
// sees. The app's package descriptions (shown in app metadata) are checked
// too.

import ts from "typescript";
import { describe, expect, it } from "vitest";
import mdopenCargo from "../src-tauri/bins/mdopen/Cargo.toml?raw";
import mcpCargo from "../src-tauri/bins/mdopener-mcp/Cargo.toml?raw";
import appCargo from "../src-tauri/Cargo.toml?raw";

const DASH = /[–—]/;

const sources = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./test-setup.ts"],
  { query: "?raw", import: "default", eager: true },
);

/** True when `node` is (part of) a regular expression source. */
function inRegexSource(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isTaggedTemplateExpression(n) && n.tag.getText() === "String.raw") {
      return true;
    }
    if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "RegExp"
    ) {
      return true;
    }
  }
  return false;
}

/** "file:line: text" for each user-visible string in `src` with a dash. */
function dashedStrings(file: string, src: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      text = node.text.replace(/\/\*[\s\S]*?\*\//g, "");
    }
    if (text !== null && DASH.test(text) && !inRegexSource(node)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${file}:${line + 1}: ${JSON.stringify(text.trim()).slice(0, 120)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("no em or en dashes in user-facing strings", () => {
  it("finds the source files", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(Object.keys(sources)).toContain("./components/viewer/DiffBlock.tsx");
  });

  it("UI string literals, template text and JSX text have none", () => {
    const found = Object.entries(sources).flatMap(([file, src]) =>
      dashedStrings(file, src),
    );
    expect(found).toEqual([]);
  });

  it("the checker flags strings and JSX text but not comments or regexes", () => {
    const src = [
      "// a comment — fine",
      "/** doc – fine */",
      'const re = new RegExp("[:—]");',
      "const raw = String.raw`[–]`;",
      'const css = "/* — note */ body {}";',
      'toast.error("Patch not found — gone");',
      "const t = `lines \u0024{a}\u2013\u0024{b}`;",
      "const el = <p title={'x — y'}>Hi — there</p>;",
    ].join("\n");
    const found = dashedStrings("sample.tsx", src);
    expect(found.map((f) => f.split(":")[1])).toEqual(["6", "7", "8", "8"]);
  });

  it("package descriptions shown in app metadata have none", () => {
    for (const toml of [appCargo, mdopenCargo, mcpCargo]) {
      const line = toml.split("\n").find((l) => l.startsWith("description"));
      expect(line).toBeDefined();
      expect(line).not.toMatch(DASH);
    }
  });
});
