import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Renderer } from "../../components/viewer/Renderer";
import { builtInKindRegistry, loadKindRegistry } from "./kind-registry";
import { parsePlan } from "./plan-renderer";

const render = (content: string) =>
  renderToStaticMarkup(createElement(Renderer, { content }));
const doc =
  "---\nkind: plan\nstatus: blocked\n---\n# Ship\n- [x] Build\n- [ ] Verify\n";

describe("built-in plan kind", () => {
  it("registers plans and renders their checklist and explicit status", () => {
    expect(builtInKindRegistry.render(doc)).toMatchObject({
      name: "plan",
      renderer: "plan",
      content: doc,
    });
    const html = render(doc);
    expect(html).toContain('data-doc-kind="plan"');
    expect(html).toContain('aria-label="Plan status"');
    expect(html).toContain("Status: blocked");
    expect(html).toContain("1 of 2 steps complete");
    expect(html).toContain('value="1" max="2"');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain("Build");
    expect(html).toContain("Verify");
  });

  it.each([
    ["", "pending", 0],
    ["- [ ] Start", "pending", 1],
    ["- [X] Start\n- [ ] Finish", "in progress", 2],
    ["- [x] Finish", "complete", 1],
  ])("derives status for %s", (body, status, total) => {
    const content = `---\nkind: plan\n---\n${body}`;
    expect(parsePlan(content)).toMatchObject({ status, total });
    expect(render(content)).toContain(`Status: ${status}`);
    if (!total) expect(render(content)).not.toContain("<progress");
  });

  it("ignores example tasks and preserves original source offsets and lines", () => {
    const content =
      `\uFEFF${doc}\n\`\`\`md\n- [ ] Example\n\`\`\`\n\n    - [ ] Code\n`.replaceAll(
        "\n",
        "\r\n",
      );
    const plan = parsePlan(content);
    expect(plan.total).toBe(2);
    expect(plan.steps[0]).toMatchObject({ line: 6, offset: content.indexOf("[x]") });
    expect(builtInKindRegistry.render(content).content).toBe(content);
  });

  it("keeps ordinary Markdown output identical to explicit plain rendering", () => {
    const content = "## Notes\nA **normal** document.\n\n- First\n- Second\n";
    const plain = renderToStaticMarkup(
      createElement(Renderer, {
        content,
        kindRegistry: loadKindRegistry("[]"),
      }),
    );
    expect(render(content)).toBe(plain);
    expect(builtInKindRegistry.render(content).renderer).toBe("plain");
    expect(render(content)).not.toContain("Plan status");
  });

  it("escapes status text and respects a custom registry's plain fallback", () => {
    expect(render(doc.replace("blocked", "<script>bad</script>"))).toContain(
      "&lt;script&gt;bad&lt;/script&gt;",
    );
    const html = renderToStaticMarkup(
      createElement(Renderer, {
        content: doc,
        kindRegistry: loadKindRegistry("[]"),
      }),
    );
    expect(html).not.toContain("Plan status");
  });
});
