/**
 * diff.test.ts — vitest unit tests for parseDiffHunks / countHunks / applyHunkToContent.
 */
import { describe, expect, it } from "vitest";
import { applyHunkToContent, countHunks, parseDiffHunks } from "./diff";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SINGLE_HUNK = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,5 @@
 import { bar } from "./bar";
-const x = 1;
+const x = 2;
 export { x };
`;

const MULTI_HUNK = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,4 @@
 import { bar } from "./bar";
-const x = 1;
+const x = 2;
 export { x };
@@ -10,4 +10,4 @@
 // second section
-const y = "old";
+const y = "new";
 export { y };
`;

const HEADERLESS = `@@ -1,3 +1,3 @@
 line one
-line two old
+line two new
 line three
`;

const ADD_ONLY = `--- a/readme.md
+++ b/readme.md
@@ -1,2 +1,3 @@
 # Title
+New paragraph.
 Existing text.
`;

const REMOVE_ONLY = `--- a/readme.md
+++ b/readme.md
@@ -1,3 +1,2 @@
 # Title
-Removed line.
 Existing text.
`;

const CRLF_HUNK = `--- a/file.txt\r\n+++ b/file.txt\r\n@@ -1,3 +1,3 @@\r\n line a\r\n-line b\r\n+line b new\r\n line c\r\n`;

const NO_NEWLINE = `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
-old line
\\ No newline at end of file
+new line
\\ No newline at end of file
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseDiffHunks", () => {
  it("parses a single hunk with target file", () => {
    const hunks = parseDiffHunks(SINGLE_HUNK);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].targetFile).toBe("src/foo.ts");
    expect(hunks[0].header).toMatch(/^@@/);
  });

  it("single hunk find/replace correctness", () => {
    const [hunk] = parseDiffHunks(SINGLE_HUNK);
    // find = context-before + removed + context-after
    expect(hunk.find).toContain('import { bar } from "./bar"');
    expect(hunk.find).toContain("const x = 1;");
    expect(hunk.find).toContain("export { x }");
    expect(hunk.find).not.toContain("const x = 2;");
    // replace = context-before + added + context-after
    expect(hunk.replace).toContain('import { bar } from "./bar"');
    expect(hunk.replace).toContain("const x = 2;");
    expect(hunk.replace).toContain("export { x }");
    expect(hunk.replace).not.toContain("const x = 1;");
  });

  it("parses multiple hunks from the same file", () => {
    const hunks = parseDiffHunks(MULTI_HUNK);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].targetFile).toBe("src/foo.ts");
    expect(hunks[1].targetFile).toBe("src/foo.ts");
    expect(hunks[0].find).toContain("const x = 1;");
    expect(hunks[1].find).toContain('const y = "old"');
    expect(hunks[0].replace).toContain("const x = 2;");
    expect(hunks[1].replace).toContain('const y = "new"');
  });

  it("headerless diff yields targetFile null", () => {
    const hunks = parseDiffHunks(HEADERLESS);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].targetFile).toBeNull();
  });

  it("headerless find/replace is correct", () => {
    const [hunk] = parseDiffHunks(HEADERLESS);
    expect(hunk.find).toContain("line one");
    expect(hunk.find).toContain("line two old");
    expect(hunk.find).toContain("line three");
    expect(hunk.replace).toContain("line two new");
    expect(hunk.replace).not.toContain("line two old");
  });

  it("add-only hunk: find has no added line, replace has it", () => {
    const [hunk] = parseDiffHunks(ADD_ONLY);
    expect(hunk.find).not.toContain("New paragraph.");
    expect(hunk.replace).toContain("New paragraph.");
    // Context lines present in both.
    expect(hunk.find).toContain("# Title");
    expect(hunk.replace).toContain("# Title");
  });

  it("remove-only hunk: find has removed line, replace does not", () => {
    const [hunk] = parseDiffHunks(REMOVE_ONLY);
    expect(hunk.find).toContain("Removed line.");
    expect(hunk.replace).not.toContain("Removed line.");
    expect(hunk.find).toContain("# Title");
    expect(hunk.replace).toContain("# Title");
  });

  it("handles CRLF line endings by normalizing to LF", () => {
    const hunks = parseDiffHunks(CRLF_HUNK);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].find).toContain("line b");
    expect(hunks[0].replace).toContain("line b new");
    // Should not contain bare CR.
    expect(hunks[0].find).not.toContain("\r");
    expect(hunks[0].replace).not.toContain("\r");
  });

  it("ignores \\ No newline at end of file markers", () => {
    const hunks = parseDiffHunks(NO_NEWLINE);
    expect(hunks).toHaveLength(1);
    // The no-newline marker must not appear in find/replace.
    expect(hunks[0].find).not.toContain("\\ No");
    expect(hunks[0].replace).not.toContain("\\ No");
    expect(hunks[0].find).toContain("old line");
    expect(hunks[0].replace).toContain("new line");
  });

  it("returns empty array for empty input", () => {
    expect(parseDiffHunks("")).toHaveLength(0);
  });

  it("returns empty array for non-diff text", () => {
    expect(parseDiffHunks("Hello world\nNo diff here")).toHaveLength(0);
  });

  it("preserves the @@ header line verbatim", () => {
    const [hunk] = parseDiffHunks(SINGLE_HUNK);
    expect(hunk.header).toBe("@@ -1,5 +1,5 @@");
  });

  it("apply round-trip: replacing find with replace in source restores new content", () => {
    const original = `import { bar } from "./bar";\nconst x = 1;\nexport { x };`;
    const expected = `import { bar } from "./bar";\nconst x = 2;\nexport { x };`;
    const [hunk] = parseDiffHunks(SINGLE_HUNK);
    const result = original.replace(hunk.find, hunk.replace);
    expect(result).toBe(expected);
  });
});

describe("countHunks", () => {
  it("counts single hunk", () => {
    expect(countHunks(SINGLE_HUNK)).toBe(1);
  });

  it("counts multiple hunks", () => {
    expect(countHunks(MULTI_HUNK)).toBe(2);
  });

  it("returns 0 for empty string", () => {
    expect(countHunks("")).toBe(0);
  });

  it("returns 0 for non-diff text", () => {
    expect(countHunks("no hunks here")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Additional edge-case fixtures
// ---------------------------------------------------------------------------

const EMPTY_LINES_IN_CONTEXT = `--- a/file.txt
+++ b/file.txt
@@ -1,5 +1,5 @@
 first line

-old middle
+new middle

 last line
`;

const MULTI_FILE = `diff --git a/alpha.ts b/alpha.ts
--- a/alpha.ts
+++ b/alpha.ts
@@ -1,3 +1,3 @@
 aaa
-bbb
+BBB
 ccc
diff --git a/beta.ts b/beta.ts
--- a/beta.ts
+++ b/beta.ts
@@ -1,3 +1,3 @@
 xxx
-yyy
+YYY
 zzz
`;

const BINARY_MARKER = `diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

const UNICODE_DIFF = `--- a/unicode.md
+++ b/unicode.md
@@ -1,3 +1,3 @@
 # Héllo wörld
-Ünïcödé línë
+Ünïcödé LÍNÉ
 末尾
`;

const LONG_LINE_DIFF = `--- a/long.ts
+++ b/long.ts
@@ -1,3 +1,3 @@
 ${" ".padEnd(10, "a")}
-${"x".repeat(600)}
+${"y".repeat(600)}
 ${" ".padEnd(10, "z")}
`;

const HUNK_AT_LINE_ONE = `--- a/start.ts
+++ b/start.ts
@@ -1,2 +1,2 @@
-first line
+FIRST LINE
 second line
`;

const HUNK_AT_END = `--- a/end.ts
+++ b/end.ts
@@ -9,2 +9,2 @@
 penultimate line
-last line
+LAST LINE
`;

const DEV_NULL_SRC = `--- /dev/null
+++ b/newfile.ts
@@ -0,0 +1,2 @@
+line one
+line two
`;

// ---------------------------------------------------------------------------
// Additional parseDiffHunks tests
// ---------------------------------------------------------------------------

describe("parseDiffHunks — edge cases", () => {
  it("preserves empty context lines inside a hunk", () => {
    const hunks = parseDiffHunks(EMPTY_LINES_IN_CONTEXT);
    expect(hunks).toHaveLength(1);
    // The empty line between "first line" and "old middle" must appear in find.
    expect(hunks[0].find).toContain("old middle");
    expect(hunks[0].replace).toContain("new middle");
  });

  it("parses a multi-file diff into separate hunks with correct targetFiles", () => {
    const hunks = parseDiffHunks(MULTI_FILE);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].targetFile).toBe("alpha.ts");
    expect(hunks[1].targetFile).toBe("beta.ts");
    expect(hunks[0].find).toContain("bbb");
    expect(hunks[1].find).toContain("yyy");
  });

  it("gracefully handles binary-file markers (returns empty array)", () => {
    const hunks = parseDiffHunks(BINARY_MARKER);
    expect(hunks).toHaveLength(0);
  });

  it("handles unicode content correctly in find/replace", () => {
    const hunks = parseDiffHunks(UNICODE_DIFF);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].find).toContain("Ünïcödé línë");
    expect(hunks[0].replace).toContain("Ünïcödé LÍNÉ");
    expect(hunks[0].find).toContain("末尾");
    expect(hunks[0].replace).toContain("末尾");
  });

  it("handles very long lines (>500 chars) without truncation", () => {
    const hunks = parseDiffHunks(LONG_LINE_DIFF);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].find).toContain("x".repeat(600));
    expect(hunks[0].replace).toContain("y".repeat(600));
  });

  it("hunk at start of file (line 1) parses correctly", () => {
    const hunks = parseDiffHunks(HUNK_AT_LINE_ONE);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].find).toContain("first line");
    expect(hunks[0].replace).toContain("FIRST LINE");
    expect(hunks[0].targetFile).toBe("start.ts");
  });

  it("hunk at end of file parses correctly", () => {
    const hunks = parseDiffHunks(HUNK_AT_END);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].find).toContain("last line");
    expect(hunks[0].replace).toContain("LAST LINE");
  });

  it("--- /dev/null maps targetFile from +++ b/... line", () => {
    const hunks = parseDiffHunks(DEV_NULL_SRC);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].targetFile).toBe("newfile.ts");
    // find is empty (pure addition); replace has both new lines
    expect(hunks[0].replace).toContain("line one");
    expect(hunks[0].replace).toContain("line two");
  });

  it("header line includes optional trailing context text after @@", () => {
    const diff = `--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,3 @@ function hello() {
 ctx
-old
+new
 ctx
`;
    const [hunk] = parseDiffHunks(diff);
    expect(hunk.header).toBe("@@ -1,3 +1,3 @@ function hello() {");
  });

  it("mixed +/- sequence: interleaved adds and removes in one hunk", () => {
    const diff = `--- a/mix.ts
+++ b/mix.ts
@@ -1,4 +1,4 @@
 ctx
-rem1
+add1
-rem2
+add2
`;
    const hunks = parseDiffHunks(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].find).toContain("rem1");
    expect(hunks[0].find).toContain("rem2");
    expect(hunks[0].replace).toContain("add1");
    expect(hunks[0].replace).toContain("add2");
    expect(hunks[0].find).not.toContain("add1");
    expect(hunks[0].replace).not.toContain("rem1");
  });
});

// ---------------------------------------------------------------------------
// applyHunkToContent tests
// ---------------------------------------------------------------------------

describe("applyHunkToContent", () => {
  it("applies a hunk successfully when anchor is found exactly once", () => {
    const content = `import { bar } from "./bar";\nconst x = 1;\nexport { x };`;
    const [hunk] = parseDiffHunks(SINGLE_HUNK);
    const result = applyHunkToContent(content, hunk);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newContent).toContain("const x = 2;");
      expect(result.newContent).not.toContain("const x = 1;");
    }
  });

  it("returns error when anchor is not found", () => {
    const content = "completely unrelated content";
    const [hunk] = parseDiffHunks(SINGLE_HUNK);
    const result = applyHunkToContent(content, hunk);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  it("returns error when anchor is ambiguous (appears more than once)", () => {
    const content = `import { bar } from "./bar";\nconst x = 1;\nexport { x };\nimport { bar } from "./bar";\nconst x = 1;\nexport { x };`;
    const [hunk] = parseDiffHunks(SINGLE_HUNK);
    const result = applyHunkToContent(content, hunk);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ambiguous/i);
    }
  });

  it("treats a no-op hunk (find === replace) as successful", () => {
    // An add-only diff produces a find with no removed lines.
    // Manually craft a no-op to directly test the branch.
    const [hunk] = parseDiffHunks(SINGLE_HUNK);
    const noopHunk = { ...hunk, replace: hunk.find };
    const content = "some content";
    const result = applyHunkToContent(content, noopHunk);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newContent).toBe(content);
    }
  });

  it("apply round-trip for remove-only hunk", () => {
    const original = `# Title\nRemoved line.\nExisting text.`;
    const expected = `# Title\nExisting text.`;
    const [hunk] = parseDiffHunks(REMOVE_ONLY);
    const result = applyHunkToContent(original, hunk);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newContent).toBe(expected);
    }
  });

  it("apply round-trip for add-only hunk", () => {
    const original = `# Title\nExisting text.`;
    const [hunk] = parseDiffHunks(ADD_ONLY);
    const result = applyHunkToContent(original, hunk);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newContent).toContain("New paragraph.");
    }
  });
});
