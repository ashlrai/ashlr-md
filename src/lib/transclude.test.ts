import { describe, expect, it } from "vitest";
import { extractSection, isImageTarget, splitFragment } from "./transclude";

describe("splitFragment", () => {
  it("splits file and fragment", () => {
    expect(splitFragment("Note#Heading")).toEqual({
      file: "Note",
      fragment: "Heading",
    });
    expect(splitFragment("Note")).toEqual({ file: "Note", fragment: null });
    expect(splitFragment("Note#^abc")).toEqual({ file: "Note", fragment: "^abc" });
  });
});

describe("isImageTarget", () => {
  it("detects image extensions case-insensitively", () => {
    expect(isImageTarget("diagram.png")).toBe(true);
    expect(isImageTarget("photo.JPEG")).toBe(true);
    expect(isImageTarget("art.svg")).toBe(true);
    expect(isImageTarget("note.md")).toBe(false);
    expect(isImageTarget("noext")).toBe(false);
  });
});

describe("extractSection", () => {
  const doc = [
    "# Top",
    "intro text",
    "",
    "## Alpha",
    "alpha body",
    "more alpha",
    "",
    "## Beta",
    "beta body",
    "",
    "### Beta child",
    "child body",
  ].join("\n");

  it("extracts a heading section up to the next same-or-higher heading", () => {
    const out = extractSection(doc, "Alpha");
    expect(out).toContain("## Alpha");
    expect(out).toContain("alpha body");
    expect(out).toContain("more alpha");
    expect(out).not.toContain("## Beta");
  });

  it("includes deeper subheadings within a section", () => {
    const out = extractSection(doc, "Beta");
    expect(out).toContain("## Beta");
    expect(out).toContain("### Beta child");
    expect(out).toContain("child body");
  });

  it("is case-insensitive on the heading text", () => {
    expect(extractSection(doc, "alpha")).toContain("alpha body");
  });

  it("returns full content when the heading is missing", () => {
    expect(extractSection(doc, "Nope")).toBe(doc);
  });

  it("extracts a block by ^id and strips the marker", () => {
    const blockDoc = ["A paragraph.", "", "Target block. ^xyz", "", "Another."].join(
      "\n",
    );
    const out = extractSection(blockDoc, "^xyz");
    expect(out).toBe("Target block.");
  });

  it("returns full content when the block id is missing", () => {
    const blockDoc = "Just text. ^aaa";
    expect(extractSection(blockDoc, "^bbb")).toBe(blockDoc);
  });
});
