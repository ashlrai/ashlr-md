import { describe, expect, it } from "vitest";
import { parseRunbook } from "./runbook-renderer";

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

describe("parseRunbook — title extraction", () => {
  it("captures first h1 as document title", () => {
    const doc = "# Deploy Production\n\n## Steps\n1. Push the button\n";
    const r = parseRunbook(doc);
    expect(r.title).toBe("Deploy Production");
  });

  it("returns empty title when no h1 is present", () => {
    const doc = "## Steps\n1. Do something\n";
    const r = parseRunbook(doc);
    expect(r.title).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Prerequisites section
// ---------------------------------------------------------------------------

describe("parseRunbook — prerequisites", () => {
  it("extracts plain bullet prerequisites", () => {
    const doc = [
      "# Runbook",
      "",
      "## Prerequisites",
      "- Docker installed",
      "- Access to production VPN",
      "- Admin credentials",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.prerequisites).toHaveLength(3);
    expect(r.prerequisites[0].text).toBe("Docker installed");
    expect(r.prerequisites[0].done).toBe(false);
  });

  it("extracts checked task-item prerequisites", () => {
    const doc = [
      "## Prerequisites",
      "- [x] Repo cloned",
      "- [ ] Env vars configured",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.prerequisites[0].done).toBe(true);
    expect(r.prerequisites[1].done).toBe(false);
  });

  it("extracts ordered-list prerequisites as not-done", () => {
    const doc = [
      "## Prerequisites",
      "1. Install bun",
      "2. Configure secrets",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.prerequisites).toHaveLength(2);
    expect(r.prerequisites[0].text).toBe("Install bun");
    expect(r.prerequisites[0].done).toBe(false);
  });

  it("recognises 'Before You Begin' alias", () => {
    const doc = [
      "## Before You Begin",
      "- Have coffee",
      "- Check the calendar",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.prerequisites).toHaveLength(2);
  });

  it("returns empty prerequisites when section is absent", () => {
    const doc = "## Steps\n1. Deploy\n";
    const r = parseRunbook(doc);
    expect(r.prerequisites).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Steps section — ordered list
// ---------------------------------------------------------------------------

describe("parseRunbook — steps from ordered list", () => {
  it("parses ordered list items as steps", () => {
    const doc = [
      "# Runbook",
      "",
      "## Steps",
      "1. Run migrations",
      "2. Restart service",
      "3. Verify health",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.stepCount).toBe(3);
    expect(r.steps[0].title).toBe("Run migrations");
    expect(r.steps[1].title).toBe("Restart service");
    expect(r.steps[2].title).toBe("Verify health");
  });

  it("assigns sequential 1-based ids to steps", () => {
    const doc = "## Steps\n1. A\n2. B\n3. C\n";
    const r = parseRunbook(doc);
    expect(r.steps.map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it("recognises 'Procedure' section alias", () => {
    const doc = "## Procedure\n1. Step alpha\n2. Step beta\n";
    const r = parseRunbook(doc);
    expect(r.stepCount).toBe(2);
    expect(r.steps[0].title).toBe("Step alpha");
  });

  it("step body includes continuation lines after the list item", () => {
    const doc = [
      "## Steps",
      "1. Deploy the container",
      "   This may take a minute.",
      "   Watch the logs.",
      "2. Run smoke tests",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.steps[0].body).toContain("This may take a minute.");
  });
});

// ---------------------------------------------------------------------------
// Steps section — sub-headings (### Step N)
// ---------------------------------------------------------------------------

describe("parseRunbook — steps from sub-headings", () => {
  it("parses ### sub-headings as step titles", () => {
    const doc = [
      "## Steps",
      "### Step 1: Backup the database",
      "Run `pg_dump`.",
      "### Step 2: Apply migrations",
      "Run `db-migrate up`.",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.stepCount).toBe(2);
    expect(r.steps[0].title).toBe("Step 1: Backup the database");
    expect(r.steps[1].title).toBe("Step 2: Apply migrations");
  });

  it("parses **Step N:** bold leads as step delimiters", () => {
    const doc = [
      "## Steps",
      "**Step 1:** Configure environment",
      "Set up .env file.",
      "**Step 2:** Start services",
      "Run docker-compose up.",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.stepCount).toBe(2);
    expect(r.steps[0].title).toBe("Configure environment");
  });
});

// ---------------------------------------------------------------------------
// Code block extraction
// ---------------------------------------------------------------------------

describe("parseRunbook — code block extraction", () => {
  it("extracts shell commands from fenced code blocks in step body", () => {
    const doc = [
      "## Steps",
      "1. Run the migration script",
      "```bash",
      "bun run db:migrate",
      "```",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.steps[0].commands).toHaveLength(1);
    expect(r.steps[0].commands[0]).toBe("bun run db:migrate");
  });

  it("extracts multiple code blocks from a single step", () => {
    const doc = [
      "## Steps",
      "1. Two commands",
      "```sh",
      "echo 'first'",
      "```",
      "Some prose in between.",
      "```shell",
      "echo 'second'",
      "```",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.steps[0].commands).toHaveLength(2);
  });

  it("handles tilde-fenced code blocks", () => {
    const doc = [
      "## Steps",
      "1. Run something",
      "~~~bash",
      "kubectl apply -f deploy.yaml",
      "~~~",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.steps[0].commands[0]).toContain("kubectl apply");
  });

  it("ignores unclosed code block but captures partial content", () => {
    const doc = [
      "## Steps",
      "1. Deploy",
      "```bash",
      "kubectl rollout restart deployment/api",
    ].join("\n");
    const r = parseRunbook(doc);
    // Unclosed fence: partial content is still captured.
    expect(r.steps[0].commands).toHaveLength(1);
    expect(r.steps[0].commands[0]).toContain("kubectl rollout");
  });

  it("step with no code blocks has empty commands array", () => {
    const doc = "## Steps\n1. Just prose, no code\n";
    const r = parseRunbook(doc);
    expect(r.steps[0].commands).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Auxiliary sections
// ---------------------------------------------------------------------------

describe("parseRunbook — rollback / troubleshooting / verification", () => {
  it("captures ## Rollback section as raw markdown", () => {
    const doc = [
      "## Steps",
      "1. Deploy",
      "",
      "## Rollback",
      "Run `git revert HEAD` and redeploy.",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.rollback).toContain("git revert HEAD");
  });

  it("recognises 'Undo' as rollback alias", () => {
    const doc = "## Undo\nRevert the migration.\n";
    const r = parseRunbook(doc);
    expect(r.rollback).toContain("Revert the migration.");
  });

  it("captures ## Troubleshooting section", () => {
    const doc = "## Troubleshooting\nIf it fails, check the logs.\n";
    const r = parseRunbook(doc);
    expect(r.troubleshooting).toContain("check the logs");
  });

  it("captures ## Verification section", () => {
    const doc = "## Verification\nCurl the health endpoint.\n";
    const r = parseRunbook(doc);
    expect(r.verification).toContain("health endpoint");
  });

  it("captures 'Smoke Test' as verification alias", () => {
    const doc = "## Smoke Test\nCheck uptime is 200 OK.\n";
    const r = parseRunbook(doc);
    expect(r.verification).toContain("200 OK");
  });

  it("returns empty strings for absent auxiliary sections", () => {
    const doc = "## Steps\n1. Just this\n";
    const r = parseRunbook(doc);
    expect(r.rollback).toBe("");
    expect(r.troubleshooting).toBe("");
    expect(r.verification).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Frontmatter handling
// ---------------------------------------------------------------------------

describe("parseRunbook — frontmatter", () => {
  it("skips YAML frontmatter delimited by ---", () => {
    const doc = [
      "---",
      "kind: runbook",
      "owner: sre-team",
      "---",
      "# Deploy Runbook",
      "",
      "## Steps",
      "1. Release",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.title).toBe("Deploy Runbook");
    expect(r.stepCount).toBe(1);
  });

  it("skips frontmatter closed by ...", () => {
    const doc = [
      "---",
      "kind: runbook",
      "...",
      "# Title",
      "## Steps",
      "1. Go",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.title).toBe("Title");
    expect(r.stepCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Missing sections / empty input
// ---------------------------------------------------------------------------

describe("parseRunbook — missing sections and empty input", () => {
  it("returns empty result for empty string", () => {
    const r = parseRunbook("");
    expect(r.title).toBe("");
    expect(r.steps).toHaveLength(0);
    expect(r.prerequisites).toHaveLength(0);
    expect(r.stepCount).toBe(0);
  });

  it("returns zero stepCount for whitespace-only input", () => {
    const r = parseRunbook("   \n\n\t\n");
    expect(r.stepCount).toBe(0);
  });

  it("returns valid result for heading-only doc with no body", () => {
    const doc = "# Title\n\n## Steps";
    const r = parseRunbook(doc);
    expect(r.title).toBe("Title");
    expect(r.stepCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

describe("parseRunbook — malformed input", () => {
  it("handles broken frontmatter (unclosed ---) without throwing", () => {
    const doc = [
      "---",
      "kind: runbook",
      "## Steps",
      "1. Release",
    ].join("\n");
    expect(() => parseRunbook(doc)).not.toThrow();
    // Everything consumed as frontmatter — no steps.
    const r = parseRunbook(doc);
    expect(r.stepCount).toBe(0);
  });

  it("handles truncated ordered list (EOF mid-item) without throwing", () => {
    const doc = "## Steps\n1. Truncated";
    expect(() => parseRunbook(doc)).not.toThrow();
    const r = parseRunbook(doc);
    expect(r.stepCount).toBe(1);
    expect(r.steps[0].title).toBe("Truncated");
  });

  it("handles completely empty steps section", () => {
    const doc = "## Steps\n\n## Rollback\nRollback here.\n";
    const r = parseRunbook(doc);
    expect(r.stepCount).toBe(0);
    expect(r.rollback).toContain("Rollback here.");
  });

  it("handles steps followed directly by auxiliary section", () => {
    const doc = [
      "## Steps",
      "1. Deploy",
      "## Verification",
      "Check health.",
    ].join("\n");
    const r = parseRunbook(doc);
    expect(r.stepCount).toBe(1);
    expect(r.verification).toContain("Check health.");
  });
});
