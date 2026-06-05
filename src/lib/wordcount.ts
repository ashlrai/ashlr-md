/**
 * wordcount.ts — reading statistics for the status bar.
 *
 * Counts prose words only: YAML frontmatter and fenced/inline code are excluded
 * so the "N words / M min read" figures reflect actual reading effort rather
 * than configuration or code listings.
 */

import { splitFrontmatter } from "./frontmatter";

export interface DocStats {
  words: number;
  /** Estimated reading time in minutes (>= 1 for any non-empty document). */
  minutes: number;
}

/** Average adult silent reading speed (words per minute). */
const WORDS_PER_MINUTE = 220;

/** Strip fenced code blocks (``` or ~~~), tracking the opening fence marker. */
function stripFencedCode(body: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  let inFence = false;
  let marker = "";
  for (const line of lines) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      const ch = m[1][0];
      if (!inFence) {
        inFence = true;
        marker = ch;
        continue;
      }
      if (ch === marker) {
        inFence = false;
        continue;
      }
    }
    if (!inFence) kept.push(line);
  }
  return kept.join("\n");
}

export function computeDocStats(content: string): DocStats {
  const { body } = splitFrontmatter(content);
  const prose = stripFencedCode(body).replace(/`[^`]*`/g, " ");
  const trimmed = prose.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const minutes = words === 0 ? 0 : Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  return { words, minutes };
}
