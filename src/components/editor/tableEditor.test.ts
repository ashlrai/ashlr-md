/**
 * tableEditor.test.ts — unit tests for src/lib/tableEditor.ts
 *
 * Coverage:
 *  1. isInsideTable / findTableRange — cursor detection
 *  2. parseTable / serializeTable   — round-trip fidelity
 *  3. buildEmptyTable               — dimension validation
 *  4. insertRow / deleteRow         — row mutations
 *  5. insertColumn / deleteColumn   — column mutations
 *  6. setColumnAlignment            — alignment persistence
 *  7. getCellContent / setCellContent — cell access
 *  8. applyTableEdit                — high-level document mutations
 *  9. HTML export table structure   — serializeTable produces valid Markdown
 *     that can be rendered as an HTML table (structural checks)
 */

import { describe, expect, it } from "vitest";
import {
  applyTableEdit,
  buildEmptyTable,
  deleteColumn,
  deleteRow,
  findTableRange,
  getCellContent,
  insertColumn,
  insertRow,
  isInsideTable,
  parseTable,
  serializeTable,
  setColumnAlignment,
  setCellContent,
  type ParsedTable,
} from "../../lib/tableEditor";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const SIMPLE_TABLE = `| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`;

const ALIGNED_TABLE = `| Left | Center | Right | None |
| :--- | :---: | ---: | --- |
| a | b | c | d |`;

const TABLE_IN_DOC = `# Heading

${SIMPLE_TABLE}

Some text after.`;

// Offset of the first character of the table in TABLE_IN_DOC.
const TABLE_START_IN_DOC = TABLE_IN_DOC.indexOf("| Name");

// ── 1. isInsideTable / findTableRange ─────────────────────────────────────────

describe("isInsideTable", () => {
  it("returns true when cursor is on the header row", () => {
    const offset = SIMPLE_TABLE.indexOf("Name");
    expect(isInsideTable(SIMPLE_TABLE, offset)).toBe(true);
  });

  it("returns true when cursor is on the separator row", () => {
    const offset = SIMPLE_TABLE.indexOf("---");
    expect(isInsideTable(SIMPLE_TABLE, offset)).toBe(true);
  });

  it("returns true when cursor is on a data row", () => {
    const offset = SIMPLE_TABLE.indexOf("Alice");
    expect(isInsideTable(SIMPLE_TABLE, offset)).toBe(true);
  });

  it("returns false for plain text (no table)", () => {
    expect(isInsideTable("# Just a heading\n\nPlain text.", 5)).toBe(false);
  });

  it("returns false when cursor is before the table in a document", () => {
    // "# Heading\n\n" is 12 chars — cursor at position 3 is inside heading
    expect(isInsideTable(TABLE_IN_DOC, 3)).toBe(false);
  });

  it("returns true when cursor is inside the table in a mixed document", () => {
    const offset = TABLE_IN_DOC.indexOf("Alice");
    expect(isInsideTable(TABLE_IN_DOC, offset)).toBe(true);
  });

  it("returns false when cursor is after the table in a mixed document", () => {
    const offset = TABLE_IN_DOC.indexOf("Some text after");
    expect(isInsideTable(TABLE_IN_DOC, offset)).toBe(false);
  });
});

describe("findTableRange", () => {
  it("returns null when there is no table", () => {
    expect(findTableRange("No table here.", 0)).toBeNull();
  });

  it("returns a range spanning the entire simple table source", () => {
    const range = findTableRange(SIMPLE_TABLE, SIMPLE_TABLE.indexOf("Alice"));
    expect(range).not.toBeNull();
    expect(range!.source).toContain("Name");
    expect(range!.source).toContain("Alice");
    expect(range!.source).toContain("Bob");
  });

  it("start offset in a document is correct", () => {
    const offset = TABLE_IN_DOC.indexOf("Alice");
    const range = findTableRange(TABLE_IN_DOC, offset);
    expect(range).not.toBeNull();
    expect(range!.start).toBe(TABLE_START_IN_DOC);
  });

  it("source extracted from document matches the standalone table (ignoring trailing newline)", () => {
    const offset = TABLE_IN_DOC.indexOf("Bob");
    const range = findTableRange(TABLE_IN_DOC, offset);
    expect(range).not.toBeNull();
    // The source should contain all table lines
    expect(range!.source).toContain("| Name | Age |");
    expect(range!.source).toContain("| Bob | 25 |");
  });

  it("end offset correctly excludes content after the table", () => {
    const offset = TABLE_IN_DOC.indexOf("Alice");
    const range = findTableRange(TABLE_IN_DOC, offset);
    expect(range).not.toBeNull();
    // Content after range.end should contain the trailing text
    const afterTable = TABLE_IN_DOC.slice(range!.end);
    expect(afterTable).toContain("Some text after");
  });
});

// ── 2. parseTable / serializeTable ────────────────────────────────────────────

describe("parseTable", () => {
  it("parses header cells correctly", () => {
    const table = parseTable(SIMPLE_TABLE);
    expect(table.headers).toEqual(["Name", "Age"]);
  });

  it("parses data rows correctly", () => {
    const table = parseTable(SIMPLE_TABLE);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toEqual(["Alice", "30"]);
    expect(table.rows[1]).toEqual(["Bob", "25"]);
  });

  it("parses alignment markers correctly", () => {
    const table = parseTable(ALIGNED_TABLE);
    expect(table.alignments).toEqual(["left", "center", "right", "none"]);
  });

  it("parses a table with no data rows", () => {
    const src = `| A | B |\n| --- | --- |`;
    const table = parseTable(src);
    expect(table.headers).toEqual(["A", "B"]);
    expect(table.rows).toHaveLength(0);
  });

  it("handles extra whitespace in cells", () => {
    const src = `|  Name  |   Age   |\n| --- | --- |\n|  Alice  |  30  |`;
    const table = parseTable(src);
    expect(table.headers[0]).toBe("Name");
    expect(table.rows[0][0]).toBe("Alice");
  });

  it("returns empty ParsedTable for malformed source (< 2 lines)", () => {
    const table = parseTable("| only one line |");
    expect(table.headers).toHaveLength(0);
  });
});

describe("serializeTable", () => {
  it("round-trips a simple table without losing data", () => {
    const table = parseTable(SIMPLE_TABLE);
    const out = serializeTable(table);
    const re = parseTable(out);
    expect(re.headers).toEqual(table.headers);
    expect(re.rows).toEqual(table.rows);
  });

  it("round-trips alignment markers", () => {
    const table = parseTable(ALIGNED_TABLE);
    const out = serializeTable(table);
    const re = parseTable(out);
    expect(re.alignments).toEqual(["left", "center", "right", "none"]);
  });

  it("produces a pipe-delimited format readable as HTML table headers", () => {
    const src = `| Col A | Col B |\n| --- | --- |\n| val1 | val2 |`;
    const table = parseTable(src);
    const out = serializeTable(table);
    // Each column header must appear in the output
    expect(out).toContain("Col A");
    expect(out).toContain("Col B");
    // Data cells must appear
    expect(out).toContain("val1");
    expect(out).toContain("val2");
    // Must have a separator row
    expect(out).toContain("---");
  });

  it("serialized output has correct number of lines (header + sep + data rows)", () => {
    const table = parseTable(SIMPLE_TABLE);
    const lines = serializeTable(table).split("\n");
    // 1 header + 1 sep + 2 data rows = 4
    expect(lines).toHaveLength(4);
  });
});

// ── 3. buildEmptyTable ────────────────────────────────────────────────────────

describe("buildEmptyTable", () => {
  it("builds a 2x3 table with correct column headers", () => {
    const out = buildEmptyTable(2, 3);
    const table = parseTable(out);
    expect(table.headers).toHaveLength(3);
    expect(table.rows).toHaveLength(2);
  });

  it("headers contain column numbers (Column 1, Column 2, ...)", () => {
    const out = buildEmptyTable(1, 2);
    expect(out).toContain("Column 1");
    expect(out).toContain("Column 2");
  });

  it("data cells are empty strings", () => {
    const table = parseTable(buildEmptyTable(3, 2));
    for (const row of table.rows) {
      for (const cell of row) {
        expect(cell).toBe("");
      }
    }
  });

  it("clamps rows to minimum 1", () => {
    const table = parseTable(buildEmptyTable(0, 2));
    expect(table.rows).toHaveLength(1);
  });

  it("clamps cols to minimum 1", () => {
    const table = parseTable(buildEmptyTable(1, 0));
    expect(table.headers).toHaveLength(1);
  });

  it("produces valid Markdown (parseable without data loss)", () => {
    const out = buildEmptyTable(3, 4);
    const table = parseTable(out);
    expect(table.headers).toHaveLength(4);
    expect(table.rows).toHaveLength(3);
  });
});

// ── 4. insertRow / deleteRow ──────────────────────────────────────────────────

describe("insertRow", () => {
  const base = parseTable(SIMPLE_TABLE);

  it("inserts a blank row below index 0 — table grows by one", () => {
    const out = insertRow(base, 0, true);
    expect(out.rows).toHaveLength(base.rows.length + 1);
  });

  it("inserted row is all empty strings", () => {
    const out = insertRow(base, 0, true);
    expect(out.rows[1]).toEqual(["", ""]);
  });

  it("original data rows are preserved after insert", () => {
    const out = insertRow(base, 0, true);
    expect(out.rows[0]).toEqual(["Alice", "30"]);
    expect(out.rows[2]).toEqual(["Bob", "25"]);
  });

  it("inserts above index 1 (below=false)", () => {
    const out = insertRow(base, 1, false);
    expect(out.rows[0]).toEqual(["Alice", "30"]);
    expect(out.rows[1]).toEqual(["", ""]);
    expect(out.rows[2]).toEqual(["Bob", "25"]);
  });

  it("inserting below last index appends a row", () => {
    const out = insertRow(base, base.rows.length - 1, true);
    expect(out.rows).toHaveLength(base.rows.length + 1);
    expect(out.rows[out.rows.length - 1]).toEqual(["", ""]);
  });

  it("new row has correct column count matching headers", () => {
    const out = insertRow(base, 0, false);
    const newRow = out.rows[0];
    expect(newRow).toHaveLength(base.headers.length);
  });
});

describe("deleteRow", () => {
  const base = parseTable(SIMPLE_TABLE);

  it("removes the row at the specified index", () => {
    const out = deleteRow(base, 0);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toEqual(["Bob", "25"]);
  });

  it("removes the last row", () => {
    const out = deleteRow(base, 1);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toEqual(["Alice", "30"]);
  });

  it("is a no-op for out-of-range index (above)", () => {
    const out = deleteRow(base, 99);
    expect(out.rows).toEqual(base.rows);
  });

  it("is a no-op for negative index", () => {
    const out = deleteRow(base, -1);
    expect(out.rows).toEqual(base.rows);
  });

  it("can delete the only data row resulting in an empty-row table", () => {
    const singleRow = parseTable(`| A |\n| --- |\n| x |`);
    const out = deleteRow(singleRow, 0);
    expect(out.rows).toHaveLength(0);
    expect(out.headers).toEqual(["A"]);
  });
});

// ── 5. insertColumn / deleteColumn ────────────────────────────────────────────

describe("insertColumn", () => {
  const base = parseTable(SIMPLE_TABLE);

  it("adds a column, increasing header count by 1", () => {
    const out = insertColumn(base, 0, false);
    expect(out.headers).toHaveLength(base.headers.length + 1);
  });

  it("new column header is empty string", () => {
    const out = insertColumn(base, 0, false);
    expect(out.headers[0]).toBe("");
  });

  it("inserts left of index 0 — existing columns shift right", () => {
    const out = insertColumn(base, 0, false);
    expect(out.headers[1]).toBe("Name");
    expect(out.headers[2]).toBe("Age");
  });

  it("inserts right of index 0", () => {
    const out = insertColumn(base, 0, true);
    expect(out.headers[0]).toBe("Name");
    expect(out.headers[1]).toBe("");
    expect(out.headers[2]).toBe("Age");
  });

  it("every data row in result has the new column count", () => {
    const out = insertColumn(base, 1, true);
    for (const row of out.rows) {
      expect(row).toHaveLength(out.headers.length);
    }
  });

  it("alignment array grows by 1 and new entry is 'none'", () => {
    const out = insertColumn(base, 0, false);
    expect(out.alignments).toHaveLength(out.headers.length);
    expect(out.alignments[0]).toBe("none");
  });
});

describe("deleteColumn", () => {
  const base = parseTable(SIMPLE_TABLE);

  it("removes the column at the specified index", () => {
    const out = deleteColumn(base, 0);
    expect(out.headers).toEqual(["Age"]);
  });

  it("removes corresponding cell from each data row", () => {
    const out = deleteColumn(base, 0);
    expect(out.rows[0]).toEqual(["30"]);
    expect(out.rows[1]).toEqual(["25"]);
  });

  it("removes alignment entry", () => {
    const aligned = parseTable(ALIGNED_TABLE);
    const out = deleteColumn(aligned, 0); // remove Left column
    expect(out.alignments).toHaveLength(3);
    expect(out.alignments[0]).toBe("center");
  });

  it("is a no-op when table has only 1 column", () => {
    const single = parseTable(`| A |\n| --- |\n| x |`);
    const out = deleteColumn(single, 0);
    expect(out.headers).toEqual(["A"]);
  });

  it("is a no-op for out-of-range index", () => {
    const out = deleteColumn(base, 99);
    expect(out.headers).toEqual(base.headers);
  });
});

// ── 6. setColumnAlignment ─────────────────────────────────────────────────────

describe("setColumnAlignment", () => {
  const base = parseTable(SIMPLE_TABLE);

  it("sets left alignment on column 0", () => {
    const out = setColumnAlignment(base, 0, "left");
    expect(out.alignments[0]).toBe("left");
  });

  it("sets center alignment on column 1", () => {
    const out = setColumnAlignment(base, 1, "center");
    expect(out.alignments[1]).toBe("center");
  });

  it("sets right alignment", () => {
    const out = setColumnAlignment(base, 0, "right");
    expect(out.alignments[0]).toBe("right");
  });

  it("resets alignment to none", () => {
    const aligned = parseTable(ALIGNED_TABLE);
    const out = setColumnAlignment(aligned, 0, "none");
    expect(out.alignments[0]).toBe("none");
  });

  it("is a no-op for out-of-range column index", () => {
    const out = setColumnAlignment(base, 99, "center");
    expect(out.alignments).toEqual(base.alignments);
  });

  it("alignment persists through serialize/parse round-trip", () => {
    const aligned = setColumnAlignment(base, 0, "center");
    const serialized = serializeTable(aligned);
    const reparsed = parseTable(serialized);
    expect(reparsed.alignments[0]).toBe("center");
  });

  it("right alignment persists through round-trip", () => {
    const aligned = setColumnAlignment(base, 1, "right");
    const serialized = serializeTable(aligned);
    const reparsed = parseTable(serialized);
    expect(reparsed.alignments[1]).toBe("right");
  });

  it("left alignment persists through round-trip", () => {
    const aligned = setColumnAlignment(base, 0, "left");
    const serialized = serializeTable(aligned);
    const reparsed = parseTable(serialized);
    expect(reparsed.alignments[0]).toBe("left");
  });
});

// ── 7. getCellContent / setCellContent ────────────────────────────────────────

describe("getCellContent", () => {
  const base = parseTable(SIMPLE_TABLE);

  it("returns the correct cell value at [0, 0]", () => {
    expect(getCellContent(base, 0, 0)).toBe("Alice");
  });

  it("returns the correct cell value at [0, 1]", () => {
    expect(getCellContent(base, 0, 1)).toBe("30");
  });

  it("returns the correct cell value at [1, 0]", () => {
    expect(getCellContent(base, 1, 0)).toBe("Bob");
  });

  it("returns '' for out-of-range row", () => {
    expect(getCellContent(base, 99, 0)).toBe("");
  });

  it("returns '' for out-of-range col", () => {
    expect(getCellContent(base, 0, 99)).toBe("");
  });
});

describe("setCellContent", () => {
  const base = parseTable(SIMPLE_TABLE);

  it("updates cell at [0, 0]", () => {
    const out = setCellContent(base, 0, 0, "Charlie");
    expect(getCellContent(out, 0, 0)).toBe("Charlie");
  });

  it("does not mutate other cells when setting one cell", () => {
    const out = setCellContent(base, 0, 0, "Charlie");
    expect(getCellContent(out, 0, 1)).toBe("30");
    expect(getCellContent(out, 1, 0)).toBe("Bob");
  });

  it("is a no-op for out-of-range row", () => {
    const out = setCellContent(base, 99, 0, "X");
    expect(out.rows).toEqual(base.rows);
  });

  it("is a no-op for out-of-range col", () => {
    const out = setCellContent(base, 0, 99, "X");
    expect(out.rows).toEqual(base.rows);
  });

  it("cell update persists through serialize/parse round-trip", () => {
    const updated = setCellContent(base, 1, 1, "99");
    const serialized = serializeTable(updated);
    const reparsed = parseTable(serialized);
    expect(getCellContent(reparsed, 1, 1)).toBe("99");
  });
});

// ── 8. applyTableEdit ─────────────────────────────────────────────────────────

describe("applyTableEdit — insertRow", () => {
  it("inserts a row below index 0 in a standalone table document", () => {
    const cursor = SIMPLE_TABLE.indexOf("Alice");
    const result = applyTableEdit(SIMPLE_TABLE, cursor, {
      kind: "insertRow",
      atIndex: 0,
      below: true,
    });
    const table = parseTable(result);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]).toEqual(["Alice", "30"]);
    expect(table.rows[1]).toEqual(["", ""]);
  });

  it("inserts a row in a table within a larger document", () => {
    const cursor = TABLE_IN_DOC.indexOf("Alice");
    const result = applyTableEdit(TABLE_IN_DOC, cursor, {
      kind: "insertRow",
      atIndex: 0,
      below: false,
    });
    // Text before and after the table must be preserved
    expect(result).toContain("# Heading");
    expect(result).toContain("Some text after");
    // Table must have the new row
    const range = findTableRange(result, cursor);
    const table = parseTable(range!.source);
    expect(table.rows).toHaveLength(3);
  });
});

describe("applyTableEdit — deleteRow", () => {
  it("deletes the first data row", () => {
    const cursor = SIMPLE_TABLE.indexOf("Alice");
    const result = applyTableEdit(SIMPLE_TABLE, cursor, {
      kind: "deleteRow",
      atIndex: 0,
    });
    const table = parseTable(result);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toEqual(["Bob", "25"]);
  });
});

describe("applyTableEdit — insertCol", () => {
  it("inserts a column to the right of index 0", () => {
    const cursor = SIMPLE_TABLE.indexOf("Alice");
    const result = applyTableEdit(SIMPLE_TABLE, cursor, {
      kind: "insertCol",
      atIndex: 0,
      right: true,
    });
    const table = parseTable(result);
    expect(table.headers).toHaveLength(3);
    expect(table.headers[0]).toBe("Name");
    expect(table.headers[1]).toBe("");
  });
});

describe("applyTableEdit — deleteCol", () => {
  it("deletes column 0 and preserves column 1", () => {
    const cursor = SIMPLE_TABLE.indexOf("Alice");
    const result = applyTableEdit(SIMPLE_TABLE, cursor, {
      kind: "deleteCol",
      atIndex: 0,
    });
    const table = parseTable(result);
    expect(table.headers).toEqual(["Age"]);
    expect(table.rows[0]).toEqual(["30"]);
  });
});

describe("applyTableEdit — setAlignment", () => {
  it("sets center alignment on column 0 and persists it", () => {
    const cursor = SIMPLE_TABLE.indexOf("Alice");
    const result = applyTableEdit(SIMPLE_TABLE, cursor, {
      kind: "setAlignment",
      colIndex: 0,
      alignment: "center",
    });
    const table = parseTable(result);
    expect(table.alignments[0]).toBe("center");
  });

  it("sets right alignment on column 1", () => {
    const cursor = SIMPLE_TABLE.indexOf("Alice");
    const result = applyTableEdit(SIMPLE_TABLE, cursor, {
      kind: "setAlignment",
      colIndex: 1,
      alignment: "right",
    });
    const table = parseTable(result);
    expect(table.alignments[1]).toBe("right");
  });
});

describe("applyTableEdit — setCellContent", () => {
  it("updates the cell at [0, 0]", () => {
    const cursor = SIMPLE_TABLE.indexOf("Alice");
    const result = applyTableEdit(SIMPLE_TABLE, cursor, {
      kind: "setCellContent",
      row: 0,
      col: 0,
      content: "Charlie",
    });
    const table = parseTable(result);
    expect(getCellContent(table, 0, 0)).toBe("Charlie");
    expect(getCellContent(table, 0, 1)).toBe("30");
  });
});

describe("applyTableEdit — cursor outside table", () => {
  it("returns the markdown unchanged when cursor is not in a table", () => {
    const md = "# Title\n\nNo table here.\n";
    const result = applyTableEdit(md, 5, { kind: "deleteRow", atIndex: 0 });
    expect(result).toBe(md);
  });
});

// ── 9. HTML export structural checks ─────────────────────────────────────────

describe("HTML export — table structure preserved in serialized Markdown", () => {
  it("serializeTable output contains all header cells", () => {
    const table: ParsedTable = {
      headers: ["Product", "Price", "Stock"],
      alignments: ["left", "right", "center"],
      rows: [
        ["Widget", "$9.99", "100"],
        ["Gadget", "$24.99", "50"],
      ],
    };
    const md = serializeTable(table);
    expect(md).toContain("Product");
    expect(md).toContain("Price");
    expect(md).toContain("Stock");
  });

  it("serializeTable output contains all data cells", () => {
    const table: ParsedTable = {
      headers: ["A", "B"],
      alignments: ["none", "none"],
      rows: [["cell-a1", "cell-b1"], ["cell-a2", "cell-b2"]],
    };
    const md = serializeTable(table);
    expect(md).toContain("cell-a1");
    expect(md).toContain("cell-b2");
  });

  it("alignment markers appear correctly in the serialized separator row", () => {
    const table: ParsedTable = {
      headers: ["L", "C", "R", "N"],
      alignments: ["left", "center", "right", "none"],
      rows: [],
    };
    const md = serializeTable(table);
    const lines = md.split("\n");
    const sep = lines[1];
    expect(sep).toContain(":---");
    expect(sep).toContain(":---:");
    expect(sep).toContain("---:");
  });

  it("a multi-edit sequence (insert col + set alignment) round-trips correctly", () => {
    const initial = buildEmptyTable(2, 2);
    const cursor = 0;
    let md = applyTableEdit(initial, cursor, {
      kind: "insertCol",
      atIndex: 1,
      right: true,
    });
    md = applyTableEdit(md, cursor, {
      kind: "setAlignment",
      colIndex: 2,
      alignment: "right",
    });
    const table = parseTable(md);
    expect(table.headers).toHaveLength(3);
    expect(table.alignments[2]).toBe("right");
  });

  it("cell copy/paste simulation: setCellContent copies value from one cell to another", () => {
    const table = parseTable(SIMPLE_TABLE);
    const srcContent = getCellContent(table, 0, 0); // "Alice"
    const updated = setCellContent(table, 1, 0, srcContent);
    expect(getCellContent(updated, 1, 0)).toBe("Alice");
    // Original source cell unchanged
    expect(getCellContent(updated, 0, 0)).toBe("Alice");
  });
});
