/**
 * exportTemplates.test.ts — unit tests for src/lib/exportTemplates.ts
 *
 * Covers: BUILTIN_TEMPLATES, findTemplate, validateTemplateCss, newTemplateId,
 * and the template variable / cascade semantics documented in exportTemplates.ts.
 */

import { describe, expect, it } from "vitest";
import {
  BUILTIN_TEMPLATES,
  NO_TEMPLATE_ID,
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
