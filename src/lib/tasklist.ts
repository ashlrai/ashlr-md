/**
 * tasklist.ts
 *
 * Pure helpers for interactive GFM task-list write-back.
 * These functions are fully unit-testable (no DOM, no React, no Tauri).
 *
 * GFM task-list source format:
 *   - [ ] unchecked item
 *   - [x] checked item      (GFM accepts both lowercase and uppercase X)
 *
 * Line numbers are 1-based, as unist positions are.
 */

import { markdownLines } from "./outline";

/** A task checkbox on a line, from {@link taskMarks}. */
export interface TaskMark {
  /** Whether the checkbox is checked (`[x]` or `[X]`). */
  checked: boolean;
  /** The text after the checkbox on its line, trimmed. */
  text: string;
  /** Offset of the checkbox's `[` in the document. */
  offset: number;
}

/**
 * For each line of `content` (split on `\n`), the task checkbox it holds,
 * or null: `[ ]`, `[x]` or `[X]` at the start of a list item's first
 * content, as the renderer (remark-gfm) reads one, by the container rule of
 * {@link markdownLines}. So `> - [ ] t`, `1) [ ] t` and a checkbox on a bare
 * item's next line (`-`, then `  [ ] t`) are tasks, while `    - [ ] t`
 * (indented code) and a `- [ ]` line in fenced code or front matter are
 * not. A tab inside the brackets counts only where it is one column wide,
 * as micromark reads it. The checkbox is followed by a space or a tab and
 * more text, or ends a line the paragraph goes on after (`- [ ]`, then
 * `  more`); `- [ ]` alone is text, and so is a checkbox whose paragraph is
 * a setext heading. The rule of mdopener-mcp's `task_list::task_marks`.
 */
export function taskMarks(content: string): (TaskMark | null)[] {
  const lines = markdownLines(content);
  return lines.map((l, i) => {
    if (l.kind !== "text" || !l.first) return null;
    const text = l.content;
    const box = text.slice(0, 3);
    if (box !== "[ ]" && box !== "[x]" && box !== "[X]") return null;
    const rest = text.slice(3);
    const more = rest.trim();
    // The line after the paragraph the checkbox starts.
    let end = i + 1;
    while (end < lines.length && lines[end].continues) end++;
    // A setext heading, not a paragraph, holds it.
    if (lines[end]?.setext) return null;
    // Nothing after it on the line: a task only when the paragraph goes on.
    const task =
      more === "" ? end > i + 1 : rest.startsWith(" ") || rest.startsWith("\t");
    if (!task) return null;
    const offset = l.start + rawIndexOfColumn(l.text, columnOf(l, text));
    return { checked: box !== "[ ]", text: more, offset };
  });
}

/** The column (tabs expanded) where `content`, the end of line `l`, starts. */
function columnOf(l: { text: string }, content: string): number {
  const raw = l.text.endsWith("\r") ? l.text.slice(0, -1) : l.text;
  let width = 0;
  for (const ch of raw) width += ch === "\t" ? 4 - (width % 4) : 1;
  return width - content.length;
}

/** The index in `line` of the character at `column` (tabs expanded). */
function rawIndexOfColumn(line: string, column: number): number {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    if (col >= column) return i;
    col += line[i] === "\t" ? 4 - (col % 4) : 1;
  }
  return line.length;
}

/**
 * Toggle the checkbox on `line` (1-based) in `content`, where
 * {@link taskMarks} reads one.
 *
 * Returns the updated full content string, or the original string if the line
 * doesn't hold a task checkbox (safe no-op). Only the character inside the
 * brackets changes: `[ ]` (or `[` and a tab) becomes `[x]`, `[x]` and `[X]`
 * become `[ ]`.
 *
 * @param content  Full markdown document string.
 * @param line     1-based line number of the checkbox.
 */
export function toggleTaskAtLine(content: string, line: number): string {
  if (!Number.isInteger(line) || line < 1) return content;
  const mark = taskMarks(content)[line - 1];
  if (!mark || content[mark.offset] !== "[") return content;
  const inside = mark.offset + 1;
  return `${content.slice(0, inside)}${mark.checked ? " " : "x"}${content.slice(inside + 1)}`;
}

/**
 * Return whether a line (1-based) holds a GFM task checkbox
 * ({@link taskMarks}). Useful for quick validation before calling
 * toggleTaskAtLine.
 */
export function isTaskLine(content: string, line: number): boolean {
  if (!Number.isInteger(line) || line < 1) return false;
  return taskMarks(content)[line - 1] != null;
}
