import { type CanvasEditOp, parseCanvas } from "./canvas";

export type CanvasEdit = Extract<
  CanvasEditOp,
  { type: "move_node" | "resize_node" | "edit_text" }
>;

/** Patch the original JSON, never the lossy display model. Unknown data stays. */
export function editCanvas(content: string, edit: CanvasEdit): string {
  const parsed = parseCanvas(content);
  if (!parsed.ok) throw new Error(parsed.error);
  const document = JSON.parse(content) as Record<string, unknown>;
  const nodes: unknown[] = Array.isArray(document.nodes) ? document.nodes : [];
  const matches = nodes.filter(
    (n): n is Record<string, unknown> =>
      n !== null &&
      typeof n === "object" &&
      !Array.isArray(n) &&
      (n as Record<string, unknown>).id === edit.id,
  );
  if (matches.length !== 1 || !parsed.canvas.nodes.some((n) => n.id === edit.id))
    throw new Error("Editing requires one valid node with a unique id");
  const node = matches[0];
  let patch: Record<string, unknown>;
  switch (edit.type) {
    case "move_node":
      if (!Number.isFinite(edit.x) || !Number.isFinite(edit.y))
        throw new Error("Coordinates must be finite");
      patch = { x: edit.x, y: edit.y };
      break;
    case "resize_node":
      if (
        !Number.isFinite(edit.width) ||
        !Number.isFinite(edit.height) ||
        edit.width <= 0 ||
        edit.height <= 0
      )
        throw new Error("Dimensions must be finite and positive");
      patch = { width: edit.width, height: edit.height };
      break;
    case "edit_text":
      if (node.type !== "text") throw new Error("Only text nodes can edit text");
      patch = { text: edit.text };
      break;
  }
  if (Object.entries(patch).every(([key, value]) => node[key] === value))
    return content;
  return JSON.stringify(
    {
      ...document,
      nodes: nodes.map((n) => (n === node ? { ...node, ...patch } : n)),
    },
    null,
    2,
  );
}
