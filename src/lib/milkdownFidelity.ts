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
 */

import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx, remarkCtx, serializerCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { bulletListSchema, listItemSchema } from "@milkdown/kit/preset/commonmark";
import {
  extendListItemSchemaForTask,
  tableCellSchema,
  tableHeaderSchema,
} from "@milkdown/kit/preset/gfm";
import { Fragment, type Node as ProseNode } from "@milkdown/kit/prose/model";

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
export function sourceRanges(
  tree: MdNode,
  pmCount: number,
): { blocks: BlockRange[]; definitions: BlockRange[] } | null {
  const blocks: BlockRange[] = [];
  const definitions: BlockRange[] = [];
  for (const child of tree.children ?? []) {
    const r = range(child);
    if (!r) return null;
    if (child.type === "definition") definitions.push(r);
    else blocks.push(r);
  }
  if (blocks.length === 0) return null;
  if (blocks.length === pmCount) return { blocks, definitions };
  if (blocks.length + 1 === pmCount) {
    const end = blocks[blocks.length - 1].end;
    return { blocks: [...blocks, { start: end, end }], definitions };
  }
  return null;
}

export interface SpliceInput {
  /** The body as it was loaded. */
  original: string;
  /** {@link sourceRanges} of `original` for `initial`. */
  map: { blocks: BlockRange[]; definitions: BlockRange[] };
  /** The editor's tree as loaded. */
  initial: PmNode;
  /** The editor's tree now. */
  current: PmNode;
  /** Serialize top-level nodes `[from, to)` of `current` (no trailing newline needed). */
  serializeRange: (from: number, to: number) => string;
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
  const c = current.childCount;
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
  const middle = input.serializeRange(k, c - m).replace(/\n+$/, "");
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
      });
    } catch {
      return written;
    }
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
