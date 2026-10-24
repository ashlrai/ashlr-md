import { describe, expect, it } from "vitest";
import { slackMrkdwn } from "./slackText";

function body(html: string): Element {
  const el = document.createElement("div");
  el.className = "markdown-body";
  el.innerHTML = html;
  return el;
}

describe("slackMrkdwn", () => {
  it("writes inline formatting, links and headings the way Slack reads them", () => {
    const text = slackMrkdwn(
      body(
        '<h1>Release <em>notes</em></h1><p>Some <strong>bold </strong>and <em>italic</em>, <del>gone</del>, <code>a &lt; b</code> and <a href="https://example.com/x?a=1">a link</a> or <a href="https://example.com">https://example.com</a>.</p>',
      ),
    );
    expect(text).toBe(
      "*Release _notes_*\n\nSome *bold* and _italic_, ~gone~, `a &lt; b` and <https://example.com/x?a=1|a link> or <https://example.com>.\n",
    );
  });

  it("writes lists, nested lists, task items, quotes and code blocks", () => {
    const text = slackMrkdwn(
      body(
        '<ul><li>one<ul><li>inner</li></ul></li><li><input type="checkbox" checked disabled> done</li></ul>' +
          '<ol start="3"><li>three</li><li>four</li></ol>' +
          "<blockquote><p>quoted</p><p>twice</p></blockquote>" +
          '<div class="code-block"><div class="code-block-header"><span>ts</span><button class="copy-btn">Copy</button></div><pre><code>if (a &amp;&amp; b) {}\n</code></pre></div>',
      ),
    );
    expect(text).toBe(
      [
        "• one\n    • inner\n• [x] done",
        "3. three\n4. four",
        "> quoted\n>\n> twice",
        "```\nif (a &amp;&amp; b) {}\n```",
      ].join("\n\n") + "\n",
    );
  });

  it("writes tables as rows, math as its TeX, and drops images and app chrome", () => {
    const text = slackMrkdwn(
      body(
        "<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>" +
          '<p><span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html">x2</span></span></p>' +
          '<p><img src="data:image/png;base64,AA" alt="local"> <img src="https://example.com/c.png" alt="cat"></p>' +
          '<div class="review-card">Summary card</div><span class="remote-images-banner">bar</span>',
      ),
    );
    expect(text).toBe(
      "*Name* | *Value*\na | 1\n\n`x^2`\n\nlocal <https://example.com/c.png|cat>\n",
    );
    expect(text).not.toContain("<!doctype");
    expect(text).not.toContain("Summary card");
  });
});
