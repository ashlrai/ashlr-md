/**
 * export-regex-q8.test.ts — coverage for RQ-MDPROMQ8.
 * export.ts's attribute scanner walked a tag's attributes through matchAll
 * with the "gy" flags; the sticky flag shadowed the global flag's
 * skip-ahead, so a broken attribute would have ended the scan. It now
 * carries "g" alone; the last suite guards that fix and the void-marked
 * fire-and-forget promises against regression.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildExportHtml,
  languageTag,
  sanitizeFileName,
  withExtension,
} from "../export";

describe("email-html attribute scanning, without the shadowed sticky flag", () => {
  it("matches a run of attributes regardless of tag/attribute letter case", () => {
    const html = buildExportHtml("email-html", '<A HREF="https://example.com">l</A>');
    // The opening tag is rewritten lower-case; attribute names stay as written.
    expect(html.match(/<a\b[^>]*>/)?.[0]).toBe(
      '<a style="color:#0066cc;text-decoration:underline;" HREF="https://example.com">',
    );
  });

  it("walks every attribute, keeps them in order, skips attribute-less ones", () => {
    const html = buildExportHtml(
      "email-html",
      '<table class="mine" summary="keep" data-x="1"><tr><td>x</td></tr></table><a>l</a>',
    );
    expect(html).toContain(
      '<table cellpadding="0" cellspacing="0" class="content-table mine" summary="keep" data-x="1">',
    );
    expect(html).toContain("<a>l</a>"); // withAttributes gate: no style added
  });
});

describe("regex-only pure helpers", () => {
  it("languageTag accepts BCP 47, reads underscores as hyphens, rejects prose", () => {
    expect(languageTag("en_US")).toBe("en-US");
    expect(languageTag(" zh-Hant-TW ")).toBe("zh-Hant-TW");
    for (const v of ["hello world", "  ", "e".repeat(36), null, undefined])
      expect(languageTag(v)).toBeNull();
  });

  it("sanitizeFileName handles reserved names and edge characters", () => {
    expect(sanitizeFileName("CON")).toBe("CON-export");
    expect(sanitizeFileName("a b/c\\d:e*f?")).toBe("a-bcdef");
    expect(sanitizeFileName(".env")).toBe("env");
    expect(sanitizeFileName("name.")).toBe("name");
    expect(sanitizeFileName("")).toBe("export");
  });

  // export.test.ts already pins the emoji half-character and reserved-name shapes.
  it("withExtension appends only when the file name has no extension", () => {
    expect(withExtension("/tmp/report", "html")).toBe("/tmp/report.html");
    expect(withExtension("/tmp/report.md", "html")).toBe("/tmp/report.md");
    expect(withExtension("/tmp/.keep", "html")).toBe("/tmp/.keep.html");
  });
});

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

describe("source guards", () => {
  it("export.ts carries no sticky flag on any regex", () => {
    const file = src("src/lib/export.ts");
    expect(file).not.toContain('"gy"');
    expect(file).not.toMatch(/new RegExp\([^)]*"[^"]*y[^"]*"/);
  });

  it.each([
    [
      "src/App.tsx",
      ["void checkForUpdates()", "void watchWikilinkChanges()", "void openPath("],
    ],
    ["src/components/viewer/WikiEmbed.tsx", ["void (async () =>"]],
    [
      "src/components/viewer/Wikilink.tsx",
      ["void resolveWikilink(", "void useDocumentStore"],
    ],
  ])("fire-and-forget promises stay void-marked: %s", (rel, needles) => {
    const file = src(rel);
    for (const needle of needles) {
      expect(file.includes(needle), `${rel} → ${needle}`).toBe(true);
    }
  });
});
