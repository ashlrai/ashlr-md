/**
 * snippets.ts — Markdown syntax autocomplete + snippet engine for SourceEditor.
 *
 * Provides:
 *   - Built-in smart completions for common Markdown constructs (link, wikilink,
 *     table, blockquote, code fence, callout, checkbox, heading, HR, bold, italic,
 *     strikethrough, footnote, definition list, task list, HTML comment).
 *   - User-defined snippets (persisted in settingsStore).
 *   - Context-aware: suppresses Markdown snippets inside fenced code blocks.
 *   - CodeMirror 6 `CompletionSource` API integration via `markdownSnippetSource`.
 *   - `$0`, `$1`…`$9` tabstop syntax (via CodeMirror's `snippetCompletion`).
 *   - Table row auto-insert on `|` at end of a table row.
 *   - `buildSnippetExtension` assembles the full CodeMirror extension set.
 *
 * Cursor jump syntax used in templates:
 *   `$1`, `$2` … — tabstops visited in order (Tab / Shift-Tab).
 *   `$0`         — final cursor position.
 *
 * This module is framework-free; it depends only on `@codemirror/autocomplete`,
 * `@codemirror/state`, and `@codemirror/view` — all of which are already bundled.
 */

import {
  autocompletion,
  type Completion,
  CompletionContext,
  type CompletionResult,
  completionKeymap,
  nextSnippetField,
  prevSnippetField,
  snippetCompletion,
} from "@codemirror/autocomplete";
import { type Extension, StateEffect } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A user-defined snippet entry persisted in settingsStore. */
export interface UserSnippet {
  /** Short trigger word shown in the completion list (e.g. "mysnip"). */
  label: string;
  /** Human-readable description shown next to the label. */
  detail?: string;
  /**
   * The snippet template.  Use `$1`, `$2` for tabstops and `$0` for the final
   * cursor position.  Plain `$` in output must be escaped as `\$`.
   */
  template: string;
}

// ---------------------------------------------------------------------------
// Helpers — context detection
// ---------------------------------------------------------------------------

/**
 * Return true when `pos` is inside a fenced code block (``` or ~~~) in `doc`.
 *
 * We scan backward from `pos` for an opening fence and forward (or to EOF) for
 * a closing fence.  If we find an opener with no closer before `pos`, the
 * cursor is inside a fence.
 *
 * This is intentionally a text-only heuristic that avoids needing the
 * full Lezer syntax tree — it works correctly in the vitest environment where
 * CodeMirror's parser is not initialised.
 */
export function isInsideFencedCode(doc: string, pos: number): boolean {
  const fence = /^(`{3,}|~{3,})/m;
  let searchPos = 0;
  let depth = 0;
  let lastFenceChar: string | null = null;

  while (searchPos < pos) {
    const sub = doc.slice(searchPos);
    const m = fence.exec(sub);
    if (!m) break;

    const absStart = searchPos + m.index;
    if (absStart >= pos) break;

    const ch = m[1][0]; // '`' or '~'

    if (depth === 0) {
      // Opening fence
      depth = 1;
      lastFenceChar = ch;
    } else if (ch === lastFenceChar) {
      // Closing fence — we're back outside
      depth = 0;
      lastFenceChar = null;
    }
    // advance past the fence line
    const nl = doc.indexOf("\n", absStart);
    searchPos = nl === -1 ? doc.length : nl + 1;
  }

  return depth === 1;
}

/**
 * Return the text of the current line up to `pos`.
 */
export function lineTextBefore(doc: string, pos: number): string {
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  return doc.slice(lineStart, pos);
}

/**
 * Return true when the cursor is on a table row line (line starts with `|`).
 */
export function isOnTableRow(doc: string, pos: number): boolean {
  const before = lineTextBefore(doc, pos);
  return before.trimStart().startsWith("|");
}

/**
 * Return true when the current line is a complete table row (ends with `|`)
 * and the cursor is at the very end of the line.
 */
export function isAtEndOfTableRow(doc: string, pos: number): boolean {
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd = doc.indexOf("\n", pos);
  const line =
    lineEnd === -1 ? doc.slice(lineStart) : doc.slice(lineStart, lineEnd);
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("|")) return false;
  // cursor must be at the very end of the line
  const atEnd = pos === (lineEnd === -1 ? doc.length : lineEnd);
  return atEnd && trimmed.endsWith("|");
}

// ---------------------------------------------------------------------------
// Built-in snippets catalogue
// ---------------------------------------------------------------------------

/** A raw snippet definition (before wrapping with snippetCompletion). */
interface RawSnippet {
  label: string;
  detail: string;
  template: string;
  /** Optional section grouping for the completion list. */
  section?: string;
  boost?: number;
}

/** All built-in Markdown snippet templates. */
export const BUILTIN_SNIPPETS: readonly RawSnippet[] = [
  // ── Links ────────────────────────────────────────────────────────────────
  {
    label: "[link]",
    detail: "Inline link",
    template: "[$1]($2)$0",
    section: "Links",
    boost: 10,
  },
  {
    label: "[[wikilink]]",
    detail: "Wikilink (Obsidian-style)",
    template: "[[$1]]$0",
    section: "Links",
    boost: 9,
  },
  {
    label: "[ref]",
    detail: "Reference-style link",
    template: "[$1][$2]$0",
    section: "Links",
  },
  {
    label: "![image]",
    detail: "Image embed",
    template: "![$1]($2)$0",
    section: "Links",
  },

  // ── Structure ────────────────────────────────────────────────────────────
  {
    label: "# Heading 1",
    detail: "H1 heading",
    template: "# $1$0",
    section: "Structure",
  },
  {
    label: "## Heading 2",
    detail: "H2 heading",
    template: "## $1$0",
    section: "Structure",
  },
  {
    label: "### Heading 3",
    detail: "H3 heading",
    template: "### $1$0",
    section: "Structure",
  },
  {
    label: "---",
    detail: "Horizontal rule",
    template: "---\n$0",
    section: "Structure",
  },

  // ── Code ─────────────────────────────────────────────────────────────────
  {
    label: "```code```",
    detail: "Fenced code block",
    template: "```$1\n$2\n```\n$0",
    section: "Code",
    boost: 8,
  },
  {
    label: "`inline`",
    detail: "Inline code",
    template: "`$1`$0",
    section: "Code",
  },

  // ── Tables ───────────────────────────────────────────────────────────────
  {
    label: "| table |",
    detail: "Markdown table",
    template:
      "| $1 | $2 |\n| --- | --- |\n| $3 | $4 |\n$0",
    section: "Tables",
    boost: 7,
  },

  // ── Quotes + callouts ────────────────────────────────────────────────────
  {
    label: "> blockquote",
    detail: "Blockquote",
    template: "> $1$0",
    section: "Quotes",
  },
  {
    label: "> [!NOTE]",
    detail: "Note callout (Obsidian/GitHub)",
    template: "> [!NOTE]\n> $1$0",
    section: "Quotes",
  },
  {
    label: "> [!TIP]",
    detail: "Tip callout",
    template: "> [!TIP]\n> $1$0",
    section: "Quotes",
  },
  {
    label: "> [!WARNING]",
    detail: "Warning callout",
    template: "> [!WARNING]\n> $1$0",
    section: "Quotes",
  },
  {
    label: "> [!IMPORTANT]",
    detail: "Important callout",
    template: "> [!IMPORTANT]\n> $1$0",
    section: "Quotes",
  },

  // ── Lists + tasks ────────────────────────────────────────────────────────
  {
    label: "- [ ] task",
    detail: "Checkbox / task item",
    template: "- [ ] $1$0",
    section: "Lists",
    boost: 6,
  },
  {
    label: "- [x] done",
    detail: "Checked task item",
    template: "- [x] $1$0",
    section: "Lists",
  },
  {
    label: "- list",
    detail: "Unordered list item",
    template: "- $1$0",
    section: "Lists",
  },
  {
    label: "1. ordered",
    detail: "Ordered list item",
    template: "1. $1$0",
    section: "Lists",
  },

  // ── Inline formatting ────────────────────────────────────────────────────
  {
    label: "**bold**",
    detail: "Bold text",
    template: "**$1**$0",
    section: "Formatting",
  },
  {
    label: "_italic_",
    detail: "Italic text",
    template: "_$1_$0",
    section: "Formatting",
  },
  {
    label: "~~strikethrough~~",
    detail: "Strikethrough",
    template: "~~$1~~$0",
    section: "Formatting",
  },
  {
    label: "==highlight==",
    detail: "Highlighted text",
    template: "==$1==$0",
    section: "Formatting",
  },

  // ── Footnotes + definitions ──────────────────────────────────────────────
  {
    label: "[^footnote]",
    detail: "Footnote reference",
    template: "[^$1]$0",
    section: "Advanced",
  },
  {
    label: "[^footnote]: def",
    detail: "Footnote definition",
    template: "[^$1]: $2$0",
    section: "Advanced",
  },

  // ── Misc ─────────────────────────────────────────────────────────────────
  {
    label: "<!-- comment -->",
    detail: "HTML comment",
    template: "<!-- $1 -->$0",
    section: "Advanced",
  },
];

// ---------------------------------------------------------------------------
// Build CodeMirror Completion objects
// ---------------------------------------------------------------------------

/**
 * Convert a `RawSnippet` into a CodeMirror `Completion` that applies the
 * snippet template (with tabstops) when selected.
 */
export function rawToCompletion(raw: RawSnippet): Completion {
  return snippetCompletion(raw.template, {
    label: raw.label,
    detail: raw.detail,
    type: "keyword",
    section: raw.section,
    boost: raw.boost,
  });
}

/**
 * Convert a `UserSnippet` (from settings) into a CodeMirror `Completion`.
 */
export function userSnippetToCompletion(s: UserSnippet): Completion {
  return snippetCompletion(s.template, {
    label: s.label,
    detail: s.detail ?? "Custom snippet",
    type: "text",
    section: "Custom",
  });
}

// ---------------------------------------------------------------------------
// CompletionSource
// ---------------------------------------------------------------------------

/**
 * Build a CodeMirror `CompletionSource` that:
 *   1. Returns `null` (no suggestions) when the cursor is inside a fenced code block.
 *   2. On `[` — surfaces link + wikilink completions.
 *   3. Otherwise — surfaces all built-in + user snippets, filtered by what has
 *      been typed so far on the current line.
 *
 * @param userSnippets — live array from settingsStore (may be empty).
 */
export function markdownSnippetSource(
  userSnippets: readonly UserSnippet[] = [],
): (context: CompletionContext) => CompletionResult | null {
  // Build the full completion list once per call (list is small, O(n) fine).
  const builtinCompletions = BUILTIN_SNIPPETS.map(rawToCompletion);
  const userCompletions = userSnippets.map(userSnippetToCompletion);
  const allCompletions: Completion[] = [...builtinCompletions, ...userCompletions];

  return (context: CompletionContext): CompletionResult | null => {
    const doc = context.state.doc.toString();
    const pos = context.pos;

    // ── Context guard: suppress inside fenced code blocks ──────────────────
    if (isInsideFencedCode(doc, pos)) return null;

    // ── Match what has been typed since the last whitespace / pipe / newline ─
    // This gives us the "prefix" to filter completions.
    const before = context.matchBefore(/[^\s|>]*$/);
    if (!before) return null;

    // Only show the completion popup when the user has typed ≥ 1 character or
    // has explicitly invoked autocomplete (context.explicit).
    if (before.text.length === 0 && !context.explicit) return null;

    return {
      from: before.from,
      options: allCompletions,
      filter: true,
    };
  };
}

// ---------------------------------------------------------------------------
// Table row auto-insert
// ---------------------------------------------------------------------------

/**
 * When `|` is typed at the end of a complete table row, insert a new empty row
 * and place the cursor in its first cell.
 *
 * Returns a CodeMirror `keymap` extension that handles the `|` key.
 */
export function tableRowKeymap(): Extension {
  return keymap.of([
    {
      key: "|",
      run(view) {
        const doc = context_docString(view);
        const pos = view.state.selection.main.head;

        // Only act at end-of-table-row, not in the middle of editing
        if (!isAtEndOfTableRow(doc, pos)) return false;

        // Count cells in the current row to mirror the structure
        const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
        const lineEnd = doc.indexOf("\n", pos);
        const line =
          lineEnd === -1 ? doc.slice(lineStart) : doc.slice(lineStart, lineEnd);

        // Build a new row with the same number of cells
        const cells = line
          .split("|")
          .filter((_, i, arr) => i > 0 && i < arr.length - 1);
        const newRow = "\n| " + cells.map(() => " ").join(" | ") + " |";

        view.dispatch({
          changes: { from: pos, to: pos, insert: newRow },
          selection: {
            // Place cursor inside the first cell of the new row
            anchor: pos + 3,
          },
        });
        return true;
      },
    },
  ]);
}

// Helper to get the full document string from an EditorView.
function context_docString(view: EditorView): string {
  return view.state.doc.toString();
}

// ---------------------------------------------------------------------------
// Full CodeMirror extension bundle
// ---------------------------------------------------------------------------

/**
 * Build the complete set of CodeMirror extensions for the snippet engine.
 *
 * @param userSnippets  — live user snippets from settingsStore.
 * @param activateOnTyping — whether to show the popup on every keystroke
 *                           (default: true).
 */
export function buildSnippetExtension(
  userSnippets: readonly UserSnippet[] = [],
  activateOnTyping = true,
): Extension[] {
  return [
    // Autocompletion popup (built-in + user snippets).
    autocompletion({
      override: [markdownSnippetSource(userSnippets)],
      activateOnTyping,
      maxRenderedOptions: 20,
    }),
    // Tab / Shift-Tab to jump between snippet tabstop fields.
    keymap.of([
      { key: "Tab", run: nextSnippetField },
      { key: "Shift-Tab", run: prevSnippetField },
    ]),
    // Enter / Escape / arrow to navigate and accept completions.
    keymap.of(completionKeymap),
    // Table row auto-insert on `|` at end of row.
    tableRowKeymap(),
  ];
}

// ---------------------------------------------------------------------------
// Exported helpers for testing
// ---------------------------------------------------------------------------

export { nextSnippetField, prevSnippetField, StateEffect };
