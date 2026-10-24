/**
 * wordcount.ts — reading statistics for the status bar.
 *
 * Counts prose words only: YAML frontmatter and fenced/inline code are excluded
 * so the "N words / M min read" figures reflect actual reading effort rather
 * than configuration or code listings.
 */

import { atxHeading, markdownLines } from "./outline";

export interface DocStats {
  words: number;
  /** Estimated reading time in minutes (>= 1 for any non-empty document). */
  minutes: number;
}

/** Average adult silent reading speed (words per minute). */
const WORDS_PER_MINUTE = 220;

/**
 * The prose lines of `content`: its text and HTML lines past their
 * blockquote markers, list markers and item indentation, without a heading's
 * `#`s, by the line rule of the Outline and the task checkboxes
 * ({@link markdownLines}). Front matter, fences and fenced code (also in a
 * blockquote or a list item, and closed only by the same character at least
 * as long), setext underlines and thematic breaks are left out. Fences used
 * to be any line starting with three backticks or tildes, closed by any
 * later one of the same character, so a longer fence holding a shorter one
 * ended early and a quoted fence was counted; list and quote markers
 * counted as words.
 */
function proseLines(content: string): string[] {
  return markdownLines(content)
    .filter((l) => (l.kind === "text" || l.kind === "html") && !l.setext)
    .map((l) => l.content)
    .filter((c) => !/^ {0,3}([-*_])( *\1){2,} *$/.test(c))
    .map((c) => atxHeading(c)?.text ?? c);
}

export function computeDocStats(content: string): DocStats {
  const prose = proseLines(content)
    .join("\n")
    .replace(/`[^`]*`/g, " ");
  const trimmed = prose.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const minutes = words === 0 ? 0 : Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  return { words, minutes };
}
