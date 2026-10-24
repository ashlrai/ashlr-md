// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { clearHighlights, highlight } from "./domFind";

function setup(html: string) {
  document.body.innerHTML = `<div class="app-content"><div class="markdown-body">${html}</div></div>`;
}

describe("domFind", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns 0 when there is no rendered body", () => {
    expect(highlight("x")).toBe(0);
  });

  it("returns 0 for an empty query", () => {
    setup("<p>some text</p>");
    expect(highlight("")).toBe(0);
  });

  it("highlights all case-insensitive matches", () => {
    setup("<p>The quick brown Fox jumps over the fox</p>");
    expect(highlight("fox")).toBe(2);
    expect(document.querySelectorAll("mark.find-hit").length).toBe(2);
  });

  it("skips code blocks", () => {
    setup("<p>alpha</p><pre><code>alpha</code></pre>");
    expect(highlight("alpha")).toBe(1);
  });

  /** An identifier written as inline code could not be found. */
  it("finds text in inline code", () => {
    setup("<p>Call <code>parseConfig()</code> once; parseConfig is cached.</p>");
    expect(highlight("parseConfig")).toBe(2);
    expect(document.querySelector("code mark.find-hit")?.textContent).toBe(
      "parseConfig",
    );
    clearHighlights();
    expect(document.querySelector("code")?.textContent).toBe("parseConfig()");
  });

  it("finds text inside a ==highlight== mark", () => {
    setup('<p>plain <mark class="highlight">key idea</mark> and idea</p>');
    expect(highlight("idea")).toBe(2);
    const hit = document.querySelector("mark.highlight mark.find-hit");
    expect(hit?.textContent).toBe("idea");
    clearHighlights();
    expect(document.querySelector("mark.highlight")?.textContent).toBe("key idea");
  });

  it("marks the hit itself in text that lowercases to more characters", () => {
    // "İ".toLowerCase() is two characters, which shifted every later hit.
    setup("<p>İstanbul ve İzmir, istanbul</p>");
    expect(highlight("stan")).toBe(2);
    const hits = Array.from(document.querySelectorAll("mark.find-hit"));
    expect(hits.map((h) => h.textContent)).toEqual(["stan", "stan"]);
    expect(highlight("İzmir")).toBe(1);
    expect(document.querySelector("mark.find-hit")?.textContent).toBe("İzmir");
  });

  it("takes a query with regular-expression characters literally", () => {
    setup("<p>a.b axb (c) [d] $5 a+b</p>");
    expect(highlight("a.b")).toBe(1);
    expect(highlight("(c)")).toBe(1);
    expect(highlight("[d]")).toBe(1);
    expect(highlight("$5")).toBe(1);
    expect(highlight("a+b")).toBe(1);
  });

  it("clears highlights and restores the original text", () => {
    setup("<p>find me here</p>");
    highlight("find");
    clearHighlights();
    expect(document.querySelectorAll("mark.find-hit").length).toBe(0);
    expect(document.querySelector(".markdown-body")?.textContent).toBe("find me here");
  });
});
