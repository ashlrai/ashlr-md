/**
 * rehype-task-lines.ts
 *
 * Rehype plugin that gives each GFM task checkbox the source line of its
 * `[ ]` / `[x]`, as `data-task-line`, so the read view can toggle it in the
 * document (src/components/viewer/TaskCheckbox.tsx).
 *
 * remark-rehype creates the checkbox `<input>` itself, with no source
 * position, and rehype-raw keeps it that way, so the checkbox used to read
 * line 0 and every click was a no-op. The list item around it keeps its
 * position, so the line is taken from there: the checkbox is the item's
 * first content, on the item's first line or, for an item opened by a bare
 * marker (`-`, then `  [ ] t`), on the next. The line must hold a task by
 * the rule the toggle uses ({@link taskMarks}), in the same state as the
 * checkbox; otherwise the checkbox gets no line and stays a no-op.
 *
 * It runs after rehype-sanitize, so a document's raw HTML cannot set the
 * attribute (the sanitizer allows no `data-*` on `<input>`).
 */

import type { Element, ElementContent, Root, RootContent } from "hast";
import { markdownLines } from "./outline";
import { taskMarks } from "./tasklist";

/** Whether `node` is an element whose className includes `name`. */
function hasClass(node: Element, name: string): boolean {
  const cls = node.properties?.className;
  return Array.isArray(cls) ? cls.includes(name) : cls === name;
}

/** The first element among `children`, skipping whitespace text. */
function firstElement(children: ElementContent[]): Element | null {
  for (const c of children) {
    if (c.type === "element") return c;
    if (c.type === "text" && c.value.trim() === "") continue;
    return null;
  }
  return null;
}

/**
 * The task checkbox remark-rehype put at the start of task item `li`: its
 * first element (a tight list) or the first element of its first paragraph.
 */
function checkboxOf(li: Element): Element | null {
  let first = firstElement(li.children);
  if (first?.tagName === "p") first = firstElement(first.children);
  if (first?.tagName !== "input" || first.properties?.type !== "checkbox") return null;
  return first;
}

/** Rehype plugin: sets `data-task-line` on each task checkbox. */
export function rehypeTaskLines() {
  return (tree: Root, file: { value?: unknown }) => {
    const source =
      typeof file.value === "string" ? file.value : String(file.value ?? "");
    let marks: ReturnType<typeof taskMarks> | null = null;
    let lines: ReturnType<typeof markdownLines> | null = null;
    const walk = (node: Root | RootContent) => {
      if (node.type !== "root" && node.type !== "element") return;
      if (
        node.type === "element" &&
        node.tagName === "li" &&
        hasClass(node, "task-list-item")
      ) {
        const box = checkboxOf(node);
        const start = node.position?.start.line;
        if (box && start) {
          marks ??= taskMarks(source);
          lines ??= markdownLines(source);
          // A bare marker has its checkbox on the next line.
          const line = lines[start - 1]?.content.trim() === "" ? start + 1 : start;
          const mark = marks[line - 1];
          if (mark && mark.checked === (box.properties.checked === true)) {
            box.properties.dataTaskLine = line;
          }
        }
      }
      for (const child of node.children) walk(child);
    };
    walk(tree);
  };
}
