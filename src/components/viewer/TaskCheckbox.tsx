/**
 * TaskCheckbox.tsx
 *
 * Interactive checkbox for GFM task-list items rendered inside the Renderer.
 *
 * react-markdown renders `- [ ] …` items as:
 *   <li class="task-list-item">
 *     <input type="checkbox" disabled />
 *     …
 *   </li>
 *
 * The Renderer overrides the `input` component with this component. It:
 *   1. Reads the checkbox's source line from its `data-task-line`, which
 *      rehype-task-lines sets from the list item's position. The input
 *      remark-rehype creates has no position of its own, so reading
 *      `node.position` gave line 0 and every click was a no-op.
 *   2. On toggle, calls `toggleTaskAtLine` on the store's `content`.
 *   3. Calls `setContent` + `save()` to persist immediately.
 *
 * Only a checkbox of the open document toggles: an embedded note
 * (`![[Note]]`) renders its own text through the Renderer, whose lines are
 * not the open document's, so its checkboxes are read-only
 * ({@link TaskSourceContext}).
 *
 * If the document has no path (unsaved), the toggle still updates in-memory
 * content so the view stays consistent; `save()` is a no-op in that case.
 */

import type { Element } from "hast";
import { type ChangeEvent, createContext, useCallback, useContext } from "react";
import { toggleTaskAtLine } from "../../lib/tasklist";
import { useDocumentStore } from "../../store/documentStore";

/**
 * The Markdown text the enclosing Renderer renders, so a checkbox can tell
 * whether its line is a line of the open document. null outside a Renderer.
 */
export const TaskSourceContext = createContext<string | null>(null);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TaskCheckboxProps {
  /** Passed by react-markdown — the underlying hast element node. */
  node?: Element;
  checked?: boolean;
  /** react-markdown always renders task checkboxes as disabled — we override. */
  disabled?: boolean;
  /** Remaining props forwarded from react-markdown's component override. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TaskCheckbox({ node, checked, ...rest }: TaskCheckboxProps) {
  const content = useDocumentStore((s) => s.content);
  const setContent = useDocumentStore((s) => s.setContent);
  const save = useDocumentStore((s) => s.save);

  const source = useContext(TaskSourceContext);
  // 1-based, set by rehype-task-lines; 0 when the line holds no task.
  const line = Number(node?.properties?.dataTaskLine ?? 0);
  // A checkbox of an embedded note does not toggle the open document.
  const sourceLine = source === content && Number.isInteger(line) ? line : 0;

  const handleChange = useCallback(
    (_e: ChangeEvent<HTMLInputElement>) => {
      if (!sourceLine) return;
      const updated = toggleTaskAtLine(content, sourceLine);
      if (updated === content) return; // no-op guard
      setContent(updated);
      // Fire-and-forget — errors surface via documentStore.error.
      save().catch(() => {});
    },
    [content, sourceLine, setContent, save],
  );

  // Strip the `node` and `disabled` props to avoid leaking onto the DOM input.
  // We intentionally remove `disabled` so the checkbox is interactive.
  const {
    disabled: _disabled,
    node: _node,
    ...domProps
  } = {
    disabled: rest.disabled,
    node: rest.node,
    ...rest,
  };

  return (
    <input
      {...domProps}
      type="checkbox"
      checked={checked ?? false}
      disabled={!sourceLine}
      onChange={handleChange}
      className="task-checkbox"
      // aria label derives from checked state for screen readers
      aria-label={checked ? "Mark as not done" : "Mark as done"}
    />
  );
}
