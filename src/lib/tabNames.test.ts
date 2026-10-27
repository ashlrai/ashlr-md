import { describe, expect, it } from "vitest";
import { tabFolderHints } from "./tabNames";

const tab = (id: string, path: string) => ({
  id,
  path,
  fileName: path.split(/[\\/]/).pop() ?? "",
});

describe("tabFolderHints", () => {
  it("gives no hint to a tab whose name is its own", () => {
    expect(tabFolderHints([tab("a", "/v/a.md"), tab("b", "/v/b.md")]).size).toBe(0);
  });

  it("shows the parent folder of tabs that share a name", () => {
    const hints = tabFolderHints([
      tab("1", "/work/api/README.md"),
      tab("2", "/work/web/README.md"),
      tab("3", "/work/notes.md"),
    ]);
    expect(Object.fromEntries(hints)).toEqual({ "1": "api", "2": "web" });
  });

  it("shows as many folders as it takes, ignoring case", () => {
    const hints = tabFolderHints([
      tab("1", "/a/docs/plan.md"),
      tab("2", "/b/docs/PLAN.md"),
      tab("3", "/docs/plan.md"),
      tab("4", "C:\\c\\x\\plan.md"),
    ]);
    expect(Object.fromEntries(hints)).toEqual({
      "1": "a/docs",
      "2": "b/docs",
      "3": "docs",
      "4": "x",
    });
  });

  it("gives no hint where no folder tells tabs apart", () => {
    expect(
      tabFolderHints([tab("1", "/v/a.md"), tab("2", "/v/a.md"), tab("3", "")]).size,
    ).toBe(0);
  });
});
