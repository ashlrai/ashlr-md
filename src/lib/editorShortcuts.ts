/**
 * editorShortcuts.ts — helpers for three editor-quality-of-life features:
 *
 *  1. List continuation — detectListContext / continueList
 *     When the cursor is at the end of a list item line, pressing Enter should
 *     insert a new bullet/number on the next line with correct indentation.
 *
 *  2. Table wizard — buildTableMarkdown
 *     Generates a well-formed GFM table with the requested dimensions.
 *
 *  3. Smart link detection on paste — isUrl / extractLinkTitle
 *     When the clipboard contains a plain URL, optionally fetches the page
 *     title via a Tauri IPC invoke and returns a Markdown link string.
 *
 * All helpers are pure functions (except extractLinkTitle which is async due
 * to the Tauri call) so they are straightforward to unit-test without any
 * browser or ProseMirror runtime.
 */

// ── 1. List continuation ──────────────────────────────────────────────────────

/**
 * The contextual information extracted from a list-item line so that the
 * caller can construct the correct continuation text.
 */
export interface ListContext {
  /** Leading whitespace that precedes the bullet marker. */
  indent: string;
  /** The bullet/marker token, e.g. "-", "*", "+", "1.", "42.". */
  marker: string;
  /**
   * True when the marker is an ordered list counter (ends with ".").
   * False for unordered bullets (-, *, +).
   */
  ordered: boolean;
  /**
   * For ordered lists, the numeric value parsed from the marker so the caller
   * can produce the next sequential number.
   */
  orderedValue: number;
  /** The text content of the list item (trimmed). */
  content: string;
}

/** Regex that matches a GFM list item leader at the start of a string. */
const LIST_ITEM_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)/;

/**
 * Parse `line` as a list item.
 *
 * Returns `null` when `line` is not a list item (so the caller can fall back
 * to default Enter behaviour).
 */
export function detectListContext(line: string): ListContext | null {
  const m = LIST_ITEM_RE.exec(line);
  if (!m) return null;

  const indent = m[1];
  const marker = m[2];
  const content = m[3].trimEnd();
  const ordered = /^\d+\.$/.test(marker);
  const orderedValue = ordered ? parseInt(marker, 10) : 0;

  return { indent, marker, ordered, orderedValue, content };
}

/**
 * Given the current line's list context, return the text that should be
 * inserted when the user presses Enter at the end of that line.
 *
 * Behaviour:
 *  - Empty item (content is blank) → clear the bullet (return an empty string
 *    so the caller replaces the current line with a blank line, exiting the
 *    list). This mirrors VS Code / Obsidian behaviour.
 *  - Non-empty item → insert a newline + new bullet (incremented counter for
 *    ordered lists, same character for unordered).
 *
 * The returned string is meant to be **appended** to the current line's text
 * before the caller moves the cursor to the end of the new bullet.
 */
export function continueList(ctx: ListContext): string {
  if (ctx.content === "") {
    // Second Enter on an empty item exits the list.
    return "";
  }
  const nextMarker = ctx.ordered ? `${ctx.orderedValue + 1}.` : ctx.marker;
  return `\n${ctx.indent}${nextMarker} `;
}

// ── 2. Table wizard ────────────────────────────────────────────────────────────

/**
 * Build a GFM Markdown table string with `rows` data rows and `cols` columns.
 *
 * The header row uses generic "Header N" labels and data cells use "Cell R,C"
 * placeholders. The separator row uses `---` for each column.
 *
 * Constraints:
 *  - cols ≥ 1, rows ≥ 1 (clamped if caller passes lower values).
 *  - Maximum cols/rows are not enforced here; that's the UI's concern.
 *
 * Example — buildTableMarkdown(2, 3):
 * ```
 * | Header 1 | Header 2 | Header 3 |
 * | --- | --- | --- |
 * | Cell 1,1 | Cell 1,2 | Cell 1,3 |
 * | Cell 2,1 | Cell 2,2 | Cell 2,3 |
 * ```
 */
export function buildTableMarkdown(rows: number, cols: number): string {
  const r = Math.max(1, rows);
  const c = Math.max(1, cols);

  const headerCells = Array.from({ length: c }, (_, i) => `Header ${i + 1}`);
  const sepCells = Array.from({ length: c }, () => "---");

  const headerRow = `| ${headerCells.join(" | ")} |`;
  const sepRow = `| ${sepCells.join(" | ")} |`;

  const dataRows = Array.from({ length: r }, (_, rowIdx) => {
    const cells = Array.from({ length: c }, (_, colIdx) => `Cell ${rowIdx + 1},${colIdx + 1}`);
    return `| ${cells.join(" | ")} |`;
  });

  return [headerRow, sepRow, ...dataRows].join("\n");
}

// ── 3. Smart link detection / title extraction ────────────────────────────────

/** Regex that matches a plain http/https/www URL (no surrounding text). */
const URL_RE = /^(https?:\/\/|www\.)\S+$/i;

/**
 * Returns `true` when `text` looks like a standalone URL that the smart-link
 * feature should act on.
 */
export function isUrl(text: string): boolean {
  const t = text.trim();
  return URL_RE.test(t);
}

/**
 * Normalise `url` to include a protocol so `fetch` (or Tauri's HTTP client)
 * can resolve it. `www.` URLs get `https://` prepended.
 */
export function normaliseUrl(url: string): string {
  const t = url.trim();
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

/**
 * Attempt to fetch the HTML `<title>` of `url` via a Tauri IPC invoke.
 *
 * The Rust side is expected to expose a command named `fetch_page_title` that
 * accepts `{ url: string }` and returns a `string | null`.
 *
 * Falls back to `null` on any error (network failure, IPC unavailable, no
 * title tag in the response, etc.) so callers can degrade gracefully.
 *
 * @param url   The URL whose title should be fetched (protocol optional; see
 *              {@link normaliseUrl}).
 * @param invoke  Injected Tauri invoke function — defaults to the real Tauri
 *                invoke when available, otherwise `null`.  Passing a mock here
 *                keeps tests fully offline and deterministic.
 */
export async function extractLinkTitle(
  url: string,
  invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null,
): Promise<string | null> {
  // Resolve the real Tauri invoke lazily so the module can be imported in a
  // plain Node / vitest environment without crashing.
  let invokeFn = invoke;
  if (!invokeFn) {
    try {
      const tauri = await import("@tauri-apps/api/core");
      invokeFn = tauri.invoke as (
        cmd: string,
        args?: Record<string, unknown>,
      ) => Promise<unknown>;
    } catch {
      // Not running inside Tauri (e.g. unit tests, browser dev mode).
      return null;
    }
  }

  try {
    const result = await invokeFn("fetch_page_title", { url: normaliseUrl(url) });
    if (typeof result === "string" && result.trim().length > 0) {
      return result.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Convert a pasted URL into a Markdown link string.
 *
 * 1. Tries to fetch the page title via {@link extractLinkTitle}.
 * 2. Falls back to `[Link](url)` when no title is available.
 *
 * @param url       Raw pasted text (will be normalised).
 * @param invoke    Tauri invoke override (useful in tests).
 * @returns         A Markdown link string ready to be inserted at the cursor.
 */
export async function buildLinkMarkdown(
  url: string,
  invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null,
): Promise<string> {
  const normUrl = normaliseUrl(url.trim());
  const title = await extractLinkTitle(url, invoke);
  const label = title ?? "Link";
  return `[${label}](${normUrl})`;
}
