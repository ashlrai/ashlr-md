/**
 * A `#heading` link in the read view jumped with a smooth scroll even when
 * the system asks to reduce motion: it passed `behavior: "smooth"`, which
 * overrides the reduced-motion CSS. The outline, find and links into other
 * documents already went by the setting (motion.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { MouseEvent } from "react";
import { followLink } from "./Renderer";

function clickIn(body: HTMLElement) {
  const a = document.createElement("a");
  body.appendChild(a);
  return {
    preventDefault: vi.fn(),
    currentTarget: a,
  } as unknown as MouseEvent<HTMLAnchorElement>;
}

function page() {
  const body = document.createElement("div");
  body.className = "markdown-body";
  const h = document.createElement("h2");
  h.id = "setup";
  h.scrollIntoView = vi.fn();
  body.appendChild(h);
  document.body.appendChild(body);
  return { body, h };
}

const reduce = (on: boolean) =>
  vi
    .spyOn(window, "matchMedia")
    .mockImplementation(
      (q: string) => ({ matches: on && q.includes("reduce") }) as MediaQueryList,
    );

describe("a #heading link", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("jumps without animation under reduced motion", () => {
    reduce(true);
    const { body, h } = page();
    followLink(clickIn(body), "#setup", "/notes/a.md");
    expect(h.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });

  it("scrolls smoothly otherwise", () => {
    reduce(false);
    const { body, h } = page();
    followLink(clickIn(body), "#setup", "/notes/a.md");
    expect(h.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });
});
