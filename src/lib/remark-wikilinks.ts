/**
 * remark-wikilinks.ts
 *
 * Remark plugin for Obsidian-style internal links and embeds:
 *   [[target]]            → internal link (rendered by Wikilink.tsx)
 *   [[target|alias]]      → internal link with display text
 *   [[target#heading]]    → link carrying a heading fragment
 *   ![[target]]           → transclusion / embed (rendered by WikiEmbed.tsx)
 *
 * Modeled on remark-callouts: it rewrites text nodes into custom inline nodes
 * whose `data.hName` / `data.hProperties` make rehype emit a tagged element that
 * Renderer.tsx intercepts. The `data-*` props are allowlisted in the sanitize
 * schema (see lib/sanitizeSchema.ts).
 */

import type { Root, Text } from "mdast";
import { visit } from "unist-util-visit";

// bang? + [[ target (no ] | #) (#heading)? (|alias)? ]]
const WIKILINK_RE = /(!)?\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

export function remarkWikilinks() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (index == null || !parent || !node.value.includes("[[")) return;
      // Only rewrite plain prose text — never inside a link label, image, or
      // code, where splicing siblings would corrupt the surrounding node.
      if (
        [
          "link",
          "linkReference",
          "image",
          "imageReference",
          "code",
          "inlineCode",
        ].includes(parent.type)
      ) {
        return;
      }

      // biome-ignore lint/suspicious/noExplicitAny: mdast→hast custom nodes
      const replacement: any[] = [];
      let last = 0;
      WIKILINK_RE.lastIndex = 0;
      let m: RegExpExecArray | null = WIKILINK_RE.exec(node.value);
      while (m !== null) {
        const [full, bang, target, heading, alias] = m;
        const start = m.index;
        if (start > last) {
          replacement.push({ type: "text", value: node.value.slice(last, start) });
        }
        const fullTarget = heading ? `${target}#${heading}` : target;
        const label = alias ?? (heading ? `${target} › ${heading}` : target);

        if (bang === "!") {
          // For embeds the `|alias` slot is Obsidian's size hint (e.g.
          // `![[img.png|300]]` or `|300x200`). Pass it through for images.
          const embedProps: Record<string, unknown> = {
            className: ["wikiembed"],
            dataEmbedTarget: fullTarget,
          };
          if (alias) embedProps.dataEmbedSize = alias;
          replacement.push({
            type: "wikiembed",
            data: { hName: "div", hProperties: embedProps },
            children: [],
          });
        } else {
          replacement.push({
            type: "wikilink",
            data: {
              hName: "a",
              hProperties: {
                className: ["wikilink"],
                dataWikitarget: fullTarget,
                dataWikialias: label,
              },
            },
            children: [{ type: "text", value: label }],
          });
        }
        last = start + full.length;
        m = WIKILINK_RE.exec(node.value);
      }

      if (replacement.length === 0) return;
      if (last < node.value.length) {
        replacement.push({ type: "text", value: node.value.slice(last) });
      }
      parent.children.splice(index, 1, ...replacement);
      // Continue after the inserted nodes (their text slices have no "[[").
      return index + replacement.length;
    });
  };
}
