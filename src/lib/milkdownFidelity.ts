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
 * reference definition in the replaced range is kept. When the source cannot
 * be mapped (block counts differ), the serializer's whole output is used, as
 * before.
 *
 * A block that is edited (one top-level block for one, as typing does) is
 * written in the style its source used where the serializer has a choice
 * ({@link blockStyle}): a `-` or `+` bullet list keeps its marker, an
 * ordered list its `)` and its numbering (`1.` `1.` `1.` stays so), a
 * setext heading stays setext (with its underline) and `## x ##` keeps its
 * closing `##`, a block that ends lines with two spaces for a hard break
 * keeps doing so, and `&nbsp;`, `&copy;` and other character references stay
 * as they were written ({@link keepSpellings}).
 */

import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx, remarkCtx, schemaCtx, serializerCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { bulletListSchema, listItemSchema } from "@milkdown/kit/preset/commonmark";
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
 * The source map of `tree` (the original body parsed by the editor's remark)
 * for a ProseMirror doc of `pmCount` top-level nodes: the range of each node,
 * and the link reference definitions (which Milkdown folds into the links
 * and drops as blocks). Null when the blocks do not line up one to one; a
 * last empty paragraph the editor adds after a final non-paragraph block is
 * mapped to the end of the last block.
 */
export function sourceRanges(tree: MdNode, pmCount: number): SourceMap | null {
  const blocks: BlockRange[] = [];
  const nodes: MdNode[] = [];
  const definitions: BlockRange[] = [];
  for (const child of tree.children ?? []) {
    const r = range(child);
    if (!r) return null;
    if (child.type === "definition") definitions.push(r);
    else {
      blocks.push(r);
      nodes.push(child);
    }
  }
  if (blocks.length === 0) return null;
  if (blocks.length === pmCount) return { blocks, definitions, nodes };
  if (blocks.length + 1 === pmCount) {
    const end = blocks[blocks.length - 1].end;
    return { blocks: [...blocks, { start: end, end }], definitions, nodes };
  }
  return null;
}

/** {@link sourceRanges}: where each top-level node's Markdown is. */
export interface SourceMap {
  /** Each top-level node's source range. */
  blocks: BlockRange[];
  /** The link reference definitions'. */
  definitions: BlockRange[];
  /** The remark node each range is (none for one the editor added). */
  nodes?: MdNode[];
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
  // The original text kept before and after the changed run: everything
  // up to the end of the last kept leading block (or up to the first block,
  // front matter's blank line included), and from the first kept trailing
  // block (or from the end of the last block: a missing final newline, a
  // definition at the end).
  const head =
    k === 0 ? original.slice(0, blocks[0].start) : original.slice(0, blocks[k - 1].end);
  const tail =
    m === 0 ? original.slice(blocks[n - 1].end) : original.slice(blocks[n - m].start);
  // Original blocks replaced: [k, n - m). Their outer gaps are kept as they
  // were (with any definitions in them); definitions between two replaced
  // blocks are kept after the rewritten run.
  const replacedFrom = k;
  const replacedTo = n - m;
  const kept =
    replacedTo - replacedFrom >= 2
      ? map.definitions
          .filter(
            (d) =>
              d.start >= blocks[replacedFrom].end &&
              d.end <= blocks[replacedTo - 1].start,
          )
          .map((d) => original.slice(d.start, d.end))
      : [];
  const middle =
    pairedRun(input, k, replacedTo, c - m) ??
    input.serializeRange(k, c - m).replace(/\n+$/, "");
  const parts = [middle, ...kept].filter((p) => p !== "");
  // The gap before the run (after the kept head) and after it (before the
  // kept tail), as in the original where there was one there.
  const before =
    k === 0
      ? ""
      : separating(k < n ? original.slice(blocks[k - 1].end, blocks[k].start) : "");
  // With blocks only inserted, the one original gap went before the run.
  const after =
    m === 0
      ? ""
      : separating(
          replacedTo > replacedFrom
            ? original.slice(blocks[replacedTo - 1].end, blocks[replacedTo].start)
            : "",
        );
  if (parts.length === 0) {
    // Blocks deleted, nothing written in their place.
    if (k === 0) return head + tail;
    if (m === 0) return head + tail;
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
 * run's length changed, or a block writes as nothing.
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
    const text = serializeBlock(i).replace(/\n+$/, "");
    if (text === "") return null;
    if (i > k)
      out += separating(original.slice(map.blocks[i - 1].end, map.blocks[i].start));
    out += text;
  }
  return out;
}

/**
 * `gap` (original text between two blocks) when it still separates the
 * blocks either side, whatever they now are: it holds a blank line and ends
 * with a line break. Otherwise a blank line.
 */
function separating(gap: string): string {
  return /\n[ \t]*\r?\n/.test(gap) && /\n$/.test(gap) ? gap : "\n\n";
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
    map = sourceRanges(tree, initial.childCount);
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
          const node = current.copy(Fragment.from(current.child(index)));
          const source = blocks.nodes?.[index];
          return source ? styled(node, source) : serializer(node);
        },
      });
    } catch {
      return written;
    }
  };
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
 * Each is put in as raw text (an `html` node, which is written as it is).
 */
export function keepSpellings(tree: unknown, source: string): void {
  const spaces = /( {2,})\r?\n/.exec(source);
  const breakText = spaces && !/\\\r?\n/.test(source) ? `${spaces[1]}\n` : null;
  const refs = characterReferences(source);
  if (breakText === null && refs === null) return;
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
      if (kid.type === "break" && !line && breakText !== null) {
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

/**
 * Wire a Crepe editor (before it is created) to save only what was edited:
 * `onChange` gets the body to save on every change, built by
 * {@link sourceKeeper} from `original`, the body the editor was given.
 * Tight bullet lists stay tight ({@link keepTightBulletLists}) and empty
 * table cells empty ({@link keepEmptyTableCells}).
 */
export function keepSourceOnSave(
  crepe: Crepe,
  original: string,
  onChange: (body: string) => void,
): void {
  crepe.editor.config(keepTightBulletLists).config(keepEmptyTableCells);
  let keep: ((written: string) => string) | null = null;
  crepe.on((api) => {
    api.mounted((ctx) => {
      keep = sourceKeeper(ctx, original);
    });
    api.markdownUpdated((_ctx, written) => {
      onChange(keep ? keep(written) : written);
    });
  });
}
