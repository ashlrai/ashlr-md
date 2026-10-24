import { afterEach, describe, expect, it, vi } from "vitest";
import { setActive } from "./domFind";
import { smoothScrollBehavior } from "./motion";

/** window.matchMedia answering `reduce` for the reduced-motion query. */
function prefersReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: reduce && q.includes("reduce"), media: q })),
  );
}

describe("smoothScrollBehavior", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("is smooth unless the system asks for reduced motion", () => {
    prefersReducedMotion(false);
    expect(smoothScrollBehavior()).toBe("smooth");
    prefersReducedMotion(true);
    expect(smoothScrollBehavior()).toBe("auto");
    vi.stubGlobal("matchMedia", undefined);
    expect(smoothScrollBehavior()).toBe("smooth");
  });

  it("find jumps to a match without animation under reduced motion", () => {
    // A behavior: "smooth" argument overrides the CSS scroll-behavior the
    // reduced-motion rule sets, so it animated anyway.
    prefersReducedMotion(true);
    document.body.innerHTML =
      '<div class="app-content"><div class="markdown-body"><p><mark class="find-hit">x</mark></p></div></div>';
    const mark = document.querySelector("mark") as HTMLElement;
    const scroll = vi.fn();
    mark.scrollIntoView = scroll;
    setActive(0);
    expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
  });
});
