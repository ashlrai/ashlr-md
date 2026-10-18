// No em or en dashes in user-facing strings: toasts, labels, tooltips,
// dialogs, placeholders, aria-labels, menu hints and error messages the UI
// shows. The rule is the repo's (see CONTRIBUTING.md). This test parses every
// non-test TS/TSX file under src/ and checks its string literals, template
// text and JSX text for U+2014 and U+2013. Comments are not tokens here, so
// they are not checked. Regular expression sources (`new RegExp(...)`
// arguments and `String.raw` templates) match dashes as document content and
// are skipped, as are CSS comments inside a stylesheet string, which no one
// sees. The app's package descriptions (shown in app metadata) are checked
// too, and so are the shell page (index.html: the window title before the
// app loads), the landing page (landing/index.html: its title, meta and
// social descriptions and body copy, HTML comments aside), the top-level
// Markdown docs (README, CONTRIBUTING, ROADMAP, SECURITY, AGENTS; not the
// historical CHANGELOG), the Markdown under docs/ and integrations/ (the
// install, Obsidian, release, vision and agent guides and the plugin and
// extension READMEs; again not a CHANGELOG), the sample documents under
// samples/ (what a new user opens first), every string in
// the Tauri configs (window titles, bundle descriptions, file association
// names) and the string literals of the Rust
// crates (dialog, menu, tray and notification text, and the errors the
// window reports). Rust comments and `#[cfg(test)]` modules are not
// checked; a pattern that must match a dash in document content writes it as
// the escape `\u{2014}`.

import ts from "typescript";
import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import landingHtml from "../landing/index.html?raw";
import mdopenCargo from "../src-tauri/bins/mdopen/Cargo.toml?raw";
import mcpCargo from "../src-tauri/bins/mdopener-mcp/Cargo.toml?raw";
import appCargo from "../src-tauri/Cargo.toml?raw";

// Top-level docs an agent or contributor reads first. CHANGELOG.md keeps its
// historical entries as written, so it is not checked.
const topDocs = import.meta.glob<string>(["../*.md", "!../CHANGELOG.md"], {
  query: "?raw",
  import: "default",
  eager: true,
});

// The guides under docs/, the editor integrations' READMEs and the sample
// documents. A changelog there keeps its history as written too.
const nestedDocs = import.meta.glob<string>(
  [
    "../docs/**/*.md",
    "../integrations/**/*.md",
    "../samples/*.md",
    "!../**/CHANGELOG.md",
    "!../**/node_modules/**",
  ],
  { query: "?raw", import: "default", eager: true },
);

const DASH = /[–—]/;
const DASH_ENTITY = /&(?:[mn]dash|#821[12]|#x201[34]);/i;

/** "file:line: text" for each line of a Markdown doc with a dash or entity. */
function dashedDocLines(docs: Record<string, string>): string[] {
  return Object.entries(docs).flatMap(([file, src]) =>
    src
      .split("\n")
      .map((l, k) => [k + 1, l] as const)
      .filter(([, l]) => DASH.test(l) || DASH_ENTITY.test(l))
      .map(([k, l]) => `${file.slice(3)}:${k}: ${l.trim().slice(0, 120)}`),
  );
}

const sources = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./test-setup.ts"],
  { query: "?raw", import: "default", eager: true },
);

const tauriConfigs = import.meta.glob<string>("../src-tauri/tauri*.conf.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

const rustSources = import.meta.glob<string>(
  [
    "../src-tauri/src/**/*.rs",
    "../src-tauri/bins/*/src/**/*.rs",
    "../src-tauri/build.rs",
  ],
  { query: "?raw", import: "default", eager: true },
);

/**
 * "file:line: text" for each string literal in Rust source `src` with a
 * dash, outside comments and `#[cfg(test)]` modules. A small lexer: line and
 * nested block comments, plain, byte and raw strings (`r#"..."#`), and char
 * literals, told apart from lifetimes. Escapes are kept as written, so
 * `\u{2014}` is not a dash here.
 */
function rustDashedStrings(file: string, src: string): string[] {
  const found: string[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  // Brace depth, and the depth a `#[cfg(test)]` module's body opened at.
  let depth = 0;
  let testDepth: number | null = null;
  let testPending = false;
  const step = (k: number): void => {
    for (let j = 0; j < k && i < n; j++) {
      if (src[i] === "\n") line++;
      i++;
    }
  };
  const isIdent = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_]/.test(c);
  const literal = (text: string, at: number): void => {
    if (testDepth === null && DASH.test(text)) {
      found.push(`${file}:${at}: ${JSON.stringify(text.trim()).slice(0, 120)}`);
    }
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      let nest = 0;
      do {
        if (src[i] === "/" && src[i + 1] === "*") {
          nest++;
          step(2);
        } else if (src[i] === "*" && src[i + 1] === "/") {
          nest--;
          step(2);
        } else step(1);
      } while (i < n && nest > 0);
      continue;
    }
    const raw = isIdent(src[i - 1]) ? null : /^b?r(#*)"/.exec(src.slice(i, i + 40));
    if (raw) {
      const at = line;
      step(raw[0].length);
      const close = `"${raw[1]}`;
      const end = src.indexOf(close, i);
      const stop = end < 0 ? n : end;
      literal(src.slice(i, stop), at);
      step(stop + close.length - i);
      continue;
    }
    if (c === '"' || (c === "b" && d === '"' && !isIdent(src[i - 1]))) {
      const at = line;
      step(c === "b" ? 2 : 1);
      let text = "";
      while (i < n && src[i] !== '"') {
        const k = src[i] === "\\" ? 2 : 1;
        text += src.slice(i, i + k);
        step(k);
      }
      step(1);
      literal(text, at);
      continue;
    }
    if (c === "'") {
      const ch = /^'(\\(?:u\{[0-9A-Fa-f]+\}|x[0-9A-Fa-f]{2}|.)|[^\\'\n])'/u.exec(
        src.slice(i, i + 16),
      );
      if (ch) {
        literal(ch[1], line);
        step(ch[0].length);
        continue;
      }
    }
    if (src.startsWith("#[cfg(test)]", i)) {
      testPending = true;
      step(12);
      continue;
    }
    if (c === "{") {
      depth++;
      if (testPending && testDepth === null) testDepth = depth;
      testPending = false;
    } else if (c === "}") {
      if (testDepth === depth) testDepth = null;
      depth--;
    } else if (c === ";") {
      // `#[cfg(test)] use ...;` or `mod tests;` is not a body.
      testPending = false;
    }
    step(1);
  }
  return found;
}

/** Every string value in a parsed JSON document, with its JSON path. */
function jsonStrings(v: unknown, at = "$"): [string, string][] {
  if (typeof v === "string") return [[at, v]];
  if (Array.isArray(v)) return v.flatMap((x, k) => jsonStrings(x, `${at}[${k}]`));
  if (v && typeof v === "object") {
    return Object.entries(v).flatMap(([k, x]) => jsonStrings(x, `${at}.${k}`));
  }
  return [];
}

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

  it("the shell page has none", () => {
    const text = indexHtml.replace(/<!--[\s\S]*?-->/g, "");
    expect(text).toContain("<title>Ashlr MD</title>");
    expect(text).not.toMatch(DASH);
  });

  it("the landing page has none, as characters or entities", () => {
    // A comment keeps its newlines so the reported line numbers hold.
    const text = landingHtml.replace(/<!--[\s\S]*?-->/g, (c) =>
      c.replace(/[^\n]/g, ""),
    );
    expect(text).toContain("<title>Ashlr MD: Markdown, finally beautiful</title>");
    const found = text
      .split("\n")
      .map((l, k) => [k + 1, l] as const)
      .filter(([, l]) => DASH.test(l) || DASH_ENTITY.test(l))
      .map(([k, l]) => `landing/index.html:${k}: ${l.trim().slice(0, 120)}`);
    expect(found).toEqual([]);
  });

  it("the top-level docs have none, as characters or entities", () => {
    const files = Object.keys(topDocs);
    for (const f of [
      "README.md",
      "CONTRIBUTING.md",
      "ROADMAP.md",
      "SECURITY.md",
      "AGENTS.md",
    ]) {
      expect(files).toContain(`../${f}`);
    }
    expect(files).not.toContain("../CHANGELOG.md");
    expect(dashedDocLines(topDocs)).toEqual([]);
  });

  it("the docs/ guides, integration READMEs and samples have none, as characters or entities", () => {
    const files = Object.keys(nestedDocs);
    for (const f of [
      "docs/AGENTS.md",
      "docs/INSTALL.md",
      "docs/OBSIDIAN.md",
      "docs/RELEASING.md",
      "docs/VISION.md",
      "integrations/obsidian/README.md",
      "integrations/vscode/README.md",
      "samples/agent-plan.md",
      "samples/showcase.md",
    ]) {
      expect(files).toContain(`../${f}`);
    }
    expect(files).not.toContain("../integrations/vscode/CHANGELOG.md");
    expect(dashedDocLines(nestedDocs)).toEqual([]);
  });

  it("strings in the Tauri configs have none", () => {
    expect(Object.keys(tauriConfigs)).toContain("../src-tauri/tauri.conf.json");
    const found = Object.entries(tauriConfigs).flatMap(([file, src]) =>
      jsonStrings(JSON.parse(src))
        .filter(([, v]) => DASH.test(v))
        .map(([at, v]) => `${file} ${at}: ${v}`),
    );
    expect(found).toEqual([]);
  });

  it("Rust string literals in the app and its binaries have none", () => {
    expect(Object.keys(rustSources)).toContain("../src-tauri/src/lib.rs");
    expect(Object.keys(rustSources)).toContain("../src-tauri/bins/mdopen/src/main.rs");
    const found = Object.entries(rustSources).flatMap(([file, src]) =>
      rustDashedStrings(file, src),
    );
    expect(found).toEqual([]);
  });

  it("the Rust checker flags literals but not comments, escapes or tests", () => {
    const src = [
      "// a comment \u2014 fine",
      "/* block /* nested \u2014 */ fine \u2014 */",
      "fn f<'a>(x: &'a str) -> char { '\u2014' }",
      'const OK: &str = "\\u{2014} escaped";',
      'fn g() { dialog.title("Save \u2014 failed"); }',
      'const R: &str = r#"raw \u2013 "quoted" text"#;',
      "#[cfg(test)]",
      "mod tests {",
      '    fn t() { let s = "fixture \u2014 ok"; { let _ = "\u2014"; } }',
      "}",
      'fn h() -> String { format!("after the tests \u2014 {}", 1) }',
    ].join("\n");
    const found = rustDashedStrings("sample.rs", src);
    expect(found.map((f) => f.split(":")[1])).toEqual(["3", "5", "6", "11"]);
  });
});
