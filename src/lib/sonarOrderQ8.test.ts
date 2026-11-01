/**
 * sonarOrderQ8.test.ts — coverage for the RQ-MDSONAR7Q8 Sonar fixes.
 *
 *   S2871  `sort()`/`toSorted()` must carry a comparator —
 *          scripts/ci/validate-dispatch.mjs (allowlist label, hoisted and
 *          sorted once) and scripts/check-crypto.mjs (hit kinds).
 *   S9383  No floating promises: fire-and-forget calls are `void`-marked —
 *          src/mcp/bridge.ts, src/App.tsx, ActivityDrawer, MermaidBlock,
 *          RelatedNotes, CanvasViewer, DefaultHandlerBanner, EmbedSection,
 *          DefaultHandlerSection, AnthropicKeySection.
 *   S6351  A global-flag RegExp driving `exec()`/`test()` is stateful —
 *          export.ts's attributeValue iterates `matchAll` instead.
 *   S3923  Conditional branches must not be identical — diff.ts's context
 *          push and CodeBlock.tsx's output header collapsed.
 *
 * The source-guard suites re-read the touched files so a future regression
 * that reintroduces a flagged pattern fails CI even when Sonar is not
 * running.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan } from "../../scripts/check-crypto.mjs";
import { VALID_JOBS, validateJobs } from "../../scripts/ci/validate-dispatch.mjs";
import { parseDiffHunks } from "./diff";
import { buildExportHtml } from "./export";

// ─── S2871: scripts/ci/validate-dispatch.mjs ──────────────────────────────────

describe("validateJobs allowlist label (S2871)", () => {
  const sorted = [...VALID_JOBS].sort((a, b) => a.localeCompare(b)).join(", ");

  it("lists the jobs sorted when the input breaks the pattern", () => {
    const r = validateJobs("bogus job!");
    expect(r.ok).toBe(false);
    expect(r.error).toContain(sorted);
    expect(r.error).not.toContain([...VALID_JOBS].join(", "));
  });

  it("lists the jobs sorted when a job is unknown", () => {
    const r = validateJobs("fast,not-a-job");
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`Allowed: ${sorted}`);
  });
});

// ─── S2871: scripts/check-crypto.mjs ──────────────────────────────────────────

describe("check-crypto scan ordering (S2871)", () => {
  it("returns hits sorted by file with kinds sorted inside each hit", () => {
    const root = mkdtempSync(join(tmpdir(), "pqcheck-q8-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "z-multi.ts"), 'ed25519 ECDSA createSign("x")');
      writeFileSync(join(root, "src", "a-dh.ts"), 'generateKeyPairSync("x")');
      const hits = scan(root);
      expect(hits.map((h) => h.file)).toEqual(["src/a-dh.ts", "src/z-multi.ts"]);
      expect(hits[1].kinds).toEqual(["ECDSA/ECDH", "Ed25519/X25519", "RSA"]);
      for (const h of hits) {
        expect(h.kinds).toEqual([...h.kinds].sort((a, b) => a.localeCompare(b)));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── S6351: src/lib/export.ts attributeValue via the email-html profile ───────

describe("email-html attribute inlining (S6351)", () => {
  it("merges an existing style attribute in place, keeping other attributes", () => {
    const html = buildExportHtml(
      "email-html",
      '<p title="keep" style="color:red">hi</p>',
    );
    // The found attribute is replaced where it was: title stays in front,
    // the element's own style is appended to the email profile's rules.
    expect(html).toContain('title="keep" style="');
    expect(html).toContain("margin:0 0 16px;");
    expect(html).toContain("color:red");
    expect(html.match(/<p\b/g)).toHaveLength(1);
    expect(html.match(/style="/g)).toHaveLength(1);
  });

  it("merges a table's own class with content-table instead of duplicating", () => {
    const html = buildExportHtml(
      "email-html",
      '<table class="mine"><tr><td>x</td></tr></table>',
    );
    expect(html.match(/<table[^>]*>/g)).toEqual([
      '<table cellpadding="0" cellspacing="0" class="content-table mine">',
    ]);
  });

  it("keeps a quoted-entity style value whole while merging the profile rules", () => {
    // `&quot;` inside the value must not end the attribute the matchAll pass
    // reads: the profile rules land in front of the element's own style.
    const html = buildExportHtml(
      "email-html",
      '<a href="https://example.com" style="font-family:&quot;x&quot;">l</a>',
    );
    expect(html).toContain(
      'style="color:#0066cc;text-decoration:underline;font-family:&quot;x&quot;"',
    );
  });
});

// ─── S3923: src/lib/diff.ts context lines ─────────────────────────────────────

describe("parseDiffHunks context lines (S3923)", () => {
  it("splits context around the change into find/replace identically", () => {
    const [h] = parseDiffHunks(
      "--- a/f\n+++ b/f\n@@ -1,4 +1,4 @@\n before\n-old\n+new\n after\n",
    );
    expect(h.find).toBe("before\nold\nafter");
    expect(h.replace).toBe("before\nnew\nafter");
  });
});

// ─── source guards: the flagged patterns can't silently return ────────────────

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

describe("source guards (S2871)", () => {
  it("no comparator-less sort()/toSorted() in the flagged scripts", () => {
    for (const rel of [
      "scripts/ci/validate-dispatch.mjs",
      "scripts/check-crypto.mjs",
    ]) {
      expect(/\.(?:sort|toSorted)\(\s*\)/.test(src(rel)), rel).toBe(false);
    }
  });
});

describe("source guards (S9383)", () => {
  const VOID_SITES: Record<string, string[]> = {
    "src/mcp/bridge.ts": [
      'void invoke("mcp_sync_state"',
      'void invoke("mcp_sync_vault"',
      "void persistSession(sid)",
      "void syncDocToSession(",
      "void p.then(",
    ],
    "src/App.tsx": ["void checkForUpdates()"],
    "src/components/ActivityDrawer.tsx": [
      "void watchDirectory(watchedDir)",
      "void loadFiles()",
      "void onActivityFile(",
    ],
    "src/components/viewer/MermaidBlock.tsx": ["void (async () =>"],
    "src/components/ai/RelatedNotes.tsx": ["void retrieveLibraryContext("],
    "src/components/canvas/CanvasViewer.tsx": [
      "void (async () =>",
      'void invoke("plugin:opener|reveal_item_in_dir"',
    ],
    "src/components/DefaultHandlerBanner.tsx": ["void defaultHandlerStatus()"],
    "src/components/settings/sections/EmbedSection.tsx": ["void embedStatus()"],
    "src/components/settings/sections/DefaultHandlerSection.tsx": ["void import("],
    "src/components/settings/sections/AnthropicKeySection.tsx": [
      "void anthropicEnvKeyStatus()",
    ],
  };

  for (const [rel, needles] of Object.entries(VOID_SITES)) {
    it(`marks every fire-and-forget call with void: ${rel}`, () => {
      const file = src(rel);
      for (const needle of needles) {
        expect(file.includes(needle), `${rel} → ${needle}`).toBe(true);
      }
    });
  }
});

describe("source guards (S6351)", () => {
  it("export.ts drives the global attribute regex with matchAll, not exec", () => {
    const file = src("src/lib/export.ts");
    expect(file).toContain("attrs.matchAll(");
    expect(file).not.toMatch(/\.exec\(attrs\)/);
  });
});

describe("source guards (S3923)", () => {
  it("diff.ts pushes a context line exactly once, unconditionally", () => {
    const file = src("src/lib/diff.ts");
    expect(file.match(/pendingContext\.push\(content\)/g)).toHaveLength(1);
  });

  it("CodeBlock.tsx has no ternary whose branches are both the empty string", () => {
    const file = src("src/components/viewer/CodeBlock.tsx");
    expect(/\?\s*""\s*:\s*""/.test(file)).toBe(false);
  });
});
