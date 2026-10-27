/** Exactly 10,000 lines of prose, headings, GFM tasks/tables and fenced code. */
export function largeDocument(): string {
  return Array.from({ length: 500 }, (_, n) =>
    [
      `## Section ${n}`,
      "",
      `Paragraph ${n} with **bold**, *emphasis*, and ~~deleted~~ text.`,
      "A second line of ordinary prose for the same paragraph.",
      "",
      `- [ ] Task ${n}`,
      "- [x] Completed task",
      "  - Nested list item",
      "",
      "| Name | Value |",
      "| :--- | ---: |",
      `| Row ${n} | ${n} |`,
      "",
      "> Quoted text",
      "",
      "```text",
      `example ${n}`,
      "```",
      "",
      "",
    ].join("\n"),
  ).join("\n");
}
