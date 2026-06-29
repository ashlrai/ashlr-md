/**
 * agent-detect.test.ts
 *
 * Comprehensive unit tests for the agent-detect module, covering:
 *  - Detection of all DocKind values (plan, diff, multi-file, spec, review, runbook, generic, null)
 *  - Frontmatter `kind:` marker takes priority over structural detection
 *  - Structural heading-pattern detection for spec, review, runbook
 *  - acceptanceCriteria extraction on spec docs
 *  - stepCount population on runbook docs
 *  - Mixed documents (spec + review headings) detect correctly via priority order
 *  - Edge cases: empty content, only frontmatter, invalid YAML-like frontmatter, no markers
 *  - parseFrontmatterKind standalone edge cases
 */

import { describe, expect, it } from "vitest";
import {
  detectDocKind,
  parseFrontmatterKind,
} from "./agent-detect";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fm(kind: string, extra = ""): string {
  return `---\nkind: ${kind}\n${extra}---\n`;
}

// ---------------------------------------------------------------------------
// parseFrontmatterKind
// ---------------------------------------------------------------------------

describe("parseFrontmatterKind", () => {
  it("returns the kind value from a frontmatter block", () => {
    expect(parseFrontmatterKind("---\nkind: spec\n---\n# Body")).toBe("spec");
  });

  it("returns the kind value with surrounding quotes stripped", () => {
    expect(parseFrontmatterKind('---\nkind: "runbook"\n---\n')).toBe("runbook");
    expect(parseFrontmatterKind("---\nkind: 'review'\n---\n")).toBe("review");
  });

  it("is case-insensitive — normalises to lower-case", () => {
    expect(parseFrontmatterKind("---\nkind: SPEC\n---\n")).toBe("spec");
    expect(parseFrontmatterKind("---\nkind: Runbook\n---\n")).toBe("runbook");
  });

  it("returns null when there is no frontmatter block", () => {
    expect(parseFrontmatterKind("# Just a heading\n\n## Body")).toBeNull();
  });

  it("returns null when frontmatter has no kind key", () => {
    expect(parseFrontmatterKind("---\ntitle: My Doc\nauthor: Alice\n---\n# Body")).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(parseFrontmatterKind("")).toBeNull();
    expect(parseFrontmatterKind("   ")).toBeNull();
  });

  it("does not parse a mid-document --- as frontmatter", () => {
    expect(parseFrontmatterKind("# Heading\n\n---\n\nkind: spec\n\n---")).toBeNull();
  });

  it("handles frontmatter with extra fields", () => {
    const doc = "---\ntitle: My Spec\nauthor: Bob\nkind: spec\ndate: 2025-01-01\n---\n# Body";
    expect(parseFrontmatterKind(doc)).toBe("spec");
  });

  it("handles frontmatter closed with ... (YAML end marker)", () => {
    expect(parseFrontmatterKind("---\nkind: runbook\n...\n# Body")).toBe("runbook");
  });

  it("returns null for an unclosed frontmatter block", () => {
    // No closing ---
    expect(parseFrontmatterKind("---\nkind: spec\ntitle: Open")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectDocKind — null / empty
// ---------------------------------------------------------------------------

describe("detectDocKind — null / empty", () => {
  it("returns null kind for empty string", () => {
    expect(detectDocKind("").kind).toBeNull();
  });

  it("returns null kind for whitespace-only content", () => {
    expect(detectDocKind("   \n\n  ").kind).toBeNull();
  });

  it("returns null for plain prose without agent markers", () => {
    const doc = "# My Notes\n\nJust some regular text.\n\nAnother paragraph.";
    expect(detectDocKind(doc).kind).toBeNull();
  });

  it("returns null for a single task item (below threshold)", () => {
    const doc = "# Heading\n\n- [ ] One task only\n\nSome text.";
    expect(detectDocKind(doc).kind).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectDocKind — plan
// ---------------------------------------------------------------------------

describe("detectDocKind — plan", () => {
  it("detects plan: h1 + ≥2 task items", () => {
    const doc = "# My Plan\n\n- [ ] Task one\n- [x] Task two\n- [ ] Task three\n";
    const info = detectDocKind(doc);
    expect(info.kind).toBe("plan");
    expect(info.taskTotal).toBe(3);
    expect(info.taskDone).toBe(1);
  });

  it("plan: exactly 2 task items", () => {
    const doc = "# Plan\n\n- [ ] Alpha\n- [x] Beta\n";
    expect(detectDocKind(doc).kind).toBe("plan");
  });

  it("plan: counts all task formats (- [ ], * [ ], 1. [ ])", () => {
    const doc = "# Plan\n\n- [ ] One\n* [x] Two\n1. [ ] Three\n";
    const info = detectDocKind(doc);
    expect(info.kind).toBe("plan");
    expect(info.taskTotal).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// detectDocKind — diff
// ---------------------------------------------------------------------------

describe("detectDocKind — diff", () => {
  it("detects diff: contains a ```diff block", () => {
    const doc =
      "# Changes\n\n```diff\n-old line\n+new line\n```\n";
    expect(detectDocKind(doc).kind).toBe("diff");
  });

  it("diff counts hunk total", () => {
    const doc =
      "```diff\n@@ -1,3 +1,3 @@\n-a\n+b\n@@ -10,2 +10,2 @@\n-c\n+d\n```\n";
    const info = detectDocKind(doc);
    expect(info.kind).toBe("diff");
    expect(info.hunkTotal).toBe(2);
  });

  it("diff takes priority over task items (no plan)", () => {
    const doc = "# Plan\n\n- [ ] A\n- [ ] B\n\n```diff\n-x\n+y\n```\n";
    expect(detectDocKind(doc).kind).toBe("diff");
  });
});

// ---------------------------------------------------------------------------
// detectDocKind — multi-file
// ---------------------------------------------------------------------------

describe("detectDocKind — multi-file", () => {
  it("detects multi-file: ≥3 file-path headings", () => {
    const doc =
      "## src/foo.ts\n\n```ts\nconst a = 1;\n```\n\n## src/bar.ts\n\n```ts\nconst b = 2;\n```\n\n## src/baz.ts\n\n```ts\nconst c = 3;\n```\n";
    expect(detectDocKind(doc).kind).toBe("multi-file");
  });

  it("does NOT detect multi-file with only 2 file-path headings", () => {
    const doc = "## src/foo.ts\n\n```ts\nconst a = 1;\n```\n\n## src/bar.ts\n\n```ts\nconst b = 2;\n```\n";
    // Should fall through to another kind or null
    const info = detectDocKind(doc);
    expect(info.kind).not.toBe("multi-file");
  });
});

// ---------------------------------------------------------------------------
// detectDocKind — spec (frontmatter)
// ---------------------------------------------------------------------------

describe("detectDocKind — spec (frontmatter)", () => {
  it("detects spec via frontmatter kind: spec", () => {
    const doc = `${fm("spec")}# My Spec\n\n## Requirements\n\nMust do X.\n`;
    const info = detectDocKind(doc);
    expect(info.kind).toBe("spec");
  });

  it("spec: extracts acceptance criteria when present", () => {
    const doc =
      `${fm("spec")}# Spec\n\n## Requirements\n\nFoo.\n\n## Acceptance Criteria\n\n- [x] Item A passes\n- [ ] Item B passes\n`;
    const info = detectDocKind(doc);
    expect(info.kind).toBe("spec");
    expect(info.acceptanceCriteria).toHaveLength(2);
    expect(info.acceptanceCriteria?.[0]).toBe("Item A passes");
    expect(info.acceptanceCriteria?.[1]).toBe("Item B passes");
  });

  it("spec: acceptanceCriteria is empty array when no criteria section", () => {
    const doc = `${fm("spec")}# Spec\n\n## Requirements\n\nFoo.\n`;
    const info = detectDocKind(doc);
    expect(info.kind).toBe("spec");
    expect(info.acceptanceCriteria).toEqual([]);
  });

  it("spec frontmatter takes priority over diff blocks", () => {
    const doc = `${fm("spec")}# Spec\n\n\`\`\`diff\n-a\n+b\n\`\`\`\n`;
    expect(detectDocKind(doc).kind).toBe("spec");
  });

  it("spec frontmatter takes priority over plan structure", () => {
    const doc = `${fm("spec")}# Plan\n\n- [ ] A\n- [ ] B\n`;
    expect(detectDocKind(doc).kind).toBe("spec");
  });
});

// ---------------------------------------------------------------------------
// detectDocKind — spec (structural heading detection)
// ---------------------------------------------------------------------------

describe("detectDocKind — spec (structural headings)", () => {
  it("detects spec with ## Requirements + ## Design headings", () => {
    const doc = "# My Feature\n\n## Requirements\n\nMust do X.\n\n## Design\n\nArchitecture notes.\n";
    expect(detectDocKind(doc).kind).toBe("spec");
  });

  it("detects spec with ## Design + ## Implementation headings", () => {
    const doc = "# Feature\n\n## Design\n\nNotes.\n\n## Implementation\n\nCode notes.\n";
    expect(detectDocKind(doc).kind).toBe("spec");
  });

  it("detects spec with ## Requirements + ## Acceptance Criteria (one spec heading + criteria)", () => {
    const doc =
      "# Feature\n\n## Requirements\n\nMust.\n\n## Acceptance Criteria\n\n- [ ] A\n- [x] B\n";
    const info = detectDocKind(doc);
    expect(info.kind).toBe("spec");
  });

  it("does NOT detect spec with only one spec heading and no criteria", () => {
    const doc = "# Feature\n\n## Requirements\n\nMust do X.\n\nSome text.\n";
    // Only one spec heading — not enough for structural detection
    expect(detectDocKind(doc).kind).not.toBe("spec");
  });

  it("spec structural: criteria extraction works without frontmatter", () => {
    const doc =
      "# Spec\n\n## Requirements\n\nFoo.\n\n## Design\n\nBar.\n\n## Acceptance Criteria\n\n- [ ] Pass test A\n- [x] Pass test B\n";
    const info = detectDocKind(doc);
    expect(info.kind).toBe("spec");
    expect(info.acceptanceCriteria).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// detectDocKind — review (frontmatter)
// ---------------------------------------------------------------------------

describe("detectDocKind — review (frontmatter)", () => {
  it("detects review via frontmatter kind: review", () => {
    const doc = `${fm("review")}# Code Review\n\n## Files Changed\n\n- src/foo.ts\n`;
    expect(detectDocKind(doc).kind).toBe("review");
  });

  it("review frontmatter takes priority over runbook structure", () => {
    const doc =
      `${fm("review")}# Review\n\n## Prerequisites\n\nSetup.\n\n## Steps\n\nDo.\n\n\`\`\`bash\necho hi\n\`\`\`\n\n## Rollback\n\nUndo.\n`;
    expect(detectDocKind(doc).kind).toBe("review");
  });

  it("review frontmatter takes priority over diff blocks", () => {
    const doc = `${fm("review")}# Review\n\n\`\`\`diff\n-a\n+b\n\`\`\`\n`;
    expect(detectDocKind(doc).kind).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// detectDocKind — review (structural heading detection)
// ---------------------------------------------------------------------------

describe("detectDocKind — review (structural headings)", () => {
  it("detects review with ## Files Changed + ## Summary", () => {
    const doc = "# PR Review\n\n## Files Changed\n\n- foo.ts\n\n## Summary\n\nLooks good.\n";
    expect(detectDocKind(doc).kind).toBe("review");
  });

  it("detects review with ## Summary + ## Feedback", () => {
    const doc = "# Review\n\n## Summary\n\nOverall fine.\n\n## Feedback\n\nSome notes.\n";
    expect(detectDocKind(doc).kind).toBe("review");
  });

  it("detects review with ## Files Changed + ## Feedback", () => {
    const doc = "# Review\n\n## Files Changed\n\n- bar.ts\n\n## Feedback\n\nGood work.\n";
    expect(detectDocKind(doc).kind).toBe("review");
  });

  it("does NOT detect review with only one review heading", () => {
    const doc = "# Notes\n\n## Summary\n\nJust a summary.\n\nSome text.\n";
    expect(detectDocKind(doc).kind).not.toBe("review");
  });
});

// ---------------------------------------------------------------------------
// detectDocKind — runbook (frontmatter)
// ---------------------------------------------------------------------------

describe("detectDocKind — runbook (frontmatter)", () => {
  it("detects runbook via frontmatter kind: runbook", () => {
    const doc =
      `${fm("runbook")}# Deploy Runbook\n\n## Prerequisites\n\n- Node.js\n\n## Steps\n\n1. Run deploy\n`;
    const info = detectDocKind(doc);
    expect(info.kind).toBe("runbook");
  });

  it("runbook frontmatter: stepCount is populated", () => {
    const doc =
      `${fm("runbook")}# Runbook\n\n## Steps\n\n1. First step\n2. Second step\n3. Third step\n`;
    const info = detectDocKind(doc);
    expect(info.kind).toBe("runbook");
    expect(info.stepCount).toBeGreaterThan(0);
  });

  it("runbook frontmatter takes priority over spec structure", () => {
    const doc =
      `${fm("runbook")}# Doc\n\n## Requirements\n\nFoo.\n\n## Design\n\nBar.\n`;
    expect(detectDocKind(doc).kind).toBe("runbook");
  });
});

// ---------------------------------------------------------------------------
// detectDocKind — runbook (structural heading detection)
// ---------------------------------------------------------------------------

describe("detectDocKind — runbook (structural headings)", () => {
  const BASE_RUNBOOK =
    "# Deploy Service\n\n## Prerequisites\n\n- Docker installed\n- kubectl access\n\n## Steps\n\n1. Build image\n\n```bash\ndocker build -t app:latest .\n```\n\n2. Deploy\n\n```bash\nkubectl apply -f deploy.yaml\n```\n\n## Rollback\n\nRun `kubectl rollout undo`.\n";

  it("detects runbook with ## Prerequisites + ## Steps + code fence", () => {
    expect(detectDocKind(BASE_RUNBOOK).kind).toBe("runbook");
  });

  it("detects runbook with ## Steps + ## Rollback + code fence", () => {
    const doc =
      "# Deploy\n\n## Steps\n\n1. Do thing\n\n```bash\necho ok\n```\n\n## Rollback\n\nUndo.\n";
    expect(detectDocKind(doc).kind).toBe("runbook");
  });

  it("does NOT detect runbook without a code fence (code is required signal)", () => {
    const doc =
      "# Deploy\n\n## Prerequisites\n\n- Docker\n\n## Steps\n\n1. Build\n2. Deploy\n\n## Rollback\n\nUndo.\n";
    // No code fence — should not be classified as runbook
    expect(detectDocKind(doc).kind).not.toBe("runbook");
  });

  it("does NOT detect runbook with only one heading signal", () => {
    const doc = "# Doc\n\n## Steps\n\n1. Do thing\n\n```bash\necho hi\n```\n";
    expect(detectDocKind(doc).kind).not.toBe("runbook");
  });

  it("runbook structural: stepCount is populated", () => {
    const info = detectDocKind(BASE_RUNBOOK);
    expect(info.kind).toBe("runbook");
    expect(info.stepCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// detectDocKind — generic
// ---------------------------------------------------------------------------

describe("detectDocKind — generic", () => {
  it("detects generic: ≥2 task items, no h1", () => {
    const doc = "Some preamble.\n\n- [ ] Task alpha\n- [x] Task beta\n\nMore text.\n";
    expect(detectDocKind(doc).kind).toBe("generic");
  });

  it("generic: taskTotal and taskDone are accurate", () => {
    const doc = "Intro.\n\n- [x] Done one\n- [x] Done two\n- [ ] Pending\n";
    const info = detectDocKind(doc);
    expect(info.kind).toBe("generic");
    expect(info.taskTotal).toBe(3);
    expect(info.taskDone).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Mixed document detection (priority ordering)
// ---------------------------------------------------------------------------

describe("detectDocKind — mixed documents", () => {
  it("spec + review headings: spec wins (comes before review in priority)", () => {
    // Has both spec headings (Requirements, Design) and review headings (Files Changed, Feedback)
    const doc =
      "# Feature Spec\n\n## Requirements\n\nFoo.\n\n## Design\n\nBar.\n\n## Files Changed\n\n- foo.ts\n\n## Feedback\n\nGood.\n";
    // spec has ≥2 spec headings → spec wins
    expect(detectDocKind(doc).kind).toBe("spec");
  });

  it("diff + task items: diff wins", () => {
    const doc = "# Plan\n\n- [ ] A\n- [ ] B\n\n```diff\n-a\n+b\n```\n";
    expect(detectDocKind(doc).kind).toBe("diff");
  });

  it("frontmatter kind overrides all structural signals", () => {
    // Structural signals strongly suggest runbook, but frontmatter says spec
    const doc =
      `${fm("spec")}# Doc\n\n## Prerequisites\n\n- Docker\n\n## Steps\n\n1. Deploy\n\n\`\`\`bash\nsh run.sh\n\`\`\`\n\n## Rollback\n\nUndo.\n`;
    expect(detectDocKind(doc).kind).toBe("spec");
  });

  it("review headings + diff block: diff wins (diff is higher priority than review)", () => {
    const doc =
      "# Review\n\n## Files Changed\n\n- foo.ts\n\n## Feedback\n\nGood.\n\n```diff\n-a\n+b\n```\n";
    expect(detectDocKind(doc).kind).toBe("diff");
  });

  it("plan structure inside a spec doc (frontmatter): spec wins, taskTotal still counted", () => {
    const doc = `${fm("spec")}# Spec\n\n## Requirements\n\n- [ ] Req A\n- [x] Req B\n- [ ] Req C\n`;
    const info = detectDocKind(doc);
    expect(info.kind).toBe("spec");
    expect(info.taskTotal).toBe(3);
    expect(info.taskDone).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: invalid / unusual frontmatter
// ---------------------------------------------------------------------------

describe("detectDocKind — frontmatter edge cases", () => {
  it("ignores frontmatter with invalid YAML-like content (no kind key)", () => {
    const doc = "---\nthis is not: valid yaml at all!!!\n---\n# Body\n\n## Requirements\n\nFoo.\n\n## Design\n\nBar.\n";
    // No kind extracted — falls through to structural detection
    const info = detectDocKind(doc);
    expect(info.kind).toBe("spec"); // structural detection kicks in
  });

  it("handles frontmatter with only whitespace between fences", () => {
    const doc = "---\n   \n---\n# Body\n\n- [ ] A\n- [ ] B\n";
    const info = detectDocKind(doc);
    expect(parseFrontmatterKind(doc)).toBeNull();
    expect(info.kind).toBe("plan");
  });

  it("handles kind: with extra spaces", () => {
    // kind:   spec  (with spaces before/after value — typical YAML)
    const doc = "---\nkind:   spec  \n---\n# Body\n";
    // parseFrontmatterKind trims via regex
    expect(parseFrontmatterKind(doc)).toBe("spec");
  });

  it("handles an unknown kind value — falls through to structural detection", () => {
    const doc = "---\nkind: unknown_kind_xyz\n---\n# Plan\n\n- [ ] A\n- [x] B\n";
    // Unknown kind doesn't match spec/review/runbook → structural detection
    const info = detectDocKind(doc);
    expect(info.kind).toBe("plan");
  });

  it("handles missing closing --- in frontmatter — no kind extracted", () => {
    const doc = "---\nkind: spec\ntitle: Unclosed\n# Body\n\n## Requirements\n\nFoo.\n\n## Design\n\nBar.\n";
    expect(parseFrontmatterKind(doc)).toBeNull();
  });
});
