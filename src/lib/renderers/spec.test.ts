import { describe, expect, it } from "vitest";
import { parseSpec } from "./spec-renderer";

// ---------------------------------------------------------------------------
// Basic section detection
// ---------------------------------------------------------------------------

describe("parseSpec — title extraction", () => {
  it("captures first h1 as document title", () => {
    const doc = "# My Spec\n\n## Goals\nDo things.\n";
    const r = parseSpec(doc);
    expect(r.title).toBe("My Spec");
  });

  it("returns empty title when no h1 present", () => {
    const doc = "## Goals\nDo things.\n";
    const r = parseSpec(doc);
    expect(r.title).toBe("");
  });

  it("uses only the first h1 (ignores subsequent h1s)", () => {
    const doc = "# First\n# Second\n## Goals\ntext\n";
    const r = parseSpec(doc);
    expect(r.title).toBe("First");
  });
});

// ---------------------------------------------------------------------------
// Canonical spec headings
// ---------------------------------------------------------------------------

describe("parseSpec — ## Goals / ## Approach / ## Unknowns detection", () => {
  it("parses ## Goals heading into sections", () => {
    const doc = [
      "# Spec",
      "",
      "## Goals",
      "- Build the thing",
      "- Ship it fast",
    ].join("\n");
    const r = parseSpec(doc);
    const goalsSection = r.sections.find(
      (s) => s.title.toLowerCase() === "goals",
    );
    expect(goalsSection).toBeDefined();
    expect(goalsSection?.body).toContain("Build the thing");
  });

  it("parses ## Approach (mapped to Overview/Background region) — not in SPEC_SECTION_TITLES, so body is not captured as a section but document is still returned", () => {
    // "approach" is not in SPEC_SECTION_TITLES — the parser skips unknown headings.
    // Verify the parser still returns a valid ParsedSpec without throwing.
    const doc = [
      "# Spec",
      "",
      "## Approach",
      "Use event sourcing.",
      "",
      "## Goals",
      "Be fast.",
    ].join("\n");
    const r = parseSpec(doc);
    expect(r).toBeDefined();
    expect(r.title).toBe("Spec");
    // Goals IS a known heading and should be captured.
    const goals = r.sections.find((s) => s.title.toLowerCase() === "goals");
    expect(goals).toBeDefined();
  });

  it("parses ## Unknowns via 'open questions' alias", () => {
    const doc = [
      "# Spec",
      "",
      "## Open Questions",
      "- How do we handle auth?",
    ].join("\n");
    const r = parseSpec(doc);
    const section = r.sections.find((s) =>
      s.title.toLowerCase().includes("open question"),
    );
    expect(section).toBeDefined();
    expect(section?.body).toContain("How do we handle auth?");
  });

  it("is case-insensitive for section titles", () => {
    const doc = "# S\n\n## GOALS\nbody\n";
    const r = parseSpec(doc);
    const s = r.sections.find((s) => s.title === "GOALS");
    expect(s).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// All canonical SPEC_SECTION_TITLES
// ---------------------------------------------------------------------------

describe("parseSpec — all canonical spec sections", () => {
  const knownHeadings = [
    "Requirements",
    "Design",
    "Implementation",
    "Architecture",
    "API Design",
    "Interface Spec",
    "Overview",
    "Background",
    "Motivation",
    "Goals",
    "Non-Goals",
    "Open Questions",
  ];

  for (const heading of knownHeadings) {
    it(`captures '## ${heading}' as a section`, () => {
      const doc = `# Title\n\n## ${heading}\nsome body text\n`;
      const r = parseSpec(doc);
      expect(r.sections.some((s) => s.title === heading)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Acceptance criteria parsing
// ---------------------------------------------------------------------------

describe("parseSpec — acceptance criteria", () => {
  it("extracts unchecked criteria items", () => {
    const doc = [
      "# Spec",
      "",
      "## Acceptance Criteria",
      "- [ ] First criterion",
      "- [ ] Second criterion",
    ].join("\n");
    const r = parseSpec(doc);
    expect(r.criteriaTotal).toBe(2);
    expect(r.criteriaDone).toBe(0);
    expect(r.criteria[0].text).toBe("First criterion");
    expect(r.criteria[0].done).toBe(false);
  });

  it("extracts checked criteria items with done=true", () => {
    const doc = [
      "## Acceptance Criteria",
      "- [x] Done item",
      "- [X] Also done",
      "- [ ] Not done",
    ].join("\n");
    const r = parseSpec(doc);
    expect(r.criteriaDone).toBe(2);
    expect(r.criteriaTotal).toBe(3);
  });

  it("records 1-based line numbers for criteria", () => {
    const doc = [
      "## Acceptance Criteria", // line 1
      "- [ ] First",             // line 2
      "- [x] Second",            // line 3
    ].join("\n");
    const r = parseSpec(doc);
    expect(r.criteria[0].line).toBe(2);
    expect(r.criteria[1].line).toBe(3);
  });

  it("recognises 'Success Criteria' alias", () => {
    const doc = "## Success Criteria\n- [x] shipped\n";
    const r = parseSpec(doc);
    expect(r.criteriaTotal).toBe(1);
    expect(r.criteriaDone).toBe(1);
  });

  it("recognises 'Definition of Done' alias", () => {
    const doc = "## Definition of Done\n- [ ] tests pass\n- [ ] reviewed\n";
    const r = parseSpec(doc);
    expect(r.criteriaTotal).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter handling (plan badges / YAML)
// ---------------------------------------------------------------------------

describe("parseSpec — frontmatter / plan badge stripping", () => {
  it("skips YAML frontmatter delimited by ---", () => {
    const doc = [
      "---",
      "title: hidden title",
      "status: draft",
      "---",
      "# Real Title",
      "",
      "## Goals",
      "Actual goals text.",
    ].join("\n");
    const r = parseSpec(doc);
    expect(r.title).toBe("Real Title");
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].body).toContain("Actual goals text.");
  });

  it("skips frontmatter closed by ... (YAML document-end marker)", () => {
    const doc = [
      "---",
      "kind: spec",
      "...",
      "# Title",
      "## Background",
      "text",
    ].join("\n");
    const r = parseSpec(doc);
    expect(r.title).toBe("Title");
    const bg = r.sections.find((s) => s.title === "Background");
    expect(bg).toBeDefined();
  });

  it("does not treat frontmatter content as criteria even if it looks like tasks", () => {
    const doc = [
      "---",
      "- [ ] not a criterion",
      "---",
      "## Acceptance Criteria",
      "- [x] real criterion",
    ].join("\n");
    const r = parseSpec(doc);
    expect(r.criteriaTotal).toBe(1);
    expect(r.criteria[0].text).toBe("real criterion");
  });
});

// ---------------------------------------------------------------------------
// Missing sections — graceful handling
// ---------------------------------------------------------------------------

describe("parseSpec — missing sections", () => {
  it("returns empty sections array for plain prose doc", () => {
    const doc =
      "# Title\n\nJust some prose. No spec headings here.\n\nAnother paragraph.\n";
    const r = parseSpec(doc);
    expect(r.sections).toHaveLength(0);
    expect(r.criteria).toHaveLength(0);
    expect(r.criteriaTotal).toBe(0);
    expect(r.criteriaDone).toBe(0);
  });

  it("returns empty sections and criteria for completely empty input", () => {
    const r = parseSpec("");
    expect(r.title).toBe("");
    expect(r.sections).toHaveLength(0);
    expect(r.criteria).toHaveLength(0);
  });

  it("handles whitespace-only input without throwing", () => {
    expect(() => parseSpec("   \n  \n\t\n")).not.toThrow();
  });

  it("returns valid ParsedSpec with only a title and no sections", () => {
    const r = parseSpec("# Just a Title\n\nSome prose.\n");
    expect(r.title).toBe("Just a Title");
    expect(r.sections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Malformed / edge-case input
// ---------------------------------------------------------------------------

describe("parseSpec — malformed input", () => {
  it("handles broken frontmatter (only opening ---) without throwing", () => {
    const doc = [
      "---",
      "title: unclosed",
      "# Heading inside unclosed frontmatter",
      "## Goals",
      "body",
    ].join("\n");
    // Should not throw; frontmatter is never closed so everything is skipped.
    expect(() => parseSpec(doc)).not.toThrow();
    const r = parseSpec(doc);
    // Since frontmatter never closes, the body is treated as frontmatter.
    expect(r.sections).toHaveLength(0);
  });

  it("handles truncated list (list item at EOF with no newline)", () => {
    const doc = "## Acceptance Criteria\n- [ ] truncated item";
    const r = parseSpec(doc);
    expect(r.criteriaTotal).toBe(1);
    expect(r.criteria[0].text).toBe("truncated item");
  });

  it("handles a section heading at EOF with no body", () => {
    const doc = "# Title\n\n## Goals";
    const r = parseSpec(doc);
    const goals = r.sections.find((s) => s.title === "Goals");
    expect(goals).toBeDefined();
    expect(goals?.body).toBe("");
  });

  it("ignores headings deeper than level 3 as top-level spec sections", () => {
    const doc = "#### Goals\nbody\n";
    const r = parseSpec(doc);
    // Level 4 heading should NOT create a section (level <= 3 check in source).
    expect(r.sections).toHaveLength(0);
  });

  it("captures h2 section body correctly with multiple paragraphs", () => {
    const doc = [
      "# Doc",
      "",
      "## Requirements",
      "First paragraph.",
      "",
      "Second paragraph.",
    ].join("\n");
    const r = parseSpec(doc);
    const req = r.sections.find((s) => s.title === "Requirements");
    expect(req?.body).toContain("First paragraph.");
    expect(req?.body).toContain("Second paragraph.");
  });

  it("records correct line numbers for sections", () => {
    const doc = [
      "# Title",   // line 1
      "",          // line 2
      "## Goals",  // line 3
      "body",      // line 4
    ].join("\n");
    const r = parseSpec(doc);
    const goals = r.sections.find((s) => s.title === "Goals");
    expect(goals?.line).toBe(3);
  });

  it("multiple spec sections in one document are all captured", () => {
    const doc = [
      "# Doc",
      "## Goals",
      "g",
      "## Requirements",
      "r",
      "## Design",
      "d",
    ].join("\n");
    const r = parseSpec(doc);
    expect(r.sections.length).toBeGreaterThanOrEqual(3);
  });
});
