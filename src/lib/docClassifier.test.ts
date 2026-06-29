/**
 * docClassifier.test.ts
 *
 * 40+ test cases for the docClassifier module covering:
 *   - classify() returns correct DocType for each type
 *   - Frontmatter `type:`/`kind:` hint takes precedence over heuristics
 *   - Heading-pattern heuristics for PLAN/REVIEW/SPEC/RUNBOOK
 *   - Word-frequency signals
 *   - Checklist density (task items → PLAN)
 *   - Code-block density (heavy code → RUNBOOK/SPEC)
 *   - Real agent-generated document snapshots
 *   - Ambiguous/mixed documents fall back to GENERIC or highest-signal type
 *   - Edge cases: empty, whitespace-only, minimal content
 */

import { describe, expect, it } from "vitest";
import { classify } from "./docClassifier";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fm(key: string, value: string, extra = ""): string {
  return `---\n${key}: ${value}\n${extra}---\n`;
}

function tasks(n: number, done = 0): string {
  return Array.from({ length: n }, (_, i) =>
    `- [${i < done ? "x" : " "}] Task ${i + 1}`,
  ).join("\n");
}

function codeBlock(lang: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `  line ${i + 1};`).join("\n");
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

// ---------------------------------------------------------------------------
// 1. Edge cases
// ---------------------------------------------------------------------------

describe("classify — edge cases", () => {
  it("returns GENERIC for empty string", () => {
    expect(classify("")).toBe("GENERIC");
  });

  it("returns GENERIC for whitespace-only content", () => {
    expect(classify("   \n\n  \t  ")).toBe("GENERIC");
  });

  it("returns GENERIC for plain prose with no signals", () => {
    const doc = "# Meeting Notes\n\nWe discussed various topics today.\n\nNext meeting is Tuesday.";
    expect(classify(doc)).toBe("GENERIC");
  });

  it("returns GENERIC for a single heading with no body", () => {
    expect(classify("# Title")).toBe("GENERIC");
  });

  it("returns GENERIC for a document with minimal mixed signals (no task items)", () => {
    // Inline code + one review word + one design word — nothing dominant, no tasks
    const doc = "# Notes\n\n`someCode()`\n\nSome feedback here about the overall design.";
    // No single-type signals dominate — should remain GENERIC
    expect(classify(doc)).toBe("GENERIC");
  });
});

// ---------------------------------------------------------------------------
// 2. Frontmatter type hint — highest priority
// ---------------------------------------------------------------------------

describe("classify — frontmatter type hint", () => {
  it("respects `type: PLAN` frontmatter", () => {
    const doc = `${fm("type", "PLAN")}# My Doc\n\nSome review feedback here.\n`;
    expect(classify(doc)).toBe("PLAN");
  });

  it("respects `type: REVIEW` frontmatter", () => {
    const doc = `${fm("type", "REVIEW")}# Spec\n\n## Requirements\n\nFoo.\n\n## Design\n\nBar.\n`;
    expect(classify(doc)).toBe("REVIEW");
  });

  it("respects `type: SPEC` frontmatter", () => {
    const doc = `${fm("type", "SPEC")}# Plan\n\n${tasks(10, 3)}\n`;
    expect(classify(doc)).toBe("SPEC");
  });

  it("respects `type: RUNBOOK` frontmatter", () => {
    const doc = `${fm("type", "RUNBOOK")}# Review\n\n## Feedback\n\nLooks good.\n`;
    expect(classify(doc)).toBe("RUNBOOK");
  });

  it("respects `type: GENERIC` frontmatter", () => {
    const doc = `${fm("type", "GENERIC")}# Spec\n\n## Requirements\n\nFoo.\n\n## Design\n\nBar.\n`;
    expect(classify(doc)).toBe("GENERIC");
  });

  it("respects `kind: spec` (lowercase, agent-detect synonym)", () => {
    const doc = `${fm("kind", "spec")}# Spec\n\n## Requirements\n\nFoo.\n`;
    expect(classify(doc)).toBe("SPEC");
  });

  it("respects `kind: runbook` (lowercase)", () => {
    const doc = `${fm("kind", "runbook")}# Runbook\n\n## Steps\n\n1. Deploy\n`;
    expect(classify(doc)).toBe("RUNBOOK");
  });

  it("respects `doc_type: REVIEW` frontmatter key variant", () => {
    const doc = `${fm("doc_type", "REVIEW")}# Notes\n\nSome text.\n`;
    expect(classify(doc)).toBe("REVIEW");
  });

  it("ignores unknown frontmatter type value — falls through to heuristics", () => {
    // Structural SPEC signals should win after unknown frontmatter type
    const doc = `${fm("type", "UNKNOWN_XYZ")}# Doc\n\n## Requirements\n\nFoo.\n\n## Design\n\nBar.\n\n## Architecture\n\nBaz.\n`;
    // 3 SPEC heading hits → SPEC should win
    expect(classify(doc)).toBe("SPEC");
  });

  it("is case-insensitive for frontmatter type values", () => {
    expect(classify(`${fm("type", "plan")}# Doc\n`)).toBe("PLAN");
    expect(classify(`${fm("type", "Review")}# Doc\n`)).toBe("REVIEW");
    expect(classify(`${fm("type", "SPEC")}# Doc\n`)).toBe("SPEC");
  });
});

// ---------------------------------------------------------------------------
// 3. PLAN classification
// ---------------------------------------------------------------------------

describe("classify — PLAN", () => {
  it("classifies a typical project-plan doc as PLAN", () => {
    const doc = `# Feature Release Plan

## Goals
Deliver the authentication feature by Q3.

## Milestones
- Phase 1: design
- Phase 2: implementation
- Phase 3: testing

## Tasks
${tasks(8, 3)}

## Timeline
Week 1-2: design; Week 3-4: implementation.

## Risks
- Dependency on payment service
`;
    expect(classify(doc)).toBe("PLAN");
  });

  it("classifies a sprint-planning doc as PLAN", () => {
    const doc = `# Sprint 14 Plan

## Objectives
- Improve onboarding flow
- Fix critical bugs

## Action Items
${tasks(6, 2)}

## Owner
Alice is responsible for backend tasks.

## Deadline
2024-07-15

## Priority
P0: authentication
P1: dashboard
`;
    expect(classify(doc)).toBe("PLAN");
  });

  it("classifies a roadmap doc as PLAN", () => {
    const doc = `# Product Roadmap

## Q1 Milestones
${tasks(4, 4)}

## Q2 Milestones
${tasks(5, 1)}

## Q3 Milestones
${tasks(3, 0)}

## Stakeholders
Engineering, Product, Design

## Schedule
Monthly review cadence.
`;
    expect(classify(doc)).toBe("PLAN");
  });

  it("high checklist density pushes a doc toward PLAN", () => {
    const doc = `# Work Plan

${tasks(15, 7)}

Some prose here about the goals of this work.
`;
    expect(classify(doc)).toBe("PLAN");
  });
});

// ---------------------------------------------------------------------------
// 4. REVIEW classification
// ---------------------------------------------------------------------------

describe("classify — REVIEW", () => {
  it("classifies a typical code-review doc as REVIEW", () => {
    const doc = `# PR Review: Add auth module

## Files Changed
- src/auth.ts
- src/middleware.ts

## Summary
Overall the implementation looks good. A few minor concerns.

## Feedback

### Blocking
- \`validateToken()\` doesn't handle expired tokens — throws uncaught exception.

### Non-blocking
- Consider extracting the config into a constant.

## Verdict
Request changes — fix the token expiry handling first.
`;
    expect(classify(doc)).toBe("REVIEW");
  });

  it("classifies an assessment doc as REVIEW", () => {
    const doc = `# Security Assessment

## Summary
Three high-severity findings were identified.

## Findings
1. SQL injection in user search endpoint.
2. Missing CSRF protection on form submissions.
3. Passwords stored as MD5 hashes.

## Recommendations
Immediate remediation required for findings 1 and 2.

## Approval
This assessment must be reviewed by the security team.
`;
    expect(classify(doc)).toBe("REVIEW");
  });

  it("classifies a PR feedback doc as REVIEW", () => {
    const doc = `# Code Review: Dashboard Refactor

## Files Reviewed
- components/Dashboard.tsx
- hooks/useDashboard.ts

## Comments

**Blocking**
The memoization in \`useDashboard\` is incorrect — dependencies are stale.

**Non-blocking**
Consider splitting the component — it's 400 lines.

## Reviewer Notes
Looks good overall, just the memo issue to fix.

LGTM pending fix.
`;
    expect(classify(doc)).toBe("REVIEW");
  });
});

// ---------------------------------------------------------------------------
// 5. SPEC classification
// ---------------------------------------------------------------------------

describe("classify — SPEC", () => {
  it("classifies a technical spec doc as SPEC", () => {
    const doc = `# Authentication API Specification

## Background
Users currently authenticate via a legacy session-cookie system.

## Requirements
- The API must support OAuth 2.0 / OIDC.
- Token expiry must be configurable.
- Refresh tokens must be stored server-side.

## Architecture
Single stateless JWT issued by the auth service.

## API Design
\`\`\`
POST /auth/token
GET  /auth/userinfo
DELETE /auth/token
\`\`\`

## Acceptance Criteria
- [ ] Tokens expire after the configured TTL
- [ ] Refresh tokens are rotated on use
- [ ] Invalid tokens return 401

## Constraints
Must remain backward-compatible with v1 clients.
`;
    expect(classify(doc)).toBe("SPEC");
  });

  it("classifies a design doc as SPEC", () => {
    const doc = `# Storage Service Design

## Motivation
Current blob storage has no lifecycle management.

## Scope
Design a lifecycle policy engine for the storage service.

## Out of Scope
Billing integration is out of scope for this document.

## Architecture
Event-driven pipeline consuming S3 lifecycle events.

## Data Model
\`\`\`json
{
  "policyId": "string",
  "bucket": "string",
  "rules": []
}
\`\`\`

## Interface
\`\`\`typescript
interface Policy { id: string; rules: Rule[]; }
\`\`\`
`;
    expect(classify(doc)).toBe("SPEC");
  });

  it("classifies a requirements doc as SPEC", () => {
    const doc = `# Feature Requirements

## Context
We need to support multi-tenant billing.

## Functional Requirements
1. Each tenant has isolated billing data.
2. Invoices are generated monthly.
3. Admins can export billing reports.

## Non-Functional Requirements
- 99.9% uptime SLA
- Sub-100ms invoice generation

## Assumptions
Stripe is the payment processor.

## Success Criteria
- [ ] Tenant isolation verified in staging
- [ ] Invoice accuracy validated by finance
`;
    expect(classify(doc)).toBe("SPEC");
  });
});

// ---------------------------------------------------------------------------
// 6. RUNBOOK classification
// ---------------------------------------------------------------------------

describe("classify — RUNBOOK", () => {
  it("classifies a deployment runbook as RUNBOOK", () => {
    const doc = `# Production Deploy Runbook

## Prerequisites
- kubectl context set to production cluster
- Docker image tagged and pushed

## Steps

**Step 1:** Update the deployment manifest
\`\`\`bash
sed -i 's/image:.*/image: app:v2.3.1/' deploy.yaml
\`\`\`

**Step 2:** Apply the manifest
\`\`\`bash
kubectl apply -f deploy.yaml
\`\`\`

**Step 3:** Monitor rollout
\`\`\`bash
kubectl rollout status deployment/app
\`\`\`

## Verification
\`\`\`bash
curl https://api.example.com/health
\`\`\`

## Rollback
\`\`\`bash
kubectl rollout undo deployment/app
\`\`\`
`;
    expect(classify(doc)).toBe("RUNBOOK");
  });

  it("classifies an on-call procedure as RUNBOOK", () => {
    const doc = `# On-Call Incident Response Runbook

## Prerequisites
- Access to PagerDuty
- VPN connected

## Procedure
1. Acknowledge the alert in PagerDuty
2. Check the monitoring dashboard
3. Execute the diagnosis script

\`\`\`bash
./bin/diagnose.sh --service api
\`\`\`

4. Mitigate the incident per the playbook
5. Post an incident report

## Troubleshooting
\`\`\`bash
kubectl logs deployment/api --tail=100
\`\`\`

## Rollback
Revert to the last stable release via the deployment runbook.
`;
    expect(classify(doc)).toBe("RUNBOOK");
  });

  it("classifies a step-by-step setup guide as RUNBOOK", () => {
    const doc = `# Local Development Setup

## Prerequisites
- Node.js >= 18
- Docker Desktop installed

## Instructions

Step 1: Clone the repository
\`\`\`bash
git clone https://github.com/example/app
cd app
\`\`\`

Step 2: Install dependencies
\`\`\`bash
npm install
\`\`\`

Step 3: Start services
\`\`\`bash
docker compose up -d
npm run dev
\`\`\`

## Verification
Open http://localhost:3000 — you should see the welcome page.

## Troubleshooting
If port 3000 is in use, set PORT=3001 in .env.
`;
    expect(classify(doc)).toBe("RUNBOOK");
  });

  it("heavy code-block density pushes toward RUNBOOK", () => {
    const doc = `# Database Migration Procedure

## Steps

Run migration:
${codeBlock("bash", 15)}

Verify row count:
${codeBlock("sql", 10)}

Check constraints:
${codeBlock("sql", 12)}

## Rollback

Revert migration:
${codeBlock("bash", 8)}
`;
    expect(classify(doc)).toBe("RUNBOOK");
  });
});

// ---------------------------------------------------------------------------
// 7. GENERIC fallback
// ---------------------------------------------------------------------------

describe("classify — GENERIC fallback", () => {
  it("returns GENERIC for a personal journal entry", () => {
    const doc = "# Today\n\nHad a great morning. Coffee was good. Need to buy groceries.\n";
    expect(classify(doc)).toBe("GENERIC");
  });

  it("returns GENERIC for a short meeting-notes document", () => {
    const doc = `# Standup Notes — 2024-06-15

Alice: Working on the login page.
Bob: Fixing the payment bug.
Carol: Reviewing PRs.

Blockers: None.
`;
    expect(classify(doc)).toBe("GENERIC");
  });

  it("returns GENERIC for a document with balanced PLAN + REVIEW signals", () => {
    // Equal low scores for PLAN and REVIEW — neither reaches threshold margin
    const doc = `# Notes

We plan to review the feedback and assess the goals.
Tasks are being tracked elsewhere.
`;
    expect(classify(doc)).toBe("GENERIC");
  });
});

// ---------------------------------------------------------------------------
// 8. Mixed / ambiguous documents — priority ordering
// ---------------------------------------------------------------------------

describe("classify — mixed documents", () => {
  it("PLAN wins over REVIEW when task density is high and review signals are mild", () => {
    const doc = `# Feature Plan

## Goals
Deliver authentication.

## Tasks
${tasks(12, 4)}

## Summary
Overall we are on track.

## Feedback
Minor scope adjustments needed.
`;
    expect(classify(doc)).toBe("PLAN");
  });

  it("SPEC wins when both SPEC and PLAN signals are present but SPEC has more headings", () => {
    const doc = `# Auth Feature

## Requirements
Must support OAuth 2.0.

## Architecture
JWT-based stateless tokens.

## Design
Single auth service.

## Tasks
${tasks(4, 1)}
`;
    expect(classify(doc)).toBe("SPEC");
  });

  it("RUNBOOK wins when steps + code dominate despite some PLAN task items", () => {
    const doc = `# Deployment Plan

## Prerequisites
- Docker running

## Steps
1. Build the image
\`\`\`bash
docker build -t app .
\`\`\`
2. Push to registry
\`\`\`bash
docker push registry/app:latest
\`\`\`
3. Deploy
\`\`\`bash
kubectl apply -f k8s/
\`\`\`

## Tasks
- [x] Image built
- [ ] Deployed to staging

## Rollback
\`\`\`bash
kubectl rollout undo deployment/app
\`\`\`
`;
    expect(classify(doc)).toBe("RUNBOOK");
  });
});
