/**
 * exportName.test.ts: edge cases and error paths for exportTitle().
 *
 * The export dialog, the palette export commands and the MCP export handler
 * all title a document with this function, so a regression here changes the
 * default file name and the page title everywhere at once.
 */

import { describe, expect, it } from "vitest";
import { exportTitle } from "./exportName";

describe("exportTitle", () => {
  it("strips each Markdown extension, in any letter case", () => {
    for (const name of [
      "notes.md",
      "notes.markdown",
      "notes.mdown",
      "notes.mkd",
      "notes.mdx",
    ]) {
      expect(exportTitle(name)).toBe("notes");
    }
    expect(exportTitle("NOTES.MD")).toBe("NOTES");
    expect(exportTitle("Plan.MarkDown")).toBe("Plan");
  });

  it("falls back to 'export' when there is no name to use", () => {
    expect(exportTitle(null)).toBe("export");
    expect(exportTitle(undefined)).toBe("export");
    expect(exportTitle("")).toBe("export");
    expect(exportTitle(".md")).toBe("export");
  });

  it("keeps names with other extensions or none at all", () => {
    expect(exportTitle("notes.txt")).toBe("notes.txt");
    expect(exportTitle("README")).toBe("README");
    expect(exportTitle("draft.md.bak")).toBe("draft.md.bak");
  });

  it("removes only the trailing extension", () => {
    expect(exportTitle("v1.2.notes.md")).toBe("v1.2.notes");
    expect(exportTitle("notes.md.md")).toBe("notes.md");
  });

  it("does not strip an extension that is not at the end of the name", () => {
    expect(exportTitle("notes.md-old")).toBe("notes.md-old");
    expect(exportTitle("md")).toBe("md");
  });
});
