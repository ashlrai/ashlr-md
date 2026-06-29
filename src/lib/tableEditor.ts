/**
 * tableEditor.ts — Pure logic for GFM table manipulation.
 *
 * All functions operate on raw Markdown strings (no ProseMirror runtime
 * required), making them easy to unit-test and reuse across WYSIWYG and
 * source views.
 *
 * Supported operations:
 *  - {@link isInsideTable}      — detect whether a cursor offset lands in a table
 *  - {@link parseTable}         — parse a GFM table block into a structured form
 *  - {@link serializeTable}     — serialize a parsed table back to Markdown
 *  - {@link buildEmptyTable}    — create a blank GFM table with given dimensions
 *  - {@link insertRow}          — insert a row above or below a given row index
 *  - {@link deleteRow}          — delete a row by index
 *  - {@link insertColumn}       — insert a column left or right of a given col index
 *  - {@link deleteColumn}       — delete a column by index
 *  - {@link setColumnAlignment} — update the alignment marker for a column
 *  - {@link getCellContent}     — read cell text at [row, col]
 *  - {@link setCellContent}     — write cell text at [row, col]
 *  - {@link findTableRange}     — locate the start/end offsets of the table block
 *                                 that contains a given cursor position
 *  - {@link applyTableEdit}     — apply a {@link TableEdit} operation to a
 *                                 Markdown document string and return the result
 */

// ── Types ──────────────────────────────────────────────────────────────────────

/** Horizontal alignment for a GFM table column. */
export type ColAlignment = "left" | "center" | "right" | "none";

/** A parsed representation of a single GFM table. */
export interface ParsedTable {
  /** Header row cells (trimmed). */
  headers: string[];
  /**
   * Alignment markers for each column, derived from the separator row.
   * Length === headers.length.
   */
  alignments: ColAlignment[];
  /** Data rows — each is an array of cell strings (trimmed). */
  rows: string[][];
}

/** A contiguous table block located inside a Markdown document. */
export interface TableRange {
  /** Character offset where the table block starts (inclusive). */
  start: number;
  /** Character offset where the table block ends (exclusive). */
  end: number;
  /** The raw Markdown source of the table block. */
  source: string;
}

/** Discriminated-union of all table mutations that {@link applyTableEdit} accepts. */
export type TableEdit =
  | { kind: "insertRow"; atIndex: number; below: boolean }
  | { kind: "deleteRow"; atIndex: number }
  | { kind: "insertCol"; atIndex: number; right: boolean }
  | { kind: "deleteCol"; atIndex: number }
  | { kind: "setAlignment"; colIndex: number; alignment: ColAlignment }
  | { kind: "setCellContent"; row: number; col: number; content: string };

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Pad a cell string with single spaces on each side. */
function padCell(value: string): string {
  return ` ${value} `;
}

/** Render a row as a GFM pipe-delimited line (no trailing newline). */
function renderRow(cells: string[]): string {
  return `|${cells.map(padCell).join("|")}|`;
}

/** Build the separator row from an alignments array. */
function renderSeparator(alignments: ColAlignment[]): string {
  const cells = alignments.map((a) => {
    switch (a) {
      case "left":   return ":---";
      case "center": return ":---:";
      case "right":  return "---:";
      default:       return "---";
    }
  });
  return `|${cells.map(padCell).join("|")}|`;
}

/** Split a pipe-delimited row into trimmed cell strings. */
function splitRow(line: string): string[] {
  // Strip optional leading/trailing `|`, then split on `|`.
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const cleaned = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return cleaned.split("|").map((c) => c.trim());
}

/** Return true if a line looks like a GFM separator row (---). */
function isSeparatorLine(line: string): boolean {
  return /^\s*\|?[\s|:*-]+\|?\s*$/.test(line) && /[-]/.test(line);
}

/** Clamp a value to [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ── Table detection ────────────────────────────────────────────────────────────

/**
 * Return true when `cursorOffset` is positioned anywhere within a GFM table
 * block in `markdown` (including the separator row and all data rows).
 */
export function isInsideTable(markdown: string, cursorOffset: number): boolean {
  const range = findTableRange(markdown, cursorOffset);
  return range !== null;
}

/**
 * Find the contiguous GFM table block that contains `cursorOffset`.
 *
 * Returns `null` when the cursor is not inside a table.
 */
export function findTableRange(markdown: string, cursorOffset: number): TableRange | null {
  const lines = markdown.split("\n");

  // Build a map of line-start offsets.
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1; // +1 for '\n'
  }

  // Find which line the cursor is on.
  let cursorLine = lineStarts.length - 1;
  for (let i = 0; i < lineStarts.length; i++) {
    const end = i + 1 < lineStarts.length ? lineStarts[i + 1] : markdown.length + 1;
    if (cursorOffset >= lineStarts[i] && cursorOffset < end) {
      cursorLine = i;
      break;
    }
  }

  // A GFM table is 3+ consecutive lines: header | separator | data*.
  // Scan for table blocks by finding separator rows (row 1 of each table).
  // We then determine if cursorLine is within any such block.

  for (let sepIdx = 1; sepIdx < lines.length; sepIdx++) {
    if (!isSeparatorLine(lines[sepIdx])) continue;
    // The header line is immediately before the separator.
    const headerIdx = sepIdx - 1;
    // Data rows follow until a non-table line or EOF.
    let lastDataIdx = sepIdx;
    for (let r = sepIdx + 1; r < lines.length; r++) {
      const l = lines[r].trim();
      // Empty line or non-pipe line ends the table.
      if (l === "" || !l.includes("|")) break;
      lastDataIdx = r;
    }
    if (cursorLine >= headerIdx && cursorLine <= lastDataIdx) {
      const start = lineStarts[headerIdx];
      const tableEnd =
        lastDataIdx + 1 < lineStarts.length
          ? lineStarts[lastDataIdx + 1]
          : markdown.length;
      // Don't include trailing newline in the source; it stays as a gap.
      const end = tableEnd;
      return { start, end, source: markdown.slice(start, end) };
    }
  }

  return null;
}

// ── Parse / serialize ──────────────────────────────────────────────────────────

/**
 * Parse a GFM table source string into a {@link ParsedTable}.
 *
 * The source should be the raw block (header + separator + rows).
 * Tolerates missing trailing pipes.
 */
export function parseTable(source: string): ParsedTable {
  const lines = source.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) {
    return { headers: [], alignments: [], rows: [] };
  }

  const headers = splitRow(lines[0]);
  const colCount = headers.length;

  // Derive alignments from separator row.
  const sepCells = splitRow(lines[1]);
  const alignments: ColAlignment[] = sepCells.map((cell): ColAlignment => {
    const c = cell.trim();
    if (c.startsWith(":") && c.endsWith(":")) return "center";
    if (c.startsWith(":")) return "left";
    if (c.endsWith(":")) return "right";
    return "none";
  });

  // Pad/trim to colCount.
  while (alignments.length < colCount) alignments.push("none");

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitRow(lines[i]);
    // Normalise to colCount.
    while (cells.length < colCount) cells.push("");
    rows.push(cells.slice(0, colCount));
  }

  return { headers, alignments, rows };
}

/**
 * Serialize a {@link ParsedTable} back to a GFM Markdown string.
 * Does NOT add a trailing newline.
 */
export function serializeTable(table: ParsedTable): string {
  const lines: string[] = [
    renderRow(table.headers),
    renderSeparator(table.alignments),
    ...table.rows.map((r) => renderRow(r)),
  ];
  return lines.join("\n");
}

// ── Builder ────────────────────────────────────────────────────────────────────

/**
 * Build an empty GFM table with `rows` data rows and `cols` columns.
 *
 * @param rows  Number of data rows (≥ 1).
 * @param cols  Number of columns (≥ 1).
 * @returns     A Markdown table string.
 */
export function buildEmptyTable(rows: number, cols: number): string {
  const safeRows = Math.max(1, rows);
  const safeCols = Math.max(1, cols);

  const headers = Array.from({ length: safeCols }, (_, i) => `Column ${i + 1}`);
  const alignments: ColAlignment[] = Array(safeCols).fill("none");
  const dataRows: string[][] = Array.from({ length: safeRows }, () =>
    Array(safeCols).fill(""),
  );

  return serializeTable({ headers, alignments, rows: dataRows });
}

// ── Row operations ─────────────────────────────────────────────────────────────

/**
 * Insert a blank row at position determined by `atIndex` and `below`.
 *
 * - `atIndex` is the 0-based data-row index (not counting header/separator).
 * - `below: true` inserts after `atIndex`; `false` inserts before `atIndex`.
 * - When the table has no data rows yet, the new row is always appended.
 */
export function insertRow(table: ParsedTable, atIndex: number, below: boolean): ParsedTable {
  const cols = table.headers.length;
  const emptyRow = Array<string>(cols).fill("");
  const rows = [...table.rows];
  const insertAt = below
    ? clamp(atIndex + 1, 0, rows.length)
    : clamp(atIndex, 0, rows.length);
  rows.splice(insertAt, 0, emptyRow);
  return { ...table, rows };
}

/**
 * Delete the data row at `atIndex` (0-based).
 * A no-op when the table has 0 data rows or the index is out of range.
 */
export function deleteRow(table: ParsedTable, atIndex: number): ParsedTable {
  if (atIndex < 0 || atIndex >= table.rows.length) return table;
  const rows = table.rows.filter((_, i) => i !== atIndex);
  return { ...table, rows };
}

// ── Column operations ──────────────────────────────────────────────────────────

/**
 * Insert a blank column at the position determined by `atIndex` and `right`.
 *
 * - `atIndex` is 0-based column index.
 * - `right: true` inserts after `atIndex`; `false` inserts before.
 */
export function insertColumn(
  table: ParsedTable,
  atIndex: number,
  right: boolean,
): ParsedTable {
  const cols = table.headers.length;
  const insertAt = right
    ? clamp(atIndex + 1, 0, cols)
    : clamp(atIndex, 0, cols);

  const headers = [...table.headers];
  headers.splice(insertAt, 0, "");

  const alignments = [...table.alignments];
  alignments.splice(insertAt, 0, "none");

  const rows = table.rows.map((row) => {
    const newRow = [...row];
    newRow.splice(insertAt, 0, "");
    return newRow;
  });

  return { headers, alignments, rows };
}

/**
 * Delete the column at `atIndex` (0-based).
 * A no-op when the table has ≤ 1 column or the index is out of range.
 */
export function deleteColumn(table: ParsedTable, atIndex: number): ParsedTable {
  if (table.headers.length <= 1) return table;
  if (atIndex < 0 || atIndex >= table.headers.length) return table;

  const headers = table.headers.filter((_, i) => i !== atIndex);
  const alignments = table.alignments.filter((_, i) => i !== atIndex);
  const rows = table.rows.map((row) => row.filter((_, i) => i !== atIndex));

  return { headers, alignments, rows };
}

// ── Alignment ──────────────────────────────────────────────────────────────────

/**
 * Update the alignment of the column at `colIndex`.
 * A no-op when `colIndex` is out of range.
 */
export function setColumnAlignment(
  table: ParsedTable,
  colIndex: number,
  alignment: ColAlignment,
): ParsedTable {
  if (colIndex < 0 || colIndex >= table.alignments.length) return table;
  const alignments = [...table.alignments];
  alignments[colIndex] = alignment;
  return { ...table, alignments };
}

// ── Cell access ────────────────────────────────────────────────────────────────

/**
 * Return the content of the cell at [row, col] (0-based, data rows only).
 * Returns `""` when coordinates are out of range.
 */
export function getCellContent(
  table: ParsedTable,
  row: number,
  col: number,
): string {
  return table.rows[row]?.[col] ?? "";
}

/**
 * Return a new table with the cell at [row, col] set to `content`.
 * A no-op when coordinates are out of range.
 */
export function setCellContent(
  table: ParsedTable,
  row: number,
  col: number,
  content: string,
): ParsedTable {
  if (row < 0 || row >= table.rows.length) return table;
  if (col < 0 || col >= table.headers.length) return table;
  const rows = table.rows.map((r, ri) => {
    if (ri !== row) return r;
    return r.map((c, ci) => (ci === col ? content : c));
  });
  return { ...table, rows };
}

// ── High-level document-level edit ────────────────────────────────────────────

/**
 * Locate the table block containing `cursorOffset` in `markdown`, apply the
 * given {@link TableEdit}, and return the updated document string.
 *
 * Returns `markdown` unchanged when no table is found at the cursor.
 */
export function applyTableEdit(
  markdown: string,
  cursorOffset: number,
  edit: TableEdit,
): string {
  const range = findTableRange(markdown, cursorOffset);
  if (!range) return markdown;

  let table = parseTable(range.source);

  switch (edit.kind) {
    case "insertRow":
      table = insertRow(table, edit.atIndex, edit.below);
      break;
    case "deleteRow":
      table = deleteRow(table, edit.atIndex);
      break;
    case "insertCol":
      table = insertColumn(table, edit.atIndex, edit.right);
      break;
    case "deleteCol":
      table = deleteColumn(table, edit.atIndex);
      break;
    case "setAlignment":
      table = setColumnAlignment(table, edit.colIndex, edit.alignment);
      break;
    case "setCellContent":
      table = setCellContent(table, edit.row, edit.col, edit.content);
      break;
  }

  const newSource = serializeTable(table);
  return markdown.slice(0, range.start) + newSource + markdown.slice(range.end);
}
