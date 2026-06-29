/**
 * milkdownImageDragDrop.test.ts — unit + integration tests for the
 * Milkdown drag-drop image reorder helpers.
 *
 * Covers:
 *   - extractImageRefs(): detection of wiki-embed and standard Markdown images
 *   - reorderImageInMarkdown(): move, boundary, no-op, and corruption-guard cases
 *   - makeDragDropPlugin(): DOM event wiring calls onReorder correctly
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractImageRefs,
  makeDragDropPlugin,
  reorderImageInMarkdown,
} from "./milkdownImageDragDrop";

// ── Mock @milkdown/kit/prose/state so makeDragDropPlugin can be tested without
// a real ProseMirror runtime. We only need Plugin + PluginKey.
vi.mock("@milkdown/kit/prose/state", () => {
  class PluginKey {
    constructor(public name: string) {}
  }

  // Plugin stores its spec; when view() is called we call spec.view().
  class Plugin {
    spec: Record<string, unknown>;
    constructor(spec: Record<string, unknown>) {
      this.spec = spec;
    }
  }

  return { Plugin, PluginKey };
});

// ── extractImageRefs ──────────────────────────────────────────────────────────

describe("extractImageRefs", () => {
  it("finds a single standard Markdown image", () => {
    const refs = extractImageRefs("Hello ![](img.png) world");
    expect(refs).toHaveLength(1);
    expect(refs[0].token).toBe("![](img.png)");
    expect(refs[0].kind).toBe("standard");
  });

  it("finds a single wiki-embed image", () => {
    const refs = extractImageRefs("![[photo.png]]");
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("wiki");
    expect(refs[0].token).toBe("![[photo.png]]");
  });

  it("returns refs in document order for mixed content", () => {
    const md = "![[first.png]]\n\nSome text\n\n![](second.png)";
    const refs = extractImageRefs(md);
    expect(refs).toHaveLength(2);
    expect(refs[0].token).toBe("![[first.png]]");
    expect(refs[1].token).toBe("![](second.png)");
  });

  it("returns an empty array when there are no images", () => {
    expect(extractImageRefs("# Heading\n\nJust text.")).toHaveLength(0);
  });

  it("correctly records the offset of each image", () => {
    const md = "abc ![](a.png) def ![](b.png)";
    const refs = extractImageRefs(md);
    expect(refs[0].offset).toBe(md.indexOf("![](a.png)"));
    expect(refs[1].offset).toBe(md.indexOf("![](b.png)"));
  });
});

// ── reorderImageInMarkdown ────────────────────────────────────────────────────

describe("reorderImageInMarkdown", () => {
  const twoImages = "![](a.png)\n\nSome text\n\n![](b.png)";
  const threeImages = "![](a.png)\n![](b.png)\n![](c.png)";

  it("swaps first and second image by moving index 1 before index 0", () => {
    // Moving the second image (b) to before the first (a) produces: b … a.
    const result = reorderImageInMarkdown(twoImages, 1, 0);
    const refs = extractImageRefs(result);
    expect(refs[0].token).toBe("![](b.png)");
    expect(refs[1].token).toBe("![](a.png)");
  });

  it("moves the last image to the first position", () => {
    const result = reorderImageInMarkdown(threeImages, 2, 0);
    const refs = extractImageRefs(result);
    expect(refs[0].token).toBe("![](c.png)");
    expect(refs[1].token).toBe("![](a.png)");
    expect(refs[2].token).toBe("![](b.png)");
  });

  it("returns the source unchanged when fromIndex === toIndex", () => {
    expect(reorderImageInMarkdown(twoImages, 0, 0)).toBe(twoImages);
  });

  it("returns the source unchanged when there is only one image", () => {
    const md = "![](only.png)";
    expect(reorderImageInMarkdown(md, 0, 1)).toBe(md);
  });

  it("does not corrupt non-image text content", () => {
    const md = "# Title\n\n![](a.png)\n\nParagraph.\n\n![](b.png)\n\nFooter.";
    const result = reorderImageInMarkdown(md, 0, 1);
    expect(result).toContain("# Title");
    expect(result).toContain("Paragraph.");
    expect(result).toContain("Footer.");
  });

  it("clamps an out-of-range fromIndex (above) and returns source unchanged", () => {
    // fromIndex 99 clamps to last (1); toIndex 1 equals clamped from → no-op.
    const result = reorderImageInMarkdown(twoImages, 99, 1);
    // No corruption: both images still present.
    const refs = extractImageRefs(result);
    expect(refs).toHaveLength(2);
  });

  it("preserves all image tokens after reorder (no token lost or duplicated)", () => {
    const result = reorderImageInMarkdown(threeImages, 1, 0);
    const refs = extractImageRefs(result);
    expect(refs).toHaveLength(3);
    const tokens = refs.map((r) => r.token).sort();
    expect(tokens).toEqual(["![](a.png)", "![](b.png)", "![](c.png)"].sort());
  });

  it("handles wiki-embed images alongside standard images (swap: move index 1 before 0)", () => {
    const md = "![[wiki.png]]\n\n![](std.png)";
    // Move std (index 1) before wiki (index 0) → std comes first.
    const result = reorderImageInMarkdown(md, 1, 0);
    const refs = extractImageRefs(result);
    expect(refs[0].token).toBe("![](std.png)");
    expect(refs[1].token).toBe("![[wiki.png]]");
  });
});

// ── makeDragDropPlugin (DOM event wiring) ─────────────────────────────────────

describe("makeDragDropPlugin — DOM event wiring", () => {
  /** Minimal EditorView-like object with a real DOM element. */
  function makeEditorView() {
    const dom = document.createElement("div");
    return {
      dom,
      state: { selection: { from: 0, to: 0 } },
      dispatch: vi.fn(),
    };
  }

  /** Create a drag event with a stub dataTransfer. */
  function makeDragEvent(type: string, imageIndex?: number): DragEvent {
    const dt = {
      setData: vi.fn(),
      getData: vi.fn((key: string) =>
        key === "text/x-image-index" && imageIndex !== undefined
          ? String(imageIndex)
          : "",
      ),
    };
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: dt, writable: false });
    return event;
  }

  it("calls onReorder with correct fromIndex and toIndex on a valid drop", () => {
    const onReorder = vi.fn();
    const plugin = makeDragDropPlugin({ onReorder });
    const editorView = makeEditorView();

    // Call view() from the plugin spec to register event listeners.
    const viewFn = (plugin as unknown as { spec: { view: (v: unknown) => unknown } }).spec
      .view;
    viewFn(editorView);

    // Create two img elements with data-image-index attributes.
    const imgA = document.createElement("img");
    imgA.setAttribute("data-image-index", "0");
    imgA.setAttribute("draggable", "true");
    const imgB = document.createElement("img");
    imgB.setAttribute("data-image-index", "1");
    imgB.setAttribute("draggable", "true");
    editorView.dom.appendChild(imgA);
    editorView.dom.appendChild(imgB);

    // Simulate dragstart on imgA.
    const dragStart = makeDragEvent("dragstart");
    Object.defineProperty(dragStart, "target", { value: imgA, writable: false });
    editorView.dom.dispatchEvent(dragStart);

    // Simulate drop on imgB.
    const drop = makeDragEvent("drop");
    Object.defineProperty(drop, "target", { value: imgB, writable: false });
    editorView.dom.dispatchEvent(drop);

    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });

  it("does not call onReorder when drop target has no data-image-index", () => {
    const onReorder = vi.fn();
    const plugin = makeDragDropPlugin({ onReorder });
    const editorView = makeEditorView();

    const viewFn = (plugin as unknown as { spec: { view: (v: unknown) => unknown } }).spec
      .view;
    viewFn(editorView);

    const imgA = document.createElement("img");
    imgA.setAttribute("data-image-index", "0");
    const para = document.createElement("p");
    para.textContent = "plain text";
    editorView.dom.appendChild(imgA);
    editorView.dom.appendChild(para);

    const dragStart = makeDragEvent("dragstart");
    Object.defineProperty(dragStart, "target", { value: imgA, writable: false });
    editorView.dom.dispatchEvent(dragStart);

    const drop = makeDragEvent("drop");
    Object.defineProperty(drop, "target", { value: para, writable: false });
    editorView.dom.dispatchEvent(drop);

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("does not call onReorder when from and to indices are equal", () => {
    const onReorder = vi.fn();
    const plugin = makeDragDropPlugin({ onReorder });
    const editorView = makeEditorView();

    const viewFn = (plugin as unknown as { spec: { view: (v: unknown) => unknown } }).spec
      .view;
    viewFn(editorView);

    const img = document.createElement("img");
    img.setAttribute("data-image-index", "0");
    editorView.dom.appendChild(img);

    const dragStart = makeDragEvent("dragstart");
    Object.defineProperty(dragStart, "target", { value: img, writable: false });
    editorView.dom.dispatchEvent(dragStart);

    const drop = makeDragEvent("drop");
    Object.defineProperty(drop, "target", { value: img, writable: false });
    editorView.dom.dispatchEvent(drop);

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("removes event listeners on destroy() so no onReorder fires after destroy", () => {
    const onReorder = vi.fn();
    const plugin = makeDragDropPlugin({ onReorder });
    const editorView = makeEditorView();

    const viewFn = (plugin as unknown as { spec: { view: (v: unknown) => unknown } }).spec
      .view;
    const handle = viewFn(editorView) as { destroy: () => void };

    const imgA = document.createElement("img");
    imgA.setAttribute("data-image-index", "0");
    const imgB = document.createElement("img");
    imgB.setAttribute("data-image-index", "1");
    editorView.dom.appendChild(imgA);
    editorView.dom.appendChild(imgB);

    // Destroy the plugin view (removes listeners).
    handle.destroy();

    const dragStart = makeDragEvent("dragstart");
    Object.defineProperty(dragStart, "target", { value: imgA, writable: false });
    editorView.dom.dispatchEvent(dragStart);

    const drop = makeDragEvent("drop");
    Object.defineProperty(drop, "target", { value: imgB, writable: false });
    editorView.dom.dispatchEvent(drop);

    expect(onReorder).not.toHaveBeenCalled();
  });
});
