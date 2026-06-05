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

  it("skips code and pre regions", () => {
    setup("<p>alpha</p><pre><code>alpha</code></pre>");
    expect(highlight("alpha")).toBe(1);
  });

  it("clears highlights and restores the original text", () => {
    setup("<p>find me here</p>");
    highlight("find");
    clearHighlights();
    expect(document.querySelectorAll("mark.find-hit").length).toBe(0);
    expect(document.querySelector(".markdown-body")?.textContent).toBe("find me here");
  });
});
