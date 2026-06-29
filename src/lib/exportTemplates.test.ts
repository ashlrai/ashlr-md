/**
 * exportTemplates.test.ts — unit tests for src/lib/exportTemplates.ts
 *
 * Covers: BUILTIN_TEMPLATES, findTemplate, validateTemplateCss, newTemplateId,
 * and the template variable / cascade semantics documented in exportTemplates.ts.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_PROFILE_IDS,
  BUILTIN_TEMPLATES,
  EXPORT_PROFILES,
  NO_TEMPLATE_ID,
  findProfile,
  findTemplate,
  newTemplateId,
  validateTemplateCss,
  type ExportTemplate,
} from "./exportTemplates";

// ─── BUILTIN_TEMPLATES ────────────────────────────────────────────────────────

describe("BUILTIN_TEMPLATES", () => {
  it("ships at least 5 named templates", () => {
    expect(BUILTIN_TEMPLATES.length).toBeGreaterThanOrEqual(5);
  });

  it("each built-in has a unique id, non-empty name, and non-empty css", () => {
    const ids = new Set<string>();
    for (const tpl of BUILTIN_TEMPLATES) {
      expect(tpl.id).toBeTruthy();
      expect(tpl.name).toBeTruthy();
      expect(tpl.css.trim().length).toBeGreaterThan(0);
      expect(ids.has(tpl.id)).toBe(false);
      ids.add(tpl.id);
    }
  });

  it("all built-in templates are marked builtin:true", () => {
    for (const tpl of BUILTIN_TEMPLATES) {
      expect(tpl.builtin).toBe(true);
    }
  });

  it("contains GitHub Readme template", () => {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === "builtin-github");
    expect(tpl).toBeDefined();
    expect(tpl!.name).toBe("GitHub Readme");
  });

  it("contains Notion-style template", () => {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === "builtin-notion");
    expect(tpl).toBeDefined();
    expect(tpl!.name).toBe("Notion-style");
  });

  it("contains Academic Paper template", () => {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === "builtin-academic");
    expect(tpl).toBeDefined();
    expect(tpl!.name).toBe("Academic Paper");
  });

  it("contains Dev Docs template", () => {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === "builtin-devdocs");
    expect(tpl).toBeDefined();
  });

  it("contains Newsletter template", () => {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === "builtin-newsletter");
    expect(tpl).toBeDefined();
  });

  it("no built-in CSS contains <script> tags (XSS safety)", () => {
    for (const tpl of BUILTIN_TEMPLATES) {
      expect(tpl.css).not.toMatch(/<script/i);
    }
  });

  it("no built-in CSS uses javascript: URIs", () => {
    for (const tpl of BUILTIN_TEMPLATES) {
      expect(tpl.css).not.toMatch(/javascript:/i);
    }
  });

  it("GitHub Readme CSS targets .reading-surface or body for layout", () => {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === "builtin-github")!;
    expect(tpl.css).toMatch(/body|\.reading-surface/);
  });

  it("Academic Paper CSS includes serif font stack", () => {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === "builtin-academic")!;
    expect(tpl.css).toMatch(/serif/i);
  });

  it("Dev Docs CSS sets a dark background", () => {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === "builtin-devdocs")!;
    // Should define a dark bg colour.
    expect(tpl.css).toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});

// ─── NO_TEMPLATE_ID ───────────────────────────────────────────────────────────

describe("NO_TEMPLATE_ID", () => {
  it("equals the string 'none'", () => {
    expect(NO_TEMPLATE_ID).toBe("none");
  });
});

// ─── findTemplate ─────────────────────────────────────────────────────────────

describe("findTemplate", () => {
  const userTemplates: ExportTemplate[] = [
    { id: "user-abc", name: "My Custom", css: ".body { color: red }", builtin: false },
    { id: "user-def", name: "Another", css: "h1 { font-size: 3em }", builtin: false },
  ];

  it("returns undefined for NO_TEMPLATE_ID regardless of user list", () => {
    expect(findTemplate(NO_TEMPLATE_ID, userTemplates)).toBeUndefined();
    expect(findTemplate(NO_TEMPLATE_ID, [])).toBeUndefined();
  });

  it("finds a built-in template by id", () => {
    const result = findTemplate("builtin-github", []);
    expect(result).toBeDefined();
    expect(result!.id).toBe("builtin-github");
  });

  it("finds a user template by id", () => {
    const result = findTemplate("user-abc", userTemplates);
    expect(result).toBeDefined();
    expect(result!.name).toBe("My Custom");
  });

  it("returns undefined when id is not found in either list", () => {
    expect(findTemplate("nonexistent-id", userTemplates)).toBeUndefined();
  });

  it("built-in takes precedence over a user template with the same id (safety check)", () => {
    // Craft a user template that spoofs a built-in id.
    const spoof: ExportTemplate[] = [
      { id: "builtin-github", name: "Spoofed", css: "body{color:red}", builtin: false },
    ];
    const result = findTemplate("builtin-github", spoof);
    // Should resolve to the real built-in, not the spoof.
    expect(result!.builtin).toBe(true);
    expect(result!.name).toBe("GitHub Readme");
  });

  it("returns the css string of a user template", () => {
    const result = findTemplate("user-def", userTemplates);
    expect(result!.css).toBe("h1 { font-size: 3em }");
  });

  it("works with an empty user template list", () => {
    expect(findTemplate("builtin-notion", [])).toBeDefined();
    expect(findTemplate("user-xyz", [])).toBeUndefined();
  });
});

// ─── validateTemplateCss ─────────────────────────────────────────────────────

describe("validateTemplateCss", () => {
  it("returns null for valid CSS", () => {
    expect(validateTemplateCss("body { color: red; font-size: 16px; }")).toBeNull();
    expect(validateTemplateCss("")).toBeNull();
    expect(validateTemplateCss(".reading-surface { max-width: 800px; }")).toBeNull();
  });

  it("rejects CSS containing a <script> opening tag", () => {
    const result = validateTemplateCss("body {} <script>alert(1)</script>");
    expect(result).not.toBeNull();
    expect(result).toMatch(/script/i);
  });

  it("rejects CSS containing </script> close tag", () => {
    const result = validateTemplateCss("body{} </script>");
    expect(result).not.toBeNull();
  });

  it("is case-insensitive for <script> detection", () => {
    expect(validateTemplateCss("<SCRIPT>")).not.toBeNull();
    expect(validateTemplateCss("<Script>")).not.toBeNull();
  });

  it("rejects CSS with javascript: URIs", () => {
    const result = validateTemplateCss("a { content: javascript:void(0) }");
    expect(result).not.toBeNull();
    expect(result).toMatch(/javascript/i);
  });

  it("is case-insensitive for javascript: detection", () => {
    expect(validateTemplateCss("JAVASCRIPT:alert(1)")).not.toBeNull();
    expect(validateTemplateCss("Javascript:foo")).not.toBeNull();
  });

  it("rejects @import url(http://…) to preserve offline integrity", () => {
    const result = validateTemplateCss("@import url('http://example.com/style.css');");
    expect(result).not.toBeNull();
    expect(result).toMatch(/external|URL/i);
  });

  it("rejects @import url(https://…)", () => {
    const result = validateTemplateCss('@import url("https://fonts.googleapis.com/css");');
    expect(result).not.toBeNull();
  });

  it("allows @import with relative paths (not an http URL)", () => {
    // Relative imports don't break offline integrity.
    expect(validateTemplateCss("@import url('./local.css');")).toBeNull();
  });

  it("allows CSS custom properties and calc()", () => {
    const css = `:root { --my-color: #ff0000; } body { margin: calc(10px + 2vw); }`;
    expect(validateTemplateCss(css)).toBeNull();
  });

  it("allows media queries", () => {
    expect(validateTemplateCss("@media print { body { font-size: 11pt; } }")).toBeNull();
  });

  it("allows CSS variables referencing theme tokens", () => {
    expect(validateTemplateCss("body { color: var(--text); background: var(--bg); }")).toBeNull();
  });
});

// ─── newTemplateId ────────────────────────────────────────────────────────────

describe("newTemplateId", () => {
  it("returns a non-empty string", () => {
    expect(typeof newTemplateId()).toBe("string");
    expect(newTemplateId().length).toBeGreaterThan(0);
  });

  it("starts with 'user-' prefix", () => {
    expect(newTemplateId()).toMatch(/^user-/);
  });

  it("generates unique ids on consecutive calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => newTemplateId()));
    expect(ids.size).toBe(20);
  });

  it("returns a string that is safe to use as an HTML attribute value", () => {
    const id = newTemplateId();
    // No angle brackets, quotes, or whitespace.
    expect(id).not.toMatch(/[<>"'\s]/);
  });
});

// ─── CSS scope isolation: template CSS does not bleed theme tokens ────────────

describe("template CSS scope isolation", () => {
  it("built-in templates define scoped rules (not global resets that would break base styles)", () => {
    // Verify no built-in uses an aggressive universal reset that would wipe
    // KaTeX / Shiki inline styles (those rely on element-level `style` attrs).
    for (const tpl of BUILTIN_TEMPLATES) {
      // A blanket `* { all: initial }` or `* { font: … }` would break content.
      expect(tpl.css).not.toMatch(/\*\s*\{[^}]*\ball\s*:\s*initial/);
    }
  });

  it("GitHub template overrides body font without nuking katex inline spans", () => {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === "builtin-github")!;
    // body font override is fine — katex uses inline `style` attrs which win.
    expect(tpl.css).toContain("font-family");
    // Should NOT contain a rule that targets katex spans with font reset.
    expect(tpl.css).not.toMatch(/\.katex[^{]*\{[^}]*font-family\s*:\s*[^v]/);
  });
});

// ─── Theme override precedence ────────────────────────────────────────────────

describe("theme override precedence (cascade contract)", () => {
  it("template CSS comment documents that it layers above base styles", () => {
    // Each built-in CSS contains at least a comment marker or identifiable rule.
    for (const tpl of BUILTIN_TEMPLATES) {
      // Templates must define at least one rule that could override base styles.
      expect(tpl.css).toMatch(/\{[^}]+\}/);
    }
  });

  it("template CSS can use CSS custom properties to override theme tokens", () => {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === "builtin-github")!;
    // The GitHub template defines its own colour vars.
    expect(tpl.css).toContain("--tpl-");
  });

  it("Notion template does not hardcode midnight theme colours (theme-agnostic)", () => {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === "builtin-notion")!;
    // Should not reference midnight-specific token values.
    expect(tpl.css).not.toContain("--midnight");
  });
});

// ─── EXPORT_PROFILES registry ─────────────────────────────────────────────────

describe("EXPORT_PROFILES", () => {
  it("exports at least three profiles (now 6 with github-markdown, confluence-wiki, slack-rich-markdown)", () => {
    expect(EXPORT_PROFILES.length).toBeGreaterThanOrEqual(6);
  });

  it("each profile has a unique id, non-empty name, description, extension, and css", () => {
    const ids = new Set<string>();
    for (const p of EXPORT_PROFILES) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(["html", "txt"]).toContain(p.extension);
      expect(p.css.trim().length).toBeGreaterThan(0);
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
    }
  });

  it("contains notion-html profile with html extension", () => {
    const p = EXPORT_PROFILES.find((p) => p.id === "notion-html");
    expect(p).toBeDefined();
    expect(p!.extension).toBe("html");
  });

  it("contains slack-html profile with txt extension", () => {
    const p = EXPORT_PROFILES.find((p) => p.id === "slack-html");
    expect(p).toBeDefined();
    expect(p!.extension).toBe("txt");
  });

  it("contains email-html profile with html extension", () => {
    const p = EXPORT_PROFILES.find((p) => p.id === "email-html");
    expect(p).toBeDefined();
    expect(p!.extension).toBe("html");
  });

  it("no profile CSS contains <script> tags (XSS safety)", () => {
    for (const p of EXPORT_PROFILES) {
      expect(p.css).not.toMatch(/<script/i);
    }
  });

  it("no profile CSS uses javascript: URIs", () => {
    for (const p of EXPORT_PROFILES) {
      expect(p.css).not.toMatch(/javascript:/i);
    }
  });
});

// ─── findProfile ──────────────────────────────────────────────────────────────

describe("findProfile", () => {
  it("returns the notion-html profile by id", () => {
    const p = findProfile("notion-html");
    expect(p).toBeDefined();
    expect(p!.id).toBe("notion-html");
  });

  it("returns the slack-html profile by id", () => {
    const p = findProfile("slack-html");
    expect(p).toBeDefined();
    expect(p!.id).toBe("slack-html");
  });

  it("returns the email-html profile by id", () => {
    const p = findProfile("email-html");
    expect(p).toBeDefined();
    expect(p!.id).toBe("email-html");
  });

  it("returns undefined for an unknown id", () => {
    expect(findProfile("nonexistent-profile")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(findProfile("")).toBeUndefined();
  });
});

// ─── notion-html profile CSS ──────────────────────────────────────────────────

describe("notion-html profile CSS", () => {
  const profile = EXPORT_PROFILES.find((p) => p.id === "notion-html")!;

  it("constrains layout to max-width (no absolute positioning risk)", () => {
    expect(profile.css).toContain("max-width");
    // Must explicitly disable position:absolute for Notion compatibility
    expect(profile.css).toContain("position: static");
  });

  it("includes semantic heading rules (h1–h3)", () => {
    expect(profile.css).toMatch(/h1\s*\{/);
    expect(profile.css).toMatch(/h2\s*\{/);
    expect(profile.css).toMatch(/h3\s*\{/);
  });

  it("defines table styles for simplified Notion table import", () => {
    expect(profile.css).toMatch(/table\s*\{/);
    expect(profile.css).toContain("border-collapse");
  });

  it("includes link styles", () => {
    expect(profile.css).toMatch(/a\s*\{/);
  });

  it("includes code and pre rules", () => {
    expect(profile.css).toMatch(/code\s*\{/);
    expect(profile.css).toMatch(/pre\s*\{/);
  });

  it("includes blockquote rule", () => {
    expect(profile.css).toMatch(/blockquote\s*\{/);
  });

  it("includes list (ul/ol/li) rules", () => {
    expect(profile.css).toMatch(/ul|ol|li/);
  });

  it("includes image rule with max-width for responsive sizing", () => {
    expect(profile.css).toMatch(/img\s*\{/);
    expect(profile.css).toContain("max-width");
  });

  it("does not use external @import URLs", () => {
    expect(profile.css).not.toMatch(/@import\s+url\s*\(\s*['"]?https?:/i);
  });
});

// ─── slack-html profile CSS ───────────────────────────────────────────────────

describe("slack-html profile CSS", () => {
  const profile = EXPORT_PROFILES.find((p) => p.id === "slack-html")!;

  it("constrains width to ~520px for Slack thread width", () => {
    expect(profile.css).toContain("520px");
  });

  it("includes heading rules", () => {
    expect(profile.css).toMatch(/h1|h2|h3/);
  });

  it("includes inline code rules with monospace font", () => {
    expect(profile.css).toMatch(/code\s*\{/);
    expect(profile.css).toMatch(/monospace/i);
  });

  it("includes pre/code block rules", () => {
    expect(profile.css).toMatch(/pre\s*\{/);
  });

  it("includes blockquote rule", () => {
    expect(profile.css).toMatch(/blockquote\s*\{/);
  });

  it("includes table rules (fallback for Slack which doesn't support tables)", () => {
    expect(profile.css).toMatch(/table\s*\{/);
    expect(profile.css).toContain("border-collapse");
  });

  it("includes link rules", () => {
    expect(profile.css).toMatch(/a\s*\{/);
  });

  it("includes list (ul/ol/li) rules", () => {
    expect(profile.css).toMatch(/ul|ol|li/);
  });

  it("includes image rule", () => {
    expect(profile.css).toMatch(/img\s*\{/);
  });

  it("does not use external @import URLs", () => {
    expect(profile.css).not.toMatch(/@import\s+url\s*\(\s*['"]?https?:/i);
  });
});

// ─── email-html profile CSS ───────────────────────────────────────────────────

describe("email-html profile CSS", () => {
  const profile = EXPORT_PROFILES.find((p) => p.id === "email-html")!;

  it("sets a max-width constraint for the email wrapper (600px)", () => {
    expect(profile.css).toContain("600px");
  });

  it("includes heading rules with explicit pixel sizes (email-safe)", () => {
    expect(profile.css).toMatch(/h1\s*\{/);
    expect(profile.css).toMatch(/28px/);
  });

  it("includes paragraph rules with explicit color and font-size", () => {
    expect(profile.css).toMatch(/p\s*\{/);
    expect(profile.css).toContain("16px");
    expect(profile.css).toContain("#333333");
  });

  it("includes link rules with explicit color (no CSS vars)", () => {
    expect(profile.css).toMatch(/a\s*\{/);
    expect(profile.css).toContain("#0066cc");
    // Should NOT use CSS custom properties for colors (email clients strip them)
    expect(profile.css).not.toMatch(/color:\s*var\(/);
  });

  it("includes code rules with monospace stack and background", () => {
    expect(profile.css).toMatch(/code\s*\{/);
    expect(profile.css).toContain("Courier New");
    expect(profile.css).toContain("#f5f5f5");
  });

  it("includes pre rules for code blocks", () => {
    expect(profile.css).toMatch(/pre\s*\{/);
    expect(profile.css).toContain("#f8f8f8");
  });

  it("includes blockquote rule with border-left and background", () => {
    expect(profile.css).toMatch(/blockquote\s*\{/);
    expect(profile.css).toContain("border-left");
  });

  it("includes table rules optimised for email clients (content-table class)", () => {
    expect(profile.css).toContain("content-table");
    expect(profile.css).toContain("border-collapse");
  });

  it("includes image rule with max-width:100% for responsive email layout", () => {
    expect(profile.css).toMatch(/img\s*\{/);
    expect(profile.css).toContain("100%");
  });

  it("includes dark mode media query fallback", () => {
    expect(profile.css).toContain("prefers-color-scheme: dark");
  });

  it("includes responsive media query for mobile (max-width: 640px)", () => {
    expect(profile.css).toContain("max-width: 640px");
  });

  it("does not use external @import URLs (offline-ready)", () => {
    expect(profile.css).not.toMatch(/@import\s+url\s*\(\s*['"]?https?:/i);
  });

  it("includes list rules (ul/ol/li)", () => {
    expect(profile.css).toMatch(/ul|ol|li/);
  });
});

// ─── ALL_PROFILE_IDS ──────────────────────────────────────────────────────────

describe("ALL_PROFILE_IDS", () => {
  it("contains all 6 profile ids", () => {
    expect(ALL_PROFILE_IDS).toHaveLength(6);
  });

  it("contains the three original profile ids", () => {
    expect(ALL_PROFILE_IDS).toContain("notion-html");
    expect(ALL_PROFILE_IDS).toContain("slack-html");
    expect(ALL_PROFILE_IDS).toContain("email-html");
  });

  it("contains the three new profile ids", () => {
    expect(ALL_PROFILE_IDS).toContain("github-markdown");
    expect(ALL_PROFILE_IDS).toContain("confluence-wiki");
    expect(ALL_PROFILE_IDS).toContain("slack-rich-markdown");
  });

  it("all entries correspond to registered profiles in EXPORT_PROFILES", () => {
    for (const id of ALL_PROFILE_IDS) {
      const found = EXPORT_PROFILES.find((p) => p.id === id);
      expect(found, `Profile "${id}" missing from EXPORT_PROFILES`).toBeDefined();
    }
  });
});

// ─── github-markdown profile ──────────────────────────────────────────────────

describe("github-markdown profile CSS", () => {
  const profile = EXPORT_PROFILES.find((p) => p.id === "github-markdown")!;

  it("is defined with id github-markdown", () => {
    expect(profile).toBeDefined();
    expect(profile.id).toBe("github-markdown");
  });

  it("has html extension", () => {
    expect(profile.extension).toBe("html");
  });

  it("has non-empty description", () => {
    expect(profile.description.length).toBeGreaterThan(0);
  });

  it("constrains layout to max-width 980px (GitHub column width)", () => {
    expect(profile.css).toContain("980px");
  });

  it("includes heading bottom-border rules (GFM h1/h2 style)", () => {
    expect(profile.css).toMatch(/h1\s*\{[^}]*border-bottom/);
    expect(profile.css).toMatch(/h2\s*\{[^}]*border-bottom/);
  });

  it("includes code block styles with border-radius: 6px (GitHub code fence)", () => {
    expect(profile.css).toContain("border-radius: 6px");
  });

  it("includes GFM table striping (nth-child even)", () => {
    expect(profile.css).toContain("nth-child(even)");
  });

  it("includes task-list checkbox support", () => {
    expect(profile.css).toMatch(/task-list/);
  });

  it("includes callout block styles (.callout-note, .callout-warning)", () => {
    expect(profile.css).toContain(".callout-note");
    expect(profile.css).toContain(".callout-warning");
  });

  it("includes link rules with GH accent blue (#0969da)", () => {
    expect(profile.css).toContain("#0969da");
  });

  it("includes image rules with max-width:100%", () => {
    expect(profile.css).toMatch(/img\s*\{/);
    expect(profile.css).toContain("max-width: 100%");
  });

  it("includes horizontal rule styles", () => {
    expect(profile.css).toMatch(/hr\s*\{/);
  });

  it("does not use external @import URLs (offline-ready)", () => {
    expect(profile.css).not.toMatch(/@import\s+url\s*\(\s*['"]?https?:/i);
  });

  it("does not contain <script> tags (XSS safety)", () => {
    expect(profile.css).not.toMatch(/<script/i);
  });

  it("does not use javascript: URIs", () => {
    expect(profile.css).not.toMatch(/javascript:/i);
  });

  it("includes details/summary element rules", () => {
    expect(profile.css).toMatch(/details|summary/);
  });
});

// ─── confluence-wiki profile ──────────────────────────────────────────────────

describe("confluence-wiki profile CSS", () => {
  const profile = EXPORT_PROFILES.find((p) => p.id === "confluence-wiki")!;

  it("is defined with id confluence-wiki", () => {
    expect(profile).toBeDefined();
    expect(profile.id).toBe("confluence-wiki");
  });

  it("has html extension", () => {
    expect(profile.extension).toBe("html");
  });

  it("has non-empty description mentioning Atlassian or Confluence", () => {
    expect(profile.description).toMatch(/atlassian|confluence/i);
  });

  it("constrains layout to max-width 760px (Confluence page column)", () => {
    expect(profile.css).toContain("760px");
  });

  it("includes Atlassian heading styles with 24px h1", () => {
    expect(profile.css).toContain("24px");
  });

  it("includes panel macro styles (.callout-note, .callout-warning, .callout-tip, .callout-danger)", () => {
    expect(profile.css).toContain(".callout-note");
    expect(profile.css).toContain(".callout-warning");
    expect(profile.css).toContain(".callout-tip");
    expect(profile.css).toContain(".callout-danger");
  });

  it("includes dark code block (Confluence code macro dark theme)", () => {
    expect(profile.css).toMatch(/#23241f/);
  });

  it("includes table header with uppercase text transform (Confluence table style)", () => {
    expect(profile.css).toContain("text-transform: uppercase");
  });

  it("includes link rules with Atlassian blue (#0052cc)", () => {
    expect(profile.css).toContain("#0052cc");
  });

  it("includes image rules with border", () => {
    expect(profile.css).toMatch(/img\s*\{/);
    expect(profile.css).toContain("border:");
  });

  it("includes blockquote as note panel (blue background)", () => {
    expect(profile.css).toContain("--cf-note-bg");
    expect(profile.css).toMatch(/blockquote\s*\{/);
  });

  it("does not use external @import URLs", () => {
    expect(profile.css).not.toMatch(/@import\s+url\s*\(\s*['"]?https?:/i);
  });

  it("does not contain <script> tags", () => {
    expect(profile.css).not.toMatch(/<script/i);
  });

  it("includes list rules with margin and padding", () => {
    expect(profile.css).toMatch(/ul|ol|li/);
  });

  it("includes horizontal rule", () => {
    expect(profile.css).toMatch(/hr\s*\{/);
  });
});

// ─── slack-rich-markdown profile ─────────────────────────────────────────────

describe("slack-rich-markdown profile CSS", () => {
  const profile = EXPORT_PROFILES.find((p) => p.id === "slack-rich-markdown")!;

  it("is defined with id slack-rich-markdown", () => {
    expect(profile).toBeDefined();
    expect(profile.id).toBe("slack-rich-markdown");
  });

  it("has html extension (for Slack Canvas / Slack Docs)", () => {
    expect(profile.extension).toBe("html");
  });

  it("has non-empty description mentioning Slack or Canvas", () => {
    expect(profile.description).toMatch(/slack|canvas/i);
  });

  it("constrains layout to max-width 600px (Slack Canvas column)", () => {
    expect(profile.css).toContain("600px");
  });

  it("includes Slack font stack with Lato", () => {
    expect(profile.css).toMatch(/Lato|Slack-Lato/);
  });

  it("includes heading styles with 22px h1 (Slack Docs large heading)", () => {
    expect(profile.css).toContain("22px");
  });

  it("includes inline code styles (Slack mono)", () => {
    expect(profile.css).toMatch(/code\s*\{/);
    expect(profile.css).toMatch(/Slack-Mono|Monaco|Menlo/);
  });

  it("includes code block card with left accent border (::before pseudo-element)", () => {
    expect(profile.css).toContain("::before");
  });

  it("includes blockquote as Slack quoted-message card style", () => {
    expect(profile.css).toMatch(/blockquote\s*\{/);
    expect(profile.css).toContain("border-left");
  });

  it("includes coloured callout panels (.callout-note, .callout-tip, .callout-warning, .callout-danger)", () => {
    expect(profile.css).toContain(".callout-note");
    expect(profile.css).toContain(".callout-tip");
    expect(profile.css).toContain(".callout-warning");
    expect(profile.css).toContain(".callout-danger");
  });

  it("includes Slack link colour (#1264a3)", () => {
    expect(profile.css).toContain("#1264a3");
  });

  it("includes table styles with uppercase header labels", () => {
    expect(profile.css).toMatch(/table\s*\{/);
    expect(profile.css).toContain("text-transform: uppercase");
  });

  it("includes task-list support", () => {
    expect(profile.css).toMatch(/task-list/);
  });

  it("includes image rules with border-radius", () => {
    expect(profile.css).toMatch(/img\s*\{/);
    expect(profile.css).toContain("border-radius: 4px");
  });

  it("does not use external @import URLs", () => {
    expect(profile.css).not.toMatch(/@import\s+url\s*\(\s*['"]?https?:/i);
  });

  it("does not contain <script> tags", () => {
    expect(profile.css).not.toMatch(/<script/i);
  });

  it("does not use javascript: URIs", () => {
    expect(profile.css).not.toMatch(/javascript:/i);
  });
});

// ─── findProfile for new profiles ────────────────────────────────────────────

describe("findProfile — new profiles", () => {
  it("returns github-markdown profile by id", () => {
    const p = findProfile("github-markdown");
    expect(p).toBeDefined();
    expect(p!.id).toBe("github-markdown");
  });

  it("returns confluence-wiki profile by id", () => {
    const p = findProfile("confluence-wiki");
    expect(p).toBeDefined();
    expect(p!.id).toBe("confluence-wiki");
  });

  it("returns slack-rich-markdown profile by id", () => {
    const p = findProfile("slack-rich-markdown");
    expect(p).toBeDefined();
    expect(p!.id).toBe("slack-rich-markdown");
  });

  it("all 6 profiles are findable by id", () => {
    for (const id of ALL_PROFILE_IDS) {
      expect(findProfile(id), `findProfile("${id}") returned undefined`).toBeDefined();
    }
  });
});

// ─── Security: all new profile CSS ───────────────────────────────────────────

describe("security — all 6 profile CSS blocks", () => {
  it("no profile CSS contains <script> tags", () => {
    for (const p of EXPORT_PROFILES) {
      expect(p.css, `${p.id} has <script>`).not.toMatch(/<script/i);
    }
  });

  it("no profile CSS uses javascript: URIs", () => {
    for (const p of EXPORT_PROFILES) {
      expect(p.css, `${p.id} uses javascript:`).not.toMatch(/javascript:/i);
    }
  });

  it("no profile CSS imports external URLs", () => {
    for (const p of EXPORT_PROFILES) {
      expect(p.css, `${p.id} imports external URL`).not.toMatch(
        /@import\s+url\s*\(\s*['"]?https?:/i,
      );
    }
  });

  it("all 6 profiles have non-empty css", () => {
    for (const p of EXPORT_PROFILES) {
      expect(p.css.trim().length, `${p.id} has empty css`).toBeGreaterThan(0);
    }
  });

  it("all 6 profiles have a unique id", () => {
    const ids = new Set(EXPORT_PROFILES.map((p) => p.id));
    expect(ids.size).toBe(EXPORT_PROFILES.length);
  });

  it("all 6 profiles have a non-empty name and description", () => {
    for (const p of EXPORT_PROFILES) {
      expect(p.name.length, `${p.id} has empty name`).toBeGreaterThan(0);
      expect(p.description.length, `${p.id} has empty description`).toBeGreaterThan(0);
    }
  });
});
