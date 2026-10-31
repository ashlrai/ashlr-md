import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Renderer } from "../../components/viewer/Renderer";
import { loadKindRegistry } from "./kind-registry";

const definition = {
  name: "audit",
  renderer: "spec",
  frontmatter: { kind: "audit", status: "ready" },
  sections: { Checks: "Acceptance Criteria" },
};
const json = JSON.stringify([definition]);
const content =
  '---\nkind: "audit"\nstatus: ready\n---\n# Audit\n\n## Checks\n- [x] Safe\n';

describe("declarative kind registry", () => {
  it.each([
    [
      "plan",
      "## Checks\n- [x] Safe",
      expect.arrayContaining([
        expect.objectContaining({ checked: true, text: "Safe" }),
      ]),
    ],
    ["review", "## Verdict\nApproved", { summary: "Approved" }],
    [
      "spec",
      "## Checks\n- [x] Safe",
      { criteriaDone: 1, criteria: [{ text: "Safe", done: true, line: 8 }] },
    ],
    [
      "runbook",
      "## Actions\n1. Inspect",
      { stepCount: 1, steps: [expect.objectContaining({ title: "Inspect", line: 8 })] },
    ],
  ])("dispatches %s through its existing parser and viewer", (renderer, body, expected) => {
    const registry = loadKindRegistry(
      JSON.stringify([
        {
          ...definition,
          renderer,
          sections: {
            Checks: "Acceptance Criteria",
            Verdict: "Summary",
            Actions: "Steps",
          },
        },
      ]),
    );
    const doc = `---\nkind: audit\nstatus: ready\n---\n# Audit\n\n${body}`;
    const result = registry.render(doc);
    expect(result).toMatchObject({ name: "audit", renderer, content: doc });
    expect(result.data).toMatchObject(expected);
    if (renderer === "plan")
      expect(result.data).toContainEqual({
        checked: true,
        text: "Safe",
        offset: doc.indexOf("[x]"),
      });
    const html = renderToStaticMarkup(
      createElement(Renderer, { content: doc, kindRegistry: registry }),
    );
    expect(html).toContain(`data-doc-kind="${renderer}"`);
    expect(html).toContain(`data-kind="${renderer}"`);
  });

  it.each([
    "{",
    "null",
    "{}",
    "[null]",
    JSON.stringify([{ ...definition, renderer: "__proto__" }]),
    JSON.stringify([{ ...definition, renderer: "() => alert(1)" }]),
    JSON.stringify([{ ...definition, sections: { Checks: "Summary\n<script>" } }]),
    JSON.stringify([{ ...definition, frontmatter: {} }]),
    JSON.stringify([{ ...definition, sections: [] }]),
    JSON.stringify([{ ...definition, code: "throw new Error('executed')" }]),
    JSON.stringify([definition, definition]),
    JSON.stringify([definition, { name: "broken" }]),
  ])("falls back atomically to plain Markdown for invalid configuration %s", (invalid) => {
    const registry = loadKindRegistry(invalid);
    const doc = content.replace("audit", "spec");
    expect(registry.render(doc)).toEqual({
      name: null,
      renderer: "plain",
      content: doc,
      data: null,
    });
    const html = renderToStaticMarkup(
      createElement(Renderer, { content: doc, kindRegistry: registry }),
    );
    expect(html).toContain('<h2 id="checks"');
    expect(html).not.toContain("data-doc-kind=");
  });

  it("matches every frontmatter field exactly and ignores body/nested/unclosed matches", () => {
    for (const doc of [
      content.replace("ready", "Ready"),
      content.replace("status: ready", "nested:\n  status: ready"),
      "# Audit\nkind: audit\nstatus: ready",
      content.replace("\n---\n#", "\n#"),
    ]) {
      expect(loadKindRegistry(json).render(doc).renderer).toBe("plain");
    }
    expect(
      loadKindRegistry(json).render(`\uFEFF${content.replaceAll("\n", "\r\n")}`)
        .renderer,
    ).toBe("spec");
  });

  it("preserves original Markdown and source lines; aliases only real section headings", () => {
    const doc = `${content}\n\`\`\`md\n## Checks\n- [x] example\n\`\`\`\n\n> ## Checks\n\n    ## Checks\n`;
    const result = loadKindRegistry(json).render(doc);
    expect(result.content).toBe(doc);
    expect(result.data).toMatchObject({
      criteria: [{ text: "Safe", done: true, line: 8 }],
    });
    const html = renderToStaticMarkup(
      createElement(Renderer, { content: doc, kindRegistry: loadKindRegistry(json) }),
    );
    expect(html).toContain('<h2 id="checks"');
    expect(html).not.toContain('id="acceptance-criteria"');
  });

  it("uses the first match, with isolated registries and plain fallback for no match", () => {
    const registry = loadKindRegistry(
      JSON.stringify([
        definition,
        { ...definition, name: "second", renderer: "review" },
      ]),
    );
    expect(registry.render(content).name).toBe("audit");
    expect(loadKindRegistry("[]").render(content).renderer).toBe("plain");
    expect(registry.render(content.replace("audit", "unknown")).renderer).toBe("plain");
    const html = renderToStaticMarkup(
      createElement(Renderer, { content: "---\nkind: spec\n---\n# Built-in" }),
    );
    expect(html).toContain('data-doc-kind="spec"');
  });
});
