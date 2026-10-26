import { TreeFragment } from "@lezer/common";
import { GFM, parser } from "@lezer/markdown";
import GithubSlugger from "github-slugger";
import type { Element, Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { toString as hastText } from "hast-util-to-string";
import type { ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { Components } from "react-markdown";
import { visit } from "unist-util-visit";
import { diffLines, splitLines } from "../editor/lineDiff";
import { parseMarkdown } from "./pipeline";

const blockParser = parser.configure(GFM);

interface Chunk {
  source: string;
  line: number;
}
interface Entry {
  source: string;
  tree: Root;
  headings: { node: Element; text: string; fixed: boolean }[];
  line: number;
  ids: string;
  output: ReactNode;
  key: number;
}

/** Syntax with effects beyond a Lezer top-level block needs whole-document remark.
 * Be deliberately conservative, including escaped markers and markers in code.
 * This also covers math/frontmatter, which Lezer's CommonMark grammar lacks.
 */
function needsWholeDocument(source: string): boolean {
  return (
    /[<$\r]|%%/.test(source) ||
    /^---[ \t]*(?:\n|$)/m.test(source) ||
    /\]\s*:/.test(source) ||
    /^\s*\^[A-Za-z0-9-]+\s*$/m.test(source)
  );
}

/** Keep disjoint edits separate so an undo followed by an edit elsewhere does
 * not invalidate the thousands of unchanged lines between them. Bound Myers'
 * search for wholesale rewrites, falling back to a correct coarse change.
 */
function changedRanges(before: string, after: string) {
  const changes: { fromA: number; toA: number; fromB: number; toB: number }[] = [];
  let a = 0;
  let b = 0;
  for (const op of diffLines(splitLines(before), splitLines(after), 64)) {
    const size = op.lines.reduce((total, line) => total + line.length, 0);
    if (op.kind === "equal") {
      a += size;
      b += size;
    } else {
      const previous = changes[changes.length - 1];
      const change =
        previous?.toA === a && previous.toB === b
          ? previous
          : { fromA: a, toA: a, fromB: b, toB: b };
      if (change !== previous) changes.push(change);
      if (op.kind === "delete") a += size;
      else b += size;
      change.toA = a;
      change.toB = b;
    }
  }
  return changes.map((change) => {
    while (
      change.fromA < change.toA &&
      change.fromB < change.toB &&
      before[change.fromA] === after[change.fromB]
    ) {
      change.fromA++;
      change.fromB++;
    }
    while (
      change.toA > change.fromA &&
      change.toB > change.fromB &&
      before[change.toA - 1] === after[change.toB - 1]
    ) {
      change.toA--;
      change.toB--;
    }
    return change;
  });
}

/** Per-view cache, bounded to the current document. Never cache across documents
 * globally: components carry document context and source-line metadata.
 */
export class IncrementalMarkdown {
  private source = "";
  private fragments: readonly TreeFragment[] = [];
  private blocks: Chunk[] = [];
  private entries: Entry[] = [];
  private revisions: Entry[] = [];
  private nextKey = 0;
  private output: ReactNode[] = [];
  readonly stats = {
    parsedChunks: 0,
    reusedChunks: 0,
    wholeDocument: false,
    blockStructureUnchanged: false,
    reviewSignalsUnchanged: false,
  };

  constructor(private readonly components: Components = {}) {}

  render(source: string): ReactNode[] {
    if (source === this.source && this.entries.length) return this.output;
    this.stats.blockStructureUnchanged = false;
    this.stats.reviewSignalsUnchanged = false;
    const wholeDocument = needsWholeDocument(source);
    const chunks = wholeDocument ? [{ source, line: 0 }] : this.chunks(source);
    this.stats.parsedChunks = 0;
    this.stats.reusedChunks = 0;
    this.stats.wholeDocument = wholeDocument;
    const previous = new Map<string, Entry[]>();
    for (const entry of [...this.entries, ...this.revisions]) {
      const matches = previous.get(entry.source) ?? [];
      matches.push(entry);
      previous.set(entry.source, matches);
    }
    const slugs = new GithubSlugger();
    const previousKeys = this.entries.map((entry) => entry.key);
    const usedKeys = new Set<number>();
    const entries = chunks.map((chunk, index) => {
      let entry = previous.get(chunk.source)?.shift();
      if (entry) {
        this.stats.reusedChunks++;
      } else {
        const tree = parseMarkdown(chunk.source);
        const headings: Entry["headings"] = [];
        visit(tree, "element", (node) => {
          if (/^h[1-6]$/.test(node.tagName)) {
            headings.push({ node, text: hastText(node), fixed: !!node.properties.id });
          }
        });
        entry = {
          source: chunk.source,
          tree,
          headings,
          line: -1,
          ids: "",
          output: null,
          key: this.stats.blockStructureUnchanged
            ? previousKeys[index]
            : this.nextKey++,
        };
        this.stats.parsedChunks++;
      }
      const headingIds = entry.headings.map(({ node, text, fixed }) =>
        fixed ? node.properties.id : slugs.slug(text),
      );
      const ids = JSON.stringify(headingIds);
      // A word edit retains its logical chunk. Keep the React key so the
      // paragraph is updated in place instead of remounting its lists/code.
      let key = this.stats.blockStructureUnchanged ? previousKeys[index] : entry.key;
      if (usedKeys.has(key)) key = this.nextKey++;
      usedKeys.add(key);
      const keyChanged = key !== entry.key;
      entry.key = key;
      if (entry.line !== chunk.line || entry.ids !== ids || keyChanged) {
        // passNode exposes these nodes to committed React components. Copy
        // before shifting metadata so an interrupted render cannot mutate the
        // tree still on screen (or an older cached React element).
        if (entry.output !== null && (entry.line !== chunk.line || entry.ids !== ids)) {
          entry.tree = structuredClone(entry.tree);
          let index = 0;
          const previousHeadings = entry.headings;
          const headings: Entry["headings"] = [];
          visit(entry.tree, "element", (node) => {
            if (/^h[1-6]$/.test(node.tagName)) {
              headings.push({ ...previousHeadings[index++], node });
            }
          });
          entry.headings = headings;
        }
        entry.headings.forEach(({ node, fixed }, index) => {
          if (!fixed) node.properties.id = headingIds[index];
        });
        // Only trusted plugin-generated metadata is shifted. Raw HTML cannot
        // supply these attributes through the sanitizer.
        const delta = chunk.line - Math.max(0, entry.line);
        visit(entry.tree, "element", (node) => {
          for (const key of ["dataSourceLine", "dataTaskLine"]) {
            const value = node.properties[key];
            if (typeof value === "number") node.properties[key] = value + delta;
          }
        });
        entry.line = chunk.line;
        entry.ids = ids;
        entry.output = jsx(
          Fragment,
          {
            children: toJsxRuntime(entry.tree, {
              Fragment,
              jsx,
              jsxs,
              components: this.components,
              ignoreInvalidStyle: true,
              passKeys: true,
              passNode: true,
            }),
          },
          String(entry.key),
        );
      }
      return entry;
    });
    this.source = source;
    if (wholeDocument) {
      this.fragments = [];
      this.blocks = [];
    }
    // A small revision cache avoids reparsing a block when an edit is undone.
    // Never retain whole documents or giant blocks outside the current view.
    this.revisions = [...previous.values()]
      .flat()
      .filter((entry) => entry.source.length <= 4096)
      .slice(0, 16);
    this.entries = entries;
    this.output = entries.flatMap((entry, index) =>
      index === 0 ? [entry.output] : ["\n", entry.output],
    );
    return this.output;
  }

  private chunks(source: string): Chunk[] {
    const changes = this.blocks.length ? changedRanges(this.source, source) : [];
    const fragments = TreeFragment.applyChanges(this.fragments, changes);
    // Plain word edits cannot change a block boundary. Keep those boundaries
    // and map their offsets instead of asking Lezer to scan the whole document.
    // Punctuation, line breaks, indentation and structural markers always go
    // through the incremental grammar. Check both complete line starts, too.
    const inline =
      this.blocks.length > 0 &&
      changes.every((change) => {
        const oldLine = this.source.lastIndexOf("\n", change.fromA - 1) + 1;
        const newLine = source.lastIndexOf("\n", change.fromB - 1) + 1;
        return (
          /^[A-Za-z]/.test(this.source.slice(oldLine)) &&
          /^[A-Za-z]/.test(source.slice(newLine)) &&
          /^[A-Za-z0-9 ]*$/.test(this.source.slice(change.fromA, change.toA)) &&
          /^[A-Za-z0-9 ]*$/.test(source.slice(change.fromB, change.toB))
        );
      }) &&
      this.blocks.every((block) => block.source.length < 8192);
    if (inline) {
      this.stats.blockStructureUnchanged = true;
      // With no existing review, file-reference changes cannot create one.
      // A bare leading word + delimiter/EOL could become a severity marker;
      // keep those edits on the full review-analysis path.
      const candidate = /^[A-Za-z]+[ \t]*(?:[:)|\u2014\u2013-]|$)/;
      this.stats.reviewSignalsUnchanged = changes.every((change) => {
        const oldStart = this.source.lastIndexOf("\n", change.fromA - 1) + 1;
        const newStart = source.lastIndexOf("\n", change.fromB - 1) + 1;
        const oldEnd = this.source.indexOf("\n", change.toA);
        const newEnd = source.indexOf("\n", change.toB);
        return (
          !candidate.test(
            this.source.slice(oldStart, oldEnd < 0 ? undefined : oldEnd),
          ) && !candidate.test(source.slice(newStart, newEnd < 0 ? undefined : newEnd))
        );
      });
      let oldEnd = 0;
      let newStart = 0;
      let delta = 0;
      let index = 0;
      const blocks = this.blocks.map((block) => {
        oldEnd += block.source.length;
        while (
          index < changes.length &&
          changes[index].toA <= oldEnd &&
          (changes[index].fromA < oldEnd || oldEnd === this.source.length)
        ) {
          const change = changes[index++];
          delta += change.toB - change.fromB - (change.toA - change.fromA);
        }
        const end = oldEnd + delta;
        const chunk = { source: source.slice(newStart, end), line: block.line };
        newStart = end;
        return chunk;
      });
      this.fragments = fragments;
      this.blocks = blocks;
      return blocks;
    }
    const syntax = blockParser.parse(source, fragments);
    this.fragments = TreeFragment.addTree(syntax);
    // Group only at real top-level block boundaries, never blank lines inside
    // lists, quotes, fences or tables. Batching amortizes unified setup costs.
    const chunks: Chunk[] = [];
    let start = 0;
    let line = 0;
    let scanned = 0;
    let startLine = 0;
    const cursor = syntax.cursor();
    if (cursor.firstChild()) {
      do {
        if (cursor.from - start < 1024) continue;
        while (scanned < cursor.from) {
          if (source.charCodeAt(scanned++) === 10) line++;
        }
        chunks.push({ source: source.slice(start, cursor.from), line: startLine });
        start = cursor.from;
        startLine = line;
      } while (cursor.nextSibling());
    }
    chunks.push({ source: source.slice(start), line: startLine });
    this.blocks = chunks;
    return chunks;
  }
}
