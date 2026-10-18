/**
 * The AI sidebar renders model answers as HTML. Its small markdown renderer
 * used to escape only code spans, so HTML the model wrote in plain text, such
 * as `<img src=x onerror=...>` or `<a href="javascript:...">`, went into the
 * webview as-is. It now escapes all text before formatting it and builds
 * links only for http, https and mailto URLs.
 */
import { describe, expect, it } from "vitest";
import { renderChatMarkdown } from "./chatMarkdown";

/** Parses the rendered HTML the way the bubble does. */
function render(text: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = renderChatMarkdown(text, false);
  return div;
}

/** Every element and attribute name in the rendered tree. */
function shape(el: HTMLElement): { tags: string[]; attrs: string[] } {
  const tags: string[] = [];
  const attrs: string[] = [];
  for (const node of Array.from(el.querySelectorAll("*"))) {
    tags.push(node.tagName.toLowerCase());
    for (const a of Array.from(node.attributes)) attrs.push(a.name);
  }
  return { tags, attrs };
}

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "strong",
  "em",
  "code",
  "pre",
  "ul",
  "li",
  "a",
  "span",
]);
const ALLOWED_ATTRS = new Set(["href", "target", "rel", "class", "aria-hidden"]);

function expectOnlyRendererMarkup(el: HTMLElement) {
  const { tags, attrs } = shape(el);
  for (const t of tags) expect(ALLOWED_TAGS.has(t), `unexpected <${t}>`).toBe(true);
  for (const a of attrs) expect(ALLOWED_ATTRS.has(a), `unexpected ${a}=`).toBe(true);
  for (const a of Array.from(el.querySelectorAll("a"))) {
    expect(a.getAttribute("href") ?? "").toMatch(/^(https?:\/\/|mailto:)/i);
  }
}

describe("renderChatMarkdown: tag injection", () => {
  it.each([
    "<img src=x onerror=alert(1)>",
    "Here you go: <script>alert(1)</script> done",
    '<a href="javascript:alert(1)">click</a>',
    "<iframe src=https://evil.example></iframe>",
    "**<svg onload=alert(1)>**",
    "- <img src=x onerror=alert(1)>\n- item",
    "<style>body{display:none}</style>",
  ])("shows %s as text", (input) => {
    const el = render(input);
    expectOnlyRendererMarkup(el);
    expect(el.querySelector("img, script, iframe, svg, style")).toBeNull();
    // The model's text is still visible, as text.
    expect(el.textContent).toContain(input.replace(/\*\*|- /g, "").split("\n")[0]);
  });

  it("does not let a code span close early", () => {
    const el = render("`</code><img src=x onerror=alert(1)>`");
    expectOnlyRendererMarkup(el);
    expect(el.querySelector("code")?.textContent).toBe(
      "</code><img src=x onerror=alert(1)>",
    );
  });

  it("drops the placeholder character so text cannot forge a stashed placeholder", () => {
    const el = render("\uE0000\uE000 and `x`");
    expectOnlyRendererMarkup(el);
    expect(el.querySelectorAll("code")).toHaveLength(1);
  });
});

describe("renderChatMarkdown: links", () => {
  it.each([
    "[click](javascript:alert(1))",
    "[click](javascript:alert`1`)",
    "[click](JaVaScRiPt:alert(1))",
    "[click](data:text/html,<script>alert(1)</script>)",
    "[click](vbscript:msgbox)",
    "[click](/relative/path)",
    "[click](file:///etc/passwd)",
  ])("builds no anchor for %s", (input) => {
    const el = render(input);
    expectOnlyRendererMarkup(el);
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("click");
  });

  it("cannot break out of the href attribute", () => {
    const el = render('[x](https://a.example/"onmouseover="alert&#40;1&#41;)');
    expectOnlyRendererMarkup(el);
    const a = el.querySelector("a");
    expect(a?.getAttribute("onmouseover")).toBeFalsy();
    expect(a?.getAttribute("href")).toBe(
      'https://a.example/"onmouseover="alert&#40;1&#41;',
    );
  });

  it("keeps HTML in link text as text", () => {
    const el = render("[<img src=x onerror=alert(1)>](https://a.example)");
    expectOnlyRendererMarkup(el);
    expect(el.querySelector("a")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("links http, https and mailto, opening outside the app", () => {
    const el = render(
      "See [docs](https://example.com/a_b_c?x=1&y=2), [old](http://example.com) or [mail](mailto:me@example.com).",
    );
    expectOnlyRendererMarkup(el);
    const links = Array.from(el.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://example.com/a_b_c?x=1&y=2",
      "http://example.com",
      "mailto:me@example.com",
    ]);
    expect(links.map((a) => a.textContent)).toEqual(["docs", "old", "mail"]);
    for (const a of links) {
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.getAttribute("target")).toBe("_blank");
    }
  });
});

describe("renderChatMarkdown: normal markdown still renders", () => {
  it("renders bold, italics and inline code", () => {
    const el = render("This is **bold**, *italic*, _also italic_ and `a < b` code.");
    expect(el.querySelector("strong")?.textContent).toBe("bold");
    expect(Array.from(el.querySelectorAll("em")).map((e) => e.textContent)).toEqual([
      "italic",
      "also italic",
    ]);
    expect(el.querySelector("code")?.textContent).toBe("a < b");
  });

  it("leaves snake_case and 2 * 3 * 4 alone", () => {
    const el = render("call snake_case_name with 2 * 3 * 4");
    expect(el.querySelector("em")).toBeNull();
    expect(el.textContent).toBe("call snake_case_name with 2 * 3 * 4");
  });

  it("renders fenced code with its text intact", () => {
    const el = render("Try:\n\n```ts\nconst a = '<b>' && x;\n```");
    expect(el.querySelector("pre code")?.textContent).toBe("const a = '<b>' && x;");
    expect(el.querySelector("b")).toBeNull();
  });

  it("renders separate bullet lists and paragraphs", () => {
    const el = render("Intro\n\n- one\n- **two**\n\nMiddle\n\n* three");
    const lists = el.querySelectorAll("ul");
    expect(lists).toHaveLength(2);
    expect(
      Array.from(lists[0].querySelectorAll("li")).map((l) => l.textContent),
    ).toEqual(["one", "two"]);
    expect(lists[0].querySelector("strong")?.textContent).toBe("two");
    expect(el.textContent).toContain("Middle");
  });

  it("shows ampersands and quotes as typed", () => {
    expect(render(`Tom & Jerry say "hi" & 'bye' &amp;`).textContent).toBe(
      `Tom & Jerry say "hi" & 'bye' &amp;`,
    );
  });

  it("appends the cursor while streaming", () => {
    expect(renderChatMarkdown("hi", true)).toContain('class="ai-cursor"');
  });
});
