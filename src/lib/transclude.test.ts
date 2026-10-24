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

  it("finds a block id only on a text line", () => {
    // A `^id` in front matter or code is not a block id; it used to be
    // found there, and the block ran back over the lines above it.
    const doc = [
      "---",
      "note: x ^abc",
      "---",
      "```",
      "code ^abc",
      "```",
      "Real block. ^abc",
    ].join("\n");
    expect(extractSection(doc, "^abc")).toBe("Real block.");
    expect(extractSection("    code ^c\n\nText", "^c")).toBe("    code ^c\n\nText");
    expect(extractSection("A\r\nB ^d\r\n", "^d")).toBe("A\r\nB");
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

  it("reads headings by the outline's rule", () => {
    const fenced = ["## Setup", "```sh", "# install", "```", "after", "## Next"].join(
      "\n",
    );
    // A `#` comment in fenced code does not end the section.
    expect(extractSection(fenced, "Setup")).toContain("after");
    expect(extractSection(fenced, "install")).toBe(fenced);
    // Closing `#`s are not part of the heading text.
    expect(extractSection("## Goals ##\nbody\n", "Goals")).toBe("## Goals ##\nbody");
    // An indented `# x` is code, not a heading.
    expect(extractSection("    # Code\nbody", "Code")).toBe("    # Code\nbody");
  });
});
