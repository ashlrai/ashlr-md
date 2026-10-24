/**
 * milkdownFidelity.ts — save only what was edited in the WYSIWYG editor.
 *
 * Milkdown writes a document by serializing its whole ProseMirror tree, so
 * one typed character rewrote every block of the file the way its
 * serializer spells things: setext headings became ATX, `-` and `+` list
 * markers became `*` and tight lists loose, reference links became inline
 * (their definitions dropped), indented code and `~~~` fences became
 * backtick fences (losing an info string's `title="…"`), tables were
 * re-padded, entities were decoded,
 * trailing-space hard breaks became backslashes, a blank line after the
 * front matter went away and a final newline was added.
 *
 * Here the document is mapped block by block: each top-level node of the
 * editor's tree is matched to the source range of the Markdown block it was
 * parsed from (the same remark parser Milkdown uses, with positions). On a
 * change, the leading and trailing top-level nodes that are unchanged keep
 * their original text, byte for byte, with the original text between them;
 * only the changed run of blocks is written by the serializer. A link
 * reference definition in the replaced range is kept. When the blocks do
 * not line up one to one, they are lined up by kind ({@link sourceRanges}):
 * a node with no block of its own cannot bound the kept text, so a run that
 * reaches one is widened to the nearest nodes that have one, and only that
 * region is written by the serializer. The serializer's whole output is
 * used only when nothing can be mapped.
 *
 * A block that is edited (one top-level block for one, as typing does) is
 * written in the style its source used where the serializer has a choice
 * ({@link blockStyle}): a `-` or `+` bullet list keeps its marker, an
 * ordered list its `)` and its numbering (`1.` `1.` `1.` stays so), a
 * setext heading stays setext (with its underline) and `## x ##` keeps its
 * closing `##`, a block that ends lines with two spaces for a hard break
 * keeps doing so, and `&nbsp;`, `&copy;` and other character references stay
 * as they were written ({@link keepSpellings}). An edited code block keeps
 * its fence (`~~~` or backticks, at its length) and its whole info string
 * ({@link codeBlockText}), and an indented one stays indented.
 */

import type { Crepe } from "@milkdown/crepe";
import {
  editorViewCtx,
  InitReady,
  remarkCtx,
  remarkPluginsCtx,
  schemaCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import type { Ctx, MilkdownPlugin } from "@milkdown/kit/ctx";
import {
  bulletListSchema,
  listItemSchema,
  remarkPreserveEmptyLinePlugin,
} from "@milkdown/kit/preset/commonmark";
import {
  extendListItemSchemaForTask,
  tableCellSchema,
  tableHeaderSchema,
} from "@milkdown/kit/preset/gfm";
import { Fragment, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { type MarkdownNode, SerializerState } from "@milkdown/kit/transformer";
import { decodeNamedCharacterReference } from "decode-named-character-reference";

/** A source range `[start, end)` in the original body. */
export interface BlockRange {
  start: number;
  end: number;
}

/** The parts of a remark (mdast) node this module reads. */
export interface MdNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
  /** A list's. */
  ordered?: boolean | null;
  /** A heading's level. */
  depth?: number;
  /** A code block's language (the info string's first word). */
  lang?: string | null;
}

/** The parts of a ProseMirror node this module reads. */
export interface PmNode {
  childCount: number;
  child(index: number): PmNode;
  eq(other: PmNode): boolean;
  type: { name: string };
  content: { size: number };
}

function range(n: MdNode): BlockRange | null {
  const start = n.position?.start.offset;
  const end = n.position?.end.offset;
  return typeof start === "number" && typeof end === "number" ? { start, end } : null;
}

/**
 * The ProseMirror node types a top-level remark node of each type becomes:
 * Crepe makes a paragraph holding only an image an `image-block`, wraps
 * block HTML in a paragraph, and shows display math as a code block.
 */
const BECOMES: Record<string, readonly string[]> = {
  paragraph: ["paragraph", "image-block"],
  heading: ["heading"],
  list: ["bullet_list", "ordered_list"],
  code: ["code_block"],
  math: ["code_block", "math_block", "math_display"],
  blockquote: ["blockquote"],
  thematicBreak: ["hr"],
  html: ["paragraph", "html"],
  table: ["table"],
  footnoteDefinition: ["footnote_definition"],
};

/** Whether a remark node of type `md` can be the ProseMirror node of type `pm`. */
function canBecome(md: string, pm: string): boolean {
  return (BECOMES[md] ?? [md]).includes(pm);
}

/** Past this many remark x ProseMirror blocks, blocks that do not line up are not matched. */
const MAX_ALIGN_CELLS = 4_000_000;

/**
 * Match `md` (remark block types) to `pm` (ProseMirror node types), in
 * order, as many as can be (a longest common subsequence under
 * {@link canBecome}): `out[j]` is the remark block of node `j`, or -1.
 * Null when the documents are too large to match.
 */
export function alignBlocks(
  md: readonly string[],
  pm: readonly string[],
): number[] | null {
  const n = md.length;
  const m = pm.length;
  if ((n + 1) * (m + 1) > MAX_ALIGN_CELLS) return null;
  const w = m + 1;
  const best = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      best[i * w + j] = canBecome(md[i], pm[j])
        ? best[(i + 1) * w + j + 1] + 1
        : Math.max(best[(i + 1) * w + j], best[i * w + j + 1]);
    }
  }
  const out = new Array<number>(m).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (canBecome(md[i], pm[j]) && best[i * w + j] === best[(i + 1) * w + j + 1] + 1) {
      out[j] = i;
      i++;
      j++;
    } else if (best[(i + 1) * w + j] >= best[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

/**
 * The source map of `tree` (the original body parsed by the editor's remark)
 * for a ProseMirror doc of `pmCount` top-level nodes: the range of each node,
 * and the link reference definitions (which Milkdown folds into the links
 * and drops as blocks). A last empty paragraph the editor adds after a final
 * non-paragraph block is mapped to the end of the last block. When the
 * blocks do not line up one to one and `pmTypes` (the nodes' type names)
 * is given, they are matched by kind ({@link alignBlocks}): a node with no
 * block gets no range, and a block with no node is an orphan (its text is
 * dropped only with a region around it that is rewritten). Null when
 * nothing can be mapped.
 */
export function sourceRanges(
  tree: MdNode,
  pmCount: number,
  pmTypes?: readonly string[],
  original?: string,
): SourceMap | null {
  const blocks: BlockRange[] = [];
  const nodes: MdNode[] = [];
  const definitions: BlockRange[] = [];
  const text = typeof original === "string" ? original : "";
  for (const child of tree.children ?? []) {
    const r = range(child);
    if (!r) return null;
    // A block's range takes in the indentation of its first line: a
    // position starts after it, so a block written anew (or kept after
    // one that was) lost it.
    const lineStart = text.lastIndexOf("\n", r.start - 1) + 1;
    if (text && /^[ \t]+$/.test(text.slice(lineStart, r.start))) r.start = lineStart;
    if (child.type === "definition") definitions.push(r);
    else {
      blocks.push(r);
      nodes.push(child);
    }
  }
  if (blocks.length === 0) return null;
  const start = blocks[0].start;
  const end = blocks[blocks.length - 1].end;
  const types = pmTypes && pmTypes.length === pmCount ? pmTypes : null;
  // One to one, in order (each block the kind of node it is, when known).
  const lined = (count: number) =>
    !types || nodes.every((x, i) => i >= count || canBecome(x.type, types[i]));
  if (blocks.length === pmCount && lined(pmCount)) {
    return { blocks, definitions, nodes, start, end };
  }
  if (
    blocks.length + 1 === pmCount &&
    lined(blocks.length) &&
    (!types || types[pmCount - 1] === "paragraph")
  ) {
    return { blocks: [...blocks, { start: end, end }], definitions, nodes, start, end };
  }
  if (!types) return null;
  const pmTypesChecked = types;
  const matched = alignBlocks(
    nodes.map((x) => x.type),
    pmTypesChecked,
  );
  if (!matched || matched.every((i) => i === -1)) return null;
  const used = new Set(matched);
  return {
    blocks: matched.map((i) => (i === -1 ? null : blocks[i])),
    nodes: matched.map((i) => (i === -1 ? null : nodes[i])),
    definitions,
    orphans: blocks.filter((_, i) => !used.has(i)),
    start,
    end,
  };
}

/** {@link sourceRanges}: where each top-level node's Markdown is. */
export interface SourceMap {
  /** Each top-level node's source range (null: it has no block of its own). */
  blocks: (BlockRange | null)[];
  /** The link reference definitions'. */
  definitions: BlockRange[];
  /** The remark node each range is (none for one the editor added). */
  nodes?: (MdNode | null)[];
  /** Blocks no node stands for. */
  orphans?: BlockRange[];
  /** Where the first block starts and the last one ends (any, mapped or not). */
  start?: number;
  end?: number;
}

/**
 * How a block's source spells what the serializer has a choice about, as
 * remark-stringify settings: a bullet list's marker (`-`, `+` or `*`), an
 * ordered list's delimiter (`.` or `)`) and whether its numbers count up
 * (`1.` `2.` `3.`) or repeat (`1.` `1.` `1.`), and whether a level 1 or 2
 * heading is underlined (setext) or `#` (ATX). An edited block written with
 * these keeps its look; Milkdown wrote every bullet `*`, every ordered list
 * `1.` `2.` `3.`, every heading `#`.
 */
export function blockStyle(original: string, node: MdNode): Record<string, unknown> {
  const style: Record<string, unknown> = {};
  const r = range(node);
  if (!r) return style;
  if (node.type === "heading") {
    // A setext heading's source starts with its text, not `#`.
    const text = original.slice(r.start, r.end);
    if ((node.depth ?? 0) <= 2 && !/^ {0,3}#/.test(text)) style.setext = true;
    // `## Title ##`: the closing sequence is kept.
    else if (/^ {0,3}#{1,6}[ \t].*[ \t]#+[ \t]*$/.test(text)) style.closeAtx = true;
  }
  if (node.type === "list") {
    const items = (node.children ?? [])
      .map((item) => range(item))
      .filter((x): x is BlockRange => x !== null)
      .map((x) => original.slice(x.start, x.end));
    if (node.ordered) {
      const marks = items
        .map((text) => /^(\d{1,9})([.)])/.exec(text))
        .filter((x): x is RegExpExecArray => x !== null);
      if (marks.length > 0) {
        style.bulletOrdered = marks[0][2];
        if (marks.length > 1 && marks.every((x) => x[1] === marks[0][1])) {
          style.incrementListMarker = false;
        }
      }
    } else {
      const bullet = items[0]?.charAt(0);
      if (bullet === "-" || bullet === "+" || bullet === "*") {
        style.bullet = bullet;
        // A list right after another one is written with the other marker,
        // so the two stay apart; any other than this one will do.
        style.bulletOther = bullet === "-" ? "*" : "-";
      }
    }
  }
  return style;
}

export interface SpliceInput {
  /** The body as it was loaded. */
  original: string;
  /** {@link sourceRanges} of `original` for `initial`. */
  map: SourceMap;
  /** The editor's tree as loaded. */
  initial: PmNode;
  /** The editor's tree now. */
  current: PmNode;
  /** Serialize top-level nodes `[from, to)` of `current` (no trailing newline needed). */
  serializeRange: (from: number, to: number) => string;
  /**
   * Serialize top-level node `index` of `current`, which stands where node
   * `index` of `initial` stood, in that block's style. Used when the
   * changed run holds as many blocks as it replaced (an edit inside them);
   * without it the run is written by `serializeRange`.
   */
  serializeBlock?: (index: number) => string;
}

/**
 * The body to save: `original` with only the changed run of top-level
 * blocks rewritten. Unchanged leading and trailing blocks, the text between
 * them and the text before the first and after the last block (the blank
 * line after front matter, a missing final newline) stay as they were.
 */
export function spliceEdited(input: SpliceInput): string {
  const { original, map, initial, current } = input;
  const { blocks } = map;
  const n = initial.childCount;
  // The empty paragraph the editor adds after a last block that is not a
  // paragraph (a list, a table, a rule) on the first edit is not text of
  // the file: it made every edit look like a change at the end, so the
  // last block was rewritten whatever was edited.
  const c =
    current.childCount > n && addedTrailingParagraph(initial, current)
      ? current.childCount - 1
      : current.childCount;
  // Leading and trailing top-level nodes that did not change.
  let k = 0;
  while (k < n && k < c && initial.child(k).eq(current.child(k))) k++;
  if (k === n && k === c) return original;
  let m = 0;
  while (
    m < n - k &&
    m < c - k &&
    initial.child(n - 1 - m).eq(current.child(c - 1 - m))
  ) {
    m++;
  }
  // A kept node with no block of its own cannot say where the kept text
  // ends: the run takes it in, out to the nearest node that has one, and
  // only that region is written anew (it used to be the whole file).
  while (k > 0 && !blocks[k - 1]) k--;
  while (m > 0 && !blocks[n - m]) m--;
  // The original text kept before and after the changed run: everything
  // up to the end of the last kept leading block (or up to the first block,
  // front matter's blank line included), and from the first kept trailing
  // block (or from the end of the last block: a missing final newline, a
  // definition at the end).
  const headEnd =
    k === 0 ? (blocks[0]?.start ?? map.start ?? 0) : (blocks[k - 1] as BlockRange).end;
  const tailStart =
    m === 0
      ? (blocks[n - 1]?.end ?? map.end ?? original.length)
      : (blocks[n - m] as BlockRange).start;
  const head = original.slice(0, headEnd);
  const tail = original.slice(tailStart);
  // Original blocks replaced: [k, n - m). Their outer gaps are kept as they
  // were (with any definitions in them) where they still separate; every
  // other definition in the replaced region is kept after the rewritten run.
  const replacedFrom = k;
  const replacedTo = n - m;
  const firstReplaced = replacedTo > replacedFrom ? blocks[replacedFrom] : null;
  const lastReplaced = replacedTo > replacedFrom ? blocks[replacedTo - 1] : null;
  let before = "";
  let coveredStart = headEnd;
  if (k > 0) {
    // With blocks only inserted, the one original gap goes before the run.
    const next = replacedTo > replacedFrom ? firstReplaced : k < n ? blocks[k] : null;
    const gap = next ? keptGap(map, original, headEnd, next.start) : null;
    before = gap ?? "\n\n";
    if (gap !== null && next) coveredStart = next.start;
  }
  let after = "";
  let coveredEnd = tailStart;
  if (m > 0) {
    const gap = lastReplaced
      ? keptGap(map, original, lastReplaced.end, tailStart)
      : null;
    after = gap ?? "\n\n";
    if (gap !== null && lastReplaced) coveredEnd = lastReplaced.end;
  }
  if (coveredStart > coveredEnd) coveredEnd = coveredStart;
  const paired = pairedRun(input, k, replacedTo, c - m);
  // A paired run keeps the definitions between its blocks itself.
  const inner =
    paired !== null && firstReplaced && lastReplaced
      ? { start: firstReplaced.start, end: lastReplaced.end }
      : null;
  const kept = map.definitions
    .filter(
      (d) =>
        d.start >= coveredStart &&
        d.end <= coveredEnd &&
        !(inner && d.start >= inner.start && d.end <= inner.end),
    )
    .map((d) => original.slice(d.start, d.end));
  const middle = paired ?? input.serializeRange(k, c - m).replace(/\n+$/, "");
  const parts = [middle, ...kept].filter((p) => p !== "");
  if (parts.length === 0) {
    // Blocks deleted, nothing written in their place.
    if (k === 0 || m === 0) return head + tail;
    return head + before + tail;
  }
  return head + before + parts.join("\n\n") + after + tail;
}

/** Whether `current` ends with an empty paragraph `initial` did not end with. */
function addedTrailingParagraph(initial: PmNode, current: PmNode): boolean {
  const last = current.child(current.childCount - 1);
  if (last.type.name !== "paragraph" || last.content.size !== 0) return false;
  const n = initial.childCount;
  return n === 0 || !initial.child(n - 1).eq(last);
}

/**
 * The changed run `[k, to)` of `initial`, edited in place into `[k, cto)` of
 * `current` with as many blocks: each block written in its own style
 * (`serializeBlock`), with the original text between them. Null when the
 * run's length changed, a block has no source range, or writes as nothing.
 */
function pairedRun(
  input: SpliceInput,
  k: number,
  to: number,
  cto: number,
): string | null {
  const { serializeBlock, original, map } = input;
  if (!serializeBlock || to - k !== cto - k || to <= k) return null;
  let out = "";
  for (let i = k; i < to; i++) {
    const here = map.blocks[i];
    if (!here) return null;
    const text = serializeBlock(i).replace(/\n+$/, "");
    if (text === "") return null;
    if (i > k) {
      const prev = map.blocks[i - 1] as BlockRange;
      const gap = keptGap(map, original, prev.end, here.start);
      if (gap !== null) out += gap;
      else {
        // Not kept as it was: a blank line, with the definitions in it.
        const defs = map.definitions
          .filter((d) => d.start >= prev.end && d.end <= here.start)
          .map((d) => original.slice(d.start, d.end));
        out += defs.length ? `\n\n${defs.join("\n\n")}\n\n` : "\n\n";
      }
    }
    out += text;
  }
  return out;
}

/**
 * The original text `[from, to)` between two blocks, when it can be kept
 * as it is ({@link separating}) and holds no orphan block (one no node
 * stands for: it may be part of a node being rewritten). Else null.
 */
function keptGap(
  map: SourceMap,
  original: string,
  from: number,
  to: number,
): string | null {
  if (to < from) return null;
  if ((map.orphans ?? []).some((o) => o.start < to && o.end > from)) return null;
  const gap = original.slice(from, to);
  return separates(gap) ? gap : null;
}

/**
 * Whether `gap` (original text between two blocks) still separates the
 * blocks either side, whatever they now are: it holds a blank line and ends
 * with a line break.
 */
function separates(gap: string): boolean {
  return /\n[ \t]*\r?\n/.test(gap) && /\n$/.test(gap);
}

// ── Editor wiring ─────────────────────────────────────────────────────────────

/**
 * Read the editor's tree as loaded (call once it is mounted) and return
 * what to save for each later serialization: {@link spliceEdited}'s body,
 * or `written` (the serializer's whole output) when the source cannot be
 * mapped or anything fails.
 */
export function sourceKeeper(ctx: Ctx, original: string): (written: string) => string {
  let initial: ProseNode;
  let map: ReturnType<typeof sourceRanges>;
  try {
    initial = ctx.get(editorViewCtx).state.doc;
    const tree = ctx.get(remarkCtx).parse(original) as unknown as MdNode;
    const types: string[] = [];
    initial.forEach((node) => {
      types.push(node.type.name);
    });
    map = sourceRanges(tree, initial.childCount, types, original);
  } catch {
    return (written) => written;
  }
  if (!map) return (written) => written;
  const blocks = map;
  const styled = styledSerializer(ctx, original);
  return (written) => {
    try {
      const current = ctx.get(editorViewCtx).state.doc;
      const serializer = ctx.get(serializerCtx);
      return spliceEdited({
        original,
        map: blocks,
        initial: initial as unknown as PmNode,
        current: current as unknown as PmNode,
        serializeRange: (from, to) => {
          const nodes: ProseNode[] = [];
          for (let i = from; i < to; i++) nodes.push(current.child(i));
          return nodes.length ? serializer(current.copy(Fragment.from(nodes))) : "";
        },
        serializeBlock: (index) => {
          const block = current.child(index);
          const node = current.copy(Fragment.from(block));
          const source = blocks.nodes?.[index];
          if (source?.type === "code" && block.type.name === "code_block") {
            const kept = codeBlockText(
              original,
              source,
              String(block.attrs.language ?? ""),
              block.textContent,
            );
            if (kept !== null) return kept;
          }
          return source ? styled(node, source) : serializer(node);
        },
      });
    } catch {
      return written;
    }
  };
}

/**
 * A code block's text as its source wrote it, with `code` (the editor's
 * text for it now) in it: the fence (backticks or `~~~`, at its length and
 * indentation) and the whole info string are kept. The editor's code block
 * holds only the language, so the serializer wrote every edited block with
 * backticks and dropped the rest of the info string (`title="a.ts"`). A
 * changed language replaces the first word of the info string only. An
 * indented block stays indented ({@link indentedCode}); the serializer
 * fenced it. Null when the source is no closed fence, or `code` holds a
 * line that would close it.
 */
export function codeBlockText(
  original: string,
  node: MdNode,
  language: string,
  code: string,
): string | null {
  const r = range(node);
  if (!r || node.type !== "code") return null;
  // The node's position starts after its indentation (the block's range,
  // see sourceRanges, takes it in): the fence is written with it.
  const lineStart = original.lastIndexOf("\n", r.start - 1) + 1;
  const lead = original.slice(lineStart, r.start);
  if (!/^ *$/.test(lead)) return null;
  const lines = original.slice(lineStart, r.end).split("\n");
  const open = /^( {0,3})(`{3,}|~{3,})([^\r]*)(\r?)$/.exec(lines[0]);
  if (!open) return indentedCode(lines[0], language, code);
  if (lines.length < 2) return null;
  const [, indent, fence, info] = open;
  const close = lines[lines.length - 1];
  if (!isClosingFence(close, fence)) return null;
  const codeLines = code === "" ? [] : code.split("\n");
  if (codeLines.some((line) => isClosingFence(line, fence))) return null;
  let opening = lines[0];
  const lang = node.lang ?? "";
  if (language !== lang) {
    // A new language: the first word of the info string changes.
    if (fence[0] === "`" && language.includes("`")) return null;
    if (/\s/.test(language)) return null;
    const rest = info.trim().slice(lang.length).trim();
    const words = [language, rest].filter((w) => w !== "").join(" ");
    opening = `${indent}${fence}${words}${open[4]}`;
  }
  const body = codeLines.map((line) => (line === "" ? line : indent + line));
  return [opening, ...body, close].join("\n");
}

/**
 * {@link codeBlockText} for an indented code block, whose first line is
 * `first`: `code` indented as that line is (four spaces or a tab). Null
 * when it cannot be written so: a language was given it, or it is empty or
 * starts or ends with a blank line (which indentation cannot hold).
 */
function indentedCode(first: string, language: string, code: string): string | null {
  const indent = /^( {4}|\t)/.exec(first)?.[1];
  if (!indent || language !== "" || code.trim() === "") return null;
  const lines = code.split("\n");
  if (lines[0].trim() === "" || (lines.at(-1) ?? "").trim() === "") return null;
  return lines.map((line) => (line === "" ? line : indent + line)).join("\n");
}

/** Whether `line` closes a fence opened with `fence` (same character, as long or longer). */
function isClosingFence(line: string, fence: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
  return m !== null && m[1][0] === fence[0] && m[1].length >= fence.length;
}

/**
 * `written` (a block as the serializer wrote it in its {@link blockStyle})
 * with what the settings cannot say put back from the block's source: a
 * setext heading's underline, at its length (the serializer matches the
 * text's, so it changed with every edit).
 */
export function restyled(written: string, original: string, node: MdNode): string {
  const r = range(node);
  if (!r || node.type !== "heading") return written;
  const underline = /\n( {0,3}([=-])\2*[ \t]*)$/.exec(original.slice(r.start, r.end));
  const out = /\n([=-])\1*(\n*)$/.exec(written);
  if (!underline || !out || underline[2] !== out[1]) return written;
  return `${written.slice(0, out.index)}\n${underline[1]}${out[2]}`;
}

/** The parts of an mdast node {@link keepSpellings} reads and writes. */
interface SpelledNode {
  type: string;
  value?: string;
  url?: string;
  children?: SpelledNode[];
}

/**
 * Put back, in `tree` (one block as the serializer will write it), how the
 * block's `source` spelled what the tree no longer says: a hard break
 * written as trailing spaces (the serializer writes a backslash) stays
 * trailing spaces, when the block wrote none as a backslash; a character
 * the block wrote as a reference (`&nbsp;`, `&copy;`, `&#169;`, `&amp;`) is
 * written as it was again (the editor holds the character, which the
 * serializer wrote as it is, or escaped): each one as its source did while
 * the block holds as many, else the one way the source wrote it, if one.
 * A link the block wrote as a bare URL (`www.example.com`,
 * `https://example.com`, `a@example.com`, which GFM makes links) stays
 * bare: the serializer wrote `[www.example.com](http://www.example.com)`
 * and `<https://example.com>`.
 * Each is put in as raw text (an `html` node, which is written as it is).
 */
export function keepSpellings(tree: unknown, source: string): void {
  const spaces = /( {2,})\r?\n/.exec(source);
  const breakText = spaces && !/\\\r?\n/.test(source) ? `${spaces[1]}\n` : null;
  const refs = characterReferences(source);
  // How many of each referenced character the block holds now.
  const counts = new Map<string, number>();
  const seen = new Map<string, number>();
  if (refs) {
    for (const t of textNodes(tree as SpelledNode)) {
      for (const m of (t.value ?? "").matchAll(refs.pattern)) {
        counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
      }
    }
  }
  const walk = (node: SpelledNode, inLine: boolean) => {
    const kids = node.children;
    if (!kids) return;
    // A heading or a table cell holds one line: its breaks are written as
    // spaces, by the serializer's own rules.
    const line = inLine || node.type === "heading" || node.type === "tableCell";
    const out: SpelledNode[] = [];
    for (const kid of kids) {
      const bare = bareLink(kid, source);
      if (bare !== null) {
        out.push({ type: "html", value: bare });
      } else if (kid.type === "break" && !line && breakText !== null) {
        out.push({ type: "html", value: breakText });
      } else if (
        kid.type === "text" &&
        refs !== null &&
        typeof kid.value === "string"
      ) {
        out.push(...withReferences(kid.value, refs, seen, counts));
      } else {
        walk(kid, line);
        out.push(kid);
      }
    }
    node.children = out;
  };
  walk(tree as SpelledNode, false);
}

/**
 * The text of `node` when it is a link `source` wrote as a bare URL (a GFM
 * autolink literal): its one text child is its URL, or its URL less the
 * `http://` or `mailto:` GFM adds, and the source shows that text, but not
 * as `<url>` or `[text](url)`. Else null.
 */
function bareLink(node: SpelledNode, source: string): string | null {
  if (node.type !== "link" || node.children?.length !== 1) return null;
  const child = node.children[0];
  const text = child.type === "text" ? child.value : undefined;
  const url = node.url;
  if (!text || !url || /\s/.test(text)) return null;
  if (url !== text && url !== `http://${text}` && url !== `mailto:${text}`) return null;
  if (!source.includes(text)) return null;
  if (source.includes(`<${text}>`) || source.includes(`<${url}>`)) return null;
  if (source.includes(`](${url}`) || source.includes(`](<${url}`)) return null;
  return text;
}

/** A character reference's text: `&name;`, `&#169;` or `&#xA9;`. */
const REFERENCE =
  /&(?:#[xX]([0-9A-Fa-f]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

/** The character a {@link REFERENCE} match stands for, if any. */
function referenced(m: RegExpMatchArray): string | null {
  if (m[1] !== undefined || m[2] !== undefined) {
    const code = m[1] !== undefined ? Number.parseInt(m[1], 16) : Number(m[2]);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null;
  }
  return decodeNamedCharacterReference(m[3]) || null;
}

/** How a block wrote each character it wrote at least once as a reference. */
interface References {
  /** Matches any of those characters. */
  pattern: RegExp;
  /** Each one's spellings, in source order (the character itself when written as it is). */
  spellings: Map<string, string[]>;
}

/**
 * The characters `source` wrote as a reference at least once, each with
 * every spelling of it in order. Null when there are none.
 */
function characterReferences(source: string): References | null {
  const chars = new Set<string>();
  for (const m of source.matchAll(REFERENCE)) {
    const char = referenced(m);
    if (char) chars.add(char);
  }
  if (chars.size === 0) return null;
  const keys = [...chars].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "gu",
  );
  // Every reference and every bare occurrence, in order.
  const spellings = new Map<string, string[]>(keys.map((k) => [k, []]));
  const both = new RegExp(`${REFERENCE.source}|${pattern.source}`, "gu");
  for (const m of source.matchAll(both)) {
    const char = m[0].startsWith("&") ? (referenced(m) ?? m[0]) : m[0];
    spellings.get(char)?.push(m[0]);
  }
  return { pattern, spellings };
}

/**
 * How to write the `nth` (from 0, of `count` in the block now) `char`: as
 * the source wrote that one, when the block holds as many as it did; as
 * the one way the source wrote it, when it used one; else as itself.
 */
function spellingOf(
  refs: References,
  char: string,
  nth: number,
  count: number,
): string {
  const ways = refs.spellings.get(char) ?? [];
  if (ways.length === count) return ways[nth];
  return ways.length > 0 && ways.every((w) => w === ways[0]) ? ways[0] : char;
}

/** The text nodes of `tree`, in order. */
function textNodes(tree: SpelledNode, out: SpelledNode[] = []): SpelledNode[] {
  for (const kid of tree.children ?? []) {
    if (kid.type === "text") out.push(kid);
    else textNodes(kid, out);
  }
  return out;
}

/**
 * `value` as text nodes, with each character written as a reference as
 * that reference (an `html` node). `seen` counts each character so far in
 * the block, `counts` in all of it.
 */
function withReferences(
  value: string,
  refs: References,
  seen: Map<string, number>,
  counts: Map<string, number>,
): SpelledNode[] {
  const out: SpelledNode[] = [];
  let at = 0;
  let text = "";
  for (const m of value.matchAll(refs.pattern)) {
    const index = m.index ?? 0;
    const nth = seen.get(m[0]) ?? 0;
    seen.set(m[0], nth + 1);
    const way = spellingOf(refs, m[0], nth, counts.get(m[0]) ?? 0);
    text += value.slice(at, index);
    at = index + m[0].length;
    if (way === m[0]) {
      text += m[0];
      continue;
    }
    if (text) out.push({ type: "text", value: text });
    text = "";
    out.push({ type: "html", value: way });
  }
  text += value.slice(at);
  if (text) out.push({ type: "text", value: text });
  return out;
}

/** The editor's remark processor: callable for a copy, as unified's are. */
interface Processor {
  (): Processor;
  data(key: string): unknown;
  data(key: string, value: unknown): Processor;
  stringify(tree: unknown): string;
}

/**
 * Write a one-block doc the way the editor's serializer does, but in the
 * style of `source` (its block in `original`, see {@link blockStyle}).
 * The settings go in a copy of the editor's remark processor (its
 * `settings` data, which remark-stringify reads under the options it was
 * given), one per style.
 */
function styledSerializer(
  ctx: Ctx,
  original: string,
): (doc: ProseNode, source: MdNode) => string {
  const copies = new Map<string, Processor>();
  return (doc, source) => {
    const style = blockStyle(original, source);
    const key = JSON.stringify(style);
    let processor = copies.get(key);
    if (!processor) {
      const remark = ctx.get(remarkCtx) as unknown as Processor;
      const settings = (remark.data("settings") ?? {}) as Record<string, unknown>;
      processor = remark().data("settings", { ...settings, ...style });
      copies.set(key, processor);
    }
    const state = new SerializerState(ctx.get(schemaCtx));
    state.run(doc);
    const tree: MarkdownNode = state.build();
    const r = range(source);
    if (r) keepSpellings(tree, original.slice(r.start, r.end));
    return restyled(processor.stringify(tree), original, source);
  };
}

/**
 * A bullet list's `spread` attribute as the boolean remark reads. Milkdown
 * parses it as the string "true" or "false" and writes that string back,
 * which remark does not take as a boolean, so every bullet list was written
 * loose (a blank line between items): `- a` / `- b` became `* a`, a blank
 * line, `* b`. Ordered lists were already written right.
 */
export function listSpread(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Milkdown config: write a tight bullet list tight, and a list item's
 * paragraph and nested list without a blank line between them when the item
 * is tight (see {@link listSpread}). Pass to `editor.config` before the
 * editor is created.
 */
export function keepTightBulletLists(ctx: Ctx): void {
  ctx.update(bulletListSchema.key, (prev) => (c) => {
    const base = prev(c);
    return {
      ...base,
      toMarkdown: {
        match: base.toMarkdown.match,
        runner: (state, node) => {
          state
            .openNode("list", undefined, {
              ordered: false,
              spread: listSpread(node.attrs.spread),
            })
            .next(node.content)
            .closeNode();
        },
      },
    };
  });
  // The list item schema in use is GFM's (it adds task items), which hands
  // a plain item to CommonMark's writer; both are wrapped.
  for (const schema of [listItemSchema, extendListItemSchemaForTask]) {
    ctx.update(schema.key, (prev) => (c) => {
      const base = prev(c);
      return {
        ...base,
        toMarkdown: {
          match: base.toMarkdown.match,
          runner: (state, node) => {
            if (node.attrs.checked != null) {
              base.toMarkdown.runner(state, node);
              return;
            }
            state.openNode("listItem", undefined, {
              spread: listSpread(node.attrs.spread),
            });
            state.next(node.content);
            state.closeNode();
          },
        },
      };
    });
  }
}

/**
 * Whether a table cell holds only one empty paragraph. Milkdown writes an
 * empty paragraph as `<br />`, so a table with an empty cell gained a
 * `<br />` in it whenever the table was written.
 */
export function isEmptyCell(node: {
  childCount: number;
  firstChild: { type: { name: string }; content: { size: number } } | null;
}): boolean {
  const p = node.firstChild;
  return (
    node.childCount === 1 &&
    p != null &&
    p.type.name === "paragraph" &&
    p.content.size === 0
  );
}

/**
 * Milkdown config: write an empty table cell (header or body) empty, not
 * as `<br />` (see {@link isEmptyCell}). Pass to `editor.config`.
 */
export function keepEmptyTableCells(ctx: Ctx): void {
  for (const schema of [tableCellSchema, tableHeaderSchema]) {
    ctx.update(schema.key, (prev) => (c) => {
      const base = prev(c);
      return {
        ...base,
        toMarkdown: {
          match: base.toMarkdown.match,
          runner: (state, node) => {
            if (!isEmptyCell(node)) {
              base.toMarkdown.runner(state, node);
              return;
            }
            state.openNode("tableCell").closeNode();
          },
        },
      };
    });
  }
}

/** An HTML line break, as the editor writes an empty paragraph: `<br />` and its spellings. */
function isBreakTag(node: SpelledNode): boolean {
  return (
    node.type === "html" &&
    ["<br />", "<br>", "<br >", "<br/>"].includes((node.value ?? "").trim())
  );
}

/**
 * Remove from `tree` each `<br />` that is all a paragraph or table cell
 * holds: Milkdown writes an empty paragraph (or cell) that way, and reads
 * it back as empty. A `<br>` among other text is kept: Milkdown's own
 * plugin removed every one, so `a<br>b` showed and saved as `ab`.
 */
export function dropEmptyLineBreaks(tree: unknown): void {
  const walk = (node: SpelledNode) => {
    const kids = node.children;
    if (!kids) return;
    if (
      (node.type === "paragraph" || node.type === "tableCell") &&
      kids.length === 1 &&
      isBreakTag(kids[0])
    ) {
      node.children = [];
      return;
    }
    for (const kid of kids) walk(kid);
  };
  walk(tree as SpelledNode);
}

/**
 * Milkdown plugin: read an inline `<br>` as HTML, kept in the text, and
 * only an empty paragraph's `<br />` as empty ({@link dropEmptyLineBreaks}),
 * in place of the commonmark preset's remark plugin, which dropped every
 * `<br>`. Use it after the preset (Crepe's `editor.use`, before create).
 */
export const keepInlineLineBreaks: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(InitReady);
  const options = ctx.get(remarkPreserveEmptyLinePlugin.options.key);
  const narrowed = () => (tree: unknown) => dropEmptyLineBreaks(tree);
  ctx.update(remarkPluginsCtx, (plugins) =>
    plugins.map((p) => (p.options === options ? { ...p, plugin: narrowed } : p)),
  );
};

/**
 * Wire a Crepe editor (before it is created) to save only what was edited:
 * `onChange` gets the body to save on every change, built by
 * {@link sourceKeeper} from `original`, the body the editor was given.
 * Tight bullet lists stay tight ({@link keepTightBulletLists}), empty
 * table cells empty ({@link keepEmptyTableCells}) and an inline `<br>` in
 * the text ({@link keepInlineLineBreaks}).
 */
export function keepSourceOnSave(
  crepe: Crepe,
  original: string,
  onChange: (body: string) => void,
): SourceKeeping {
  crepe.editor
    .config(keepTightBulletLists)
    .config(keepEmptyTableCells)
    .use(keepInlineLineBreaks);
  let keep: ((written: string) => string) | null = null;
  let mounted: Ctx | null = null;
  // The tree the last report was of: a flush with nothing new reports
  // nothing (the store may hold a newer text from elsewhere).
  let reported: ProseNode | null = null;
  const viewDoc = (ctx: Ctx) => ctx.get(editorViewCtx).state.doc;
  crepe.on((api) => {
    api.mounted((ctx) => {
      mounted = ctx;
      keep = sourceKeeper(ctx, original);
      reported = viewDoc(ctx);
    });
    api.markdownUpdated((ctx, written) => {
      reported = viewDoc(ctx);
      onChange(keep ? keep(written) : written);
    });
  });
  return {
    rebase: (body) => {
      if (!mounted) return;
      keep = sourceKeeper(mounted, body);
      reported = viewDoc(mounted);
    },
    flush: () => {
      const ctx: Ctx | null = mounted;
      if (!ctx) return;
      const doc = viewDoc(ctx);
      if (reported?.eq(doc)) return;
      reported = doc;
      const written = ctx.get(serializerCtx)(doc);
      onChange(keep ? keep(written) : written);
    },
  };
}

/** What {@link keepSourceOnSave} hands back. */
export interface SourceKeeping {
  /**
   * Take `body` as the text the editor's tree now stands for (call once
   * the tree shows it): a change made to the Markdown outside the editor,
   * such as a table menu edit, is then kept as written, and later edits
   * are spliced into it. Before the editor is mounted it does nothing.
   */
  rebase: (body: string) => void;
  /**
   * Report the editor's text now, as its next change report would (which
   * comes 200 ms after the last keystroke, and never once the editor is
   * destroyed). Nothing when the tree has not changed since the last report.
   */
  flush: () => void;
}
