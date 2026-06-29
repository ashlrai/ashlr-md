/**
 * Renderer.test.ts
 *
 * Unit tests for the renderer plugin system — verifying that the three new
 * renderer helpers (spec, review, runbook) mount correctly and produce the
 * expected structural output from representative document fixtures.
 *
 * These tests exercise the pure data-extraction layer (parseSpec, parseReview,
 * parseRunbook) that the React components in Renderer.tsx consume.  The tests
 * are intentionally React-free so they run in the happy-dom vitest environment
 * without needing react-testing-library.
 */

import { describe, expect, it } from "vitest";
import { parseSpec } from "../../lib/renderers/spec-renderer";
import { parseReview } from "../../lib/renderers/review-renderer";
import { parseRunbook } from "../../lib/renderers/runbook-renderer";

// ===========================================================================
// Fixtures
// ===========================================================================

const SPEC_DOC = `---
kind: spec
---
# Authentication Overhaul

## Requirements

Users must be able to log in with email/password and OAuth.
Sessions must expire after 24 hours.

## Design

Use JWT tokens stored in HttpOnly cookies.
Refresh tokens stored in a separate secure store.

## Implementation

1. Update auth middleware
2. Add OAuth provider integrations
3. Write migration scripts

## Acceptance Criteria

- [x] Email/password login works
- [ ] OAuth login works
- [ ] Session expiry is enforced
- [x] Tokens stored securely

## Open Questions

- Which OAuth providers first?
`;

const REVIEW_DOC = `---
kind: review
---
# PR #142 Review

## Summary

This PR adds the new authentication system. Overall solid, a few nits.

## Files Changed

- src/auth/middleware.ts — refactored auth chain
- src/auth/oauth.ts — new OAuth integration
- src/store/sessionStore.ts — session state management

## Feedback

### src/auth/middleware.ts

The token validation logic looks correct but could be simplified.

### Error handling

**Missing error boundary:** The OAuth callback doesn't handle network errors.

Consider wrapping in a try/catch.
`;

const RUNBOOK_DOC = `# Deploy Authentication Service

## Prerequisites

- Docker installed and running
- kubectl access to production cluster
- Environment variables configured in .env.production

## Steps

1. Build the Docker image

\`\`\`bash
docker build -t auth-service:latest .
docker tag auth-service:latest registry.example.com/auth-service:v2.0
\`\`\`

2. Push to registry

\`\`\`bash
docker push registry.example.com/auth-service:v2.0
\`\`\`

3. Apply Kubernetes manifests

\`\`\`bash
kubectl apply -f k8s/auth-deployment.yaml
kubectl rollout status deployment/auth-service
\`\`\`

## Rollback

If anything goes wrong, roll back with:

\`\`\`bash
kubectl rollout undo deployment/auth-service
\`\`\`

## Verification

Check the health endpoint:

\`\`\`bash
curl https://api.example.com/health
\`\`\`
`;

// ===========================================================================
// parseSpec
// ===========================================================================

describe("parseSpec — mounts and renders correctly", () => {
  it("returns a ParsedSpec with non-empty sections", () => {
    const result = parseSpec(SPEC_DOC);
    expect(result.sections.length).toBeGreaterThan(0);
  });

  it("extracts the document title from the first h1", () => {
    const result = parseSpec(SPEC_DOC);
    expect(result.title).toBe("Authentication Overhaul");
  });

  it("extracts canonical spec sections (Requirements, Design, Implementation)", () => {
    const result = parseSpec(SPEC_DOC);
    const titles = result.sections.map((s) => s.title.toLowerCase());
    expect(titles).toContain("requirements");
    expect(titles).toContain("design");
    expect(titles).toContain("implementation");
  });

  it("extracts acceptance criteria items", () => {
    const result = parseSpec(SPEC_DOC);
    expect(result.criteriaTotal).toBe(4);
    expect(result.criteriaDone).toBe(2);
  });

  it("criteria items have correct done state", () => {
    const result = parseSpec(SPEC_DOC);
    const doneItems = result.criteria.filter((c) => c.done);
    const pendingItems = result.criteria.filter((c) => !c.done);
    expect(doneItems).toHaveLength(2);
    expect(pendingItems).toHaveLength(2);
  });

  it("criteria items have non-empty text", () => {
    const result = parseSpec(SPEC_DOC);
    for (const c of result.criteria) {
      expect(c.text.length).toBeGreaterThan(0);
    }
  });

  it("criteria items have 1-based line numbers", () => {
    const result = parseSpec(SPEC_DOC);
    for (const c of result.criteria) {
      expect(c.line).toBeGreaterThan(0);
    }
  });

  it("each section has non-empty body", () => {
    const result = parseSpec(SPEC_DOC);
    for (const section of result.sections) {
      expect(section.body.length).toBeGreaterThan(0);
    }
  });

  it("sections have correct heading level (2 for ## headings)", () => {
    const result = parseSpec(SPEC_DOC);
    for (const section of result.sections) {
      expect(section.level).toBe(2);
    }
  });

  it("returns empty criteria when no criteria section present", () => {
    const nocriteriaDoc = "# Spec\n\n## Requirements\n\nFoo.\n\n## Design\n\nBar.\n";
    const result = parseSpec(nocriteriaDoc);
    expect(result.criteria).toEqual([]);
    expect(result.criteriaTotal).toBe(0);
    expect(result.criteriaDone).toBe(0);
  });

  it("returns empty sections for a non-spec document", () => {
    const plain = "# Just a heading\n\nSome prose.\n";
    const result = parseSpec(plain);
    expect(result.sections).toEqual([]);
  });

  it("handles document with frontmatter correctly (skips it)", () => {
    const withFm = "---\nkind: spec\ntitle: My Spec\n---\n# Title\n\n## Requirements\n\nFoo.\n";
    const result = parseSpec(withFm);
    expect(result.title).toBe("Title");
    expect(result.sections.some((s) => s.title.toLowerCase() === "requirements")).toBe(true);
  });

  it("handles empty document without throwing", () => {
    expect(() => parseSpec("")).not.toThrow();
    const result = parseSpec("");
    expect(result.sections).toEqual([]);
    expect(result.criteria).toEqual([]);
  });
});

// ===========================================================================
// parseReview
// ===========================================================================

describe("parseReview — mounts and renders correctly", () => {
  it("returns a ParsedReview with non-empty structure", () => {
    const result = parseReview(REVIEW_DOC);
    expect(result.files.length + result.feedbackTotal).toBeGreaterThan(0);
  });

  it("extracts the document title from the first h1", () => {
    const result = parseReview(REVIEW_DOC);
    expect(result.title).toBe("PR #142 Review");
  });

  it("extracts the summary section body", () => {
    const result = parseReview(REVIEW_DOC);
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.summary).toContain("authentication system");
  });

  it("extracts file entries from ## Files Changed", () => {
    const result = parseReview(REVIEW_DOC);
    expect(result.files.length).toBeGreaterThan(0);
  });

  it("file entries have non-empty path", () => {
    const result = parseReview(REVIEW_DOC);
    for (const f of result.files) {
      expect(f.path.length).toBeGreaterThan(0);
    }
  });

  it("file entries have 1-based line numbers", () => {
    const result = parseReview(REVIEW_DOC);
    for (const f of result.files) {
      expect(f.line).toBeGreaterThan(0);
    }
  });

  it("extracts feedback annotations from ## Feedback section", () => {
    const result = parseReview(REVIEW_DOC);
    expect(result.feedbackTotal).toBeGreaterThan(0);
  });

  it("feedback annotations have non-empty labels", () => {
    const result = parseReview(REVIEW_DOC);
    for (const a of result.feedback) {
      expect(a.label.length).toBeGreaterThan(0);
    }
  });

  it("feedback annotations have 1-based line numbers", () => {
    const result = parseReview(REVIEW_DOC);
    for (const a of result.feedback) {
      expect(a.line).toBeGreaterThan(0);
    }
  });

  it("returns empty files + feedback for a non-review document", () => {
    const plain = "# Just notes\n\nSome prose.\n";
    const result = parseReview(plain);
    expect(result.files).toEqual([]);
    expect(result.feedback).toEqual([]);
    expect(result.feedbackTotal).toBe(0);
  });

  it("handles document with frontmatter correctly (skips it)", () => {
    const withFm = "---\nkind: review\n---\n# Review\n\n## Summary\n\nLooks good.\n";
    const result = parseReview(withFm);
    expect(result.title).toBe("Review");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("handles empty document without throwing", () => {
    expect(() => parseReview("")).not.toThrow();
    const result = parseReview("");
    expect(result.files).toEqual([]);
    expect(result.feedback).toEqual([]);
  });

  it("summary is empty string when no ## Summary section present", () => {
    const noSummary = "# Review\n\n## Files Changed\n\n- foo.ts\n";
    const result = parseReview(noSummary);
    expect(result.summary).toBe("");
    expect(result.files.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// parseRunbook
// ===========================================================================

describe("parseRunbook — mounts and renders correctly", () => {
  it("returns a ParsedRunbook with steps", () => {
    const result = parseRunbook(RUNBOOK_DOC);
    expect(result.stepCount).toBeGreaterThan(0);
  });

  it("extracts the document title from the first h1", () => {
    const result = parseRunbook(RUNBOOK_DOC);
    expect(result.title).toBe("Deploy Authentication Service");
  });

  it("extracts prerequisites from ## Prerequisites", () => {
    const result = parseRunbook(RUNBOOK_DOC);
    expect(result.prerequisites.length).toBeGreaterThan(0);
  });

  it("prerequisites have non-empty text", () => {
    const result = parseRunbook(RUNBOOK_DOC);
    for (const p of result.prerequisites) {
      expect(p.text.length).toBeGreaterThan(0);
    }
  });

  it("extracts steps with correct count", () => {
    const result = parseRunbook(RUNBOOK_DOC);
    // RUNBOOK_DOC has 3 numbered steps under ## Steps
    expect(result.steps.length).toBe(3);
    expect(result.stepCount).toBe(3);
  });

  it("steps have sequential IDs starting at 1", () => {
    const result = parseRunbook(RUNBOOK_DOC);
    result.steps.forEach((step, idx) => {
      expect(step.id).toBe(idx + 1);
    });
  });

  it("steps have non-empty titles", () => {
    const result = parseRunbook(RUNBOOK_DOC);
    for (const step of result.steps) {
      expect(step.title.length).toBeGreaterThan(0);
    }
  });

  it("steps with code blocks have commands extracted", () => {
    const result = parseRunbook(RUNBOOK_DOC);
    const stepsWithCommands = result.steps.filter((s) => s.commands.length > 0);
    expect(stepsWithCommands.length).toBeGreaterThan(0);
  });

  it("commands are non-empty strings", () => {
    const result = parseRunbook(RUNBOOK_DOC);
    for (const step of result.steps) {
      for (const cmd of step.commands) {
        expect(cmd.length).toBeGreaterThan(0);
      }
    }
  });

  it("steps have 1-based line numbers", () => {
    const result = parseRunbook(RUNBOOK_DOC);
    for (const step of result.steps) {
      expect(step.line).toBeGreaterThan(0);
    }
  });

  it("extracts rollback section body", () => {
    const result = parseRunbook(RUNBOOK_DOC);
    expect(result.rollback.length).toBeGreaterThan(0);
  });

  it("extracts verification section body", () => {
    const result = parseRunbook(RUNBOOK_DOC);
    expect(result.verification.length).toBeGreaterThan(0);
  });

  it("troubleshooting is empty string when section absent", () => {
    const result = parseRunbook(RUNBOOK_DOC);
    expect(result.troubleshooting).toBe("");
  });

  it("handles document without ## Rollback gracefully", () => {
    const noRollback =
      "# Runbook\n\n## Prerequisites\n\n- Docker\n\n## Steps\n\n1. Deploy\n\n```bash\nsh deploy.sh\n```\n";
    const result = parseRunbook(noRollback);
    expect(result.rollback).toBe("");
    expect(result.steps.length).toBe(1);
  });

  it("handles empty document without throwing", () => {
    expect(() => parseRunbook("")).not.toThrow();
    const result = parseRunbook("");
    expect(result.steps).toEqual([]);
    expect(result.prerequisites).toEqual([]);
    expect(result.stepCount).toBe(0);
  });

  it("handles document with frontmatter correctly (skips it)", () => {
    const withFm =
      "---\nkind: runbook\n---\n# Deploy\n\n## Prerequisites\n\n- Docker\n\n## Steps\n\n1. Run\n\n```bash\nsh run.sh\n```\n\n## Rollback\n\nUndo.\n";
    const result = parseRunbook(withFm);
    expect(result.title).toBe("Deploy");
    expect(result.steps.length).toBe(1);
    expect(result.prerequisites.length).toBe(1);
  });

  it("detects steps defined as ### Step N headings", () => {
    const headingSteps =
      "# Runbook\n\n## Steps\n\n### Step 1: Install\n\nRun installer.\n\n```bash\nnpm install\n```\n\n### Step 2: Configure\n\nSet env vars.\n\n```bash\ncp .env.example .env\n```\n";
    const result = parseRunbook(headingSteps);
    expect(result.steps.length).toBe(2);
  });

  it("extracts troubleshooting section when present", () => {
    const withTs =
      "# Runbook\n\n## Prerequisites\n\n- Docker\n\n## Steps\n\n1. Deploy\n\n```bash\nsh run.sh\n```\n\n## Rollback\n\nUndo.\n\n## Troubleshooting\n\nIf it fails, check logs.\n";
    const result = parseRunbook(withTs);
    expect(result.troubleshooting.length).toBeGreaterThan(0);
  });
});
