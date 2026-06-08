/**
 * diff.test.ts — vitest unit tests for parseDiffHunks / countHunks.
 */
import { describe, expect, it } from "vitest";
import { countHunks, parseDiffHunks } from "./diff";

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
