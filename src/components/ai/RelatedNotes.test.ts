import { describe, expect, it } from "vitest";
import { queryFromDoc } from "./RelatedNotes";

describe("RelatedNotes queryFromDoc", () => {
  it("takes the first heading outside front matter and fenced code", () => {
    const doc = [
      "---",
      "# a yaml comment",
      "---",
      "```sh",
      "# install deps",
      "```",
      "## Launch Plan ##",
      "",
      "# Later",
    ].join("\n");
    expect(queryFromDoc("plan.md", doc)).toBe("plan Launch Plan");
  });

  it("reads an indented or tab-separated heading and skips deeper ones", () => {
    expect(queryFromDoc("n.md", "  # Indented")).toBe("n Indented");
    expect(queryFromDoc("n.md", "#\tTabbed")).toBe("n Tabbed");
    expect(queryFromDoc("n.md", "#### Deep\n### Three")).toBe("n Three");
    expect(queryFromDoc("n.md", "    # code\ntext")).toBe("n");
  });
});
