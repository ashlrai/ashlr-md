/**
 * pasteImage.test.ts — comprehensive unit tests for pasteImage.ts
 *
 * Covers:
 *   - clipboardHasImage(): MIME detection, non-image rejection, mixed content, edge cases
 *   - handleImagePaste(): image extraction, size limits (via mock), disk-write success/failure,
 *     markdown output format, unsaved-doc guard, toast messages
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock Tauri invoke before importing the module under test ──────────────────
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// ── Mock the document store ───────────────────────────────────────────────────
let mockDocPath: string | null = "/vault/notes/doc.md";
vi.mock("../store/documentStore", () => ({
  useDocumentStore: {
    getState: () => ({ path: mockDocPath }),
  },
}));

// ── Capture toast calls ───────────────────────────────────────────────────────
const toastInfoMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock("../store/toastStore", () => ({
  toast: {
    info: (...args: unknown[]) => toastInfoMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: vi.fn(),
  },
}));

// Import after mocks are registered.
import { clipboardHasImage, handleImagePaste } from "./pasteImage";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal DataTransferItem for a given MIME kind. */
function makeItem(mimeType: string, kind: "file" | "string" = "file"): DataTransferItem {
  return {
    kind,
    type: mimeType,
    getAsFile: () => makeBlob(mimeType),
    getAsString: vi.fn(),
    webkitGetAsEntry: vi.fn(),
  } as unknown as DataTransferItem;
}

/** Build a DataTransferItem whose getAsFile() returns null. */
function makeNullFileItem(mimeType: string): DataTransferItem {
  return {
    kind: "file",
    type: mimeType,
    getAsFile: () => null,
    getAsString: vi.fn(),
    webkitGetAsEntry: vi.fn(),
  } as unknown as DataTransferItem;
}

/** Tiny 1×1 PNG data URL → ArrayBuffer bytes that look like a real PNG. */
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function dataURLToUint8Array(dataURL: string): Uint8Array {
  const b64 = dataURL.split(",")[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function makeBlob(mimeType: string, dataURL = PNG_DATA_URL): Blob {
  const bytes = dataURLToUint8Array(dataURL);
  return new Blob([bytes], { type: mimeType });
}

/** Build a DataTransfer-like object with the given items. */
function makeDataTransfer(...items: DataTransferItem[]): DataTransfer {
  // DataTransferItemList is array-like + iterable.
  const itemList = {
    length: items.length,
    [Symbol.iterator]: function* () {
      yield* items;
    },
  } as unknown as DataTransferItemList;

  return { items: itemList } as unknown as DataTransfer;
}

// ── clipboardHasImage ─────────────────────────────────────────────────────────

describe("clipboardHasImage", () => {
  it("returns true for image/png", () => {
    expect(clipboardHasImage(makeDataTransfer(makeItem("image/png")))).toBe(true);
  });

  it("returns true for image/jpeg", () => {
    expect(clipboardHasImage(makeDataTransfer(makeItem("image/jpeg")))).toBe(true);
  });

  it("returns true for image/webp", () => {
    expect(clipboardHasImage(makeDataTransfer(makeItem("image/webp")))).toBe(true);
  });

  it("returns true for image/gif", () => {
    expect(clipboardHasImage(makeDataTransfer(makeItem("image/gif")))).toBe(true);
  });

  it("returns true for image/svg+xml", () => {
    expect(clipboardHasImage(makeDataTransfer(makeItem("image/svg+xml")))).toBe(true);
  });

  it("returns false for text/plain", () => {
    expect(clipboardHasImage(makeDataTransfer(makeItem("text/plain", "string")))).toBe(false);
  });

  it("returns false for application/pdf", () => {
    expect(clipboardHasImage(makeDataTransfer(makeItem("application/pdf")))).toBe(false);
  });

  it("returns false for text/html", () => {
    expect(clipboardHasImage(makeDataTransfer(makeItem("text/html", "string")))).toBe(false);
  });

  it("returns false for unknown image/* subtype (image/bmp not in allowlist)", () => {
    expect(clipboardHasImage(makeDataTransfer(makeItem("image/bmp")))).toBe(false);
  });

  it("returns false when items list is empty", () => {
    expect(clipboardHasImage(makeDataTransfer())).toBe(false);
  });

  it("returns false for null DataTransfer", () => {
    expect(clipboardHasImage(null)).toBe(false);
  });

  it("detects image in mixed clipboard (text + image)", () => {
    const textItem = makeItem("text/plain", "string");
    const imgItem = makeItem("image/png");
    expect(clipboardHasImage(makeDataTransfer(textItem, imgItem))).toBe(true);
  });

  it("returns false when only non-image file items are present", () => {
    const pdfItem = makeItem("application/pdf");
    const docItem = makeItem("application/msword");
    expect(clipboardHasImage(makeDataTransfer(pdfItem, docItem))).toBe(false);
  });

  it("picks up the first image even when it follows non-image items", () => {
    const textItem = makeItem("text/plain", "string");
    const imgItem = makeItem("image/jpeg");
    const dt = makeDataTransfer(textItem, imgItem);
    expect(clipboardHasImage(dt)).toBe(true);
  });
});

// ── handleImagePaste ──────────────────────────────────────────────────────────

describe("handleImagePaste", () => {
  beforeEach(() => {
    mockDocPath = "/vault/notes/doc.md";
    invokeMock.mockReset();
    toastInfoMock.mockReset();
    toastErrorMock.mockReset();
    // Default: Rust command returns a relative path.
    invokeMock.mockResolvedValue(".images/image-2024-06-29-ABCD.png");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── No-image fast paths ─────────────────────────────────────────────────────

  it("returns null when DataTransfer is null", async () => {
    expect(await handleImagePaste(null)).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns null when clipboard has no image items", async () => {
    const dt = makeDataTransfer(makeItem("text/plain", "string"));
    expect(await handleImagePaste(dt)).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  // ── Unsaved document guard ──────────────────────────────────────────────────

  it("shows an info toast and returns null when no document is open (path is null)", async () => {
    mockDocPath = null;
    const dt = makeDataTransfer(makeItem("image/png"));
    const result = await handleImagePaste(dt);
    expect(result).toBeNull();
    expect(toastInfoMock).toHaveBeenCalledWith(
      expect.stringContaining("Save the document"),
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  // ── getAsFile() edge cases ──────────────────────────────────────────────────

  it("returns null when getAsFile() returns null (browser permission denied)", async () => {
    const dt = makeDataTransfer(makeNullFileItem("image/png"));
    expect(await handleImagePaste(dt)).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  // ── Successful paste → markdown output ─────────────────────────────────────

  it("invokes save_pasted_image with docPath, bytes array, and correct ext for PNG", async () => {
    const dt = makeDataTransfer(makeItem("image/png"));
    await handleImagePaste(dt);
    expect(invokeMock).toHaveBeenCalledWith(
      "save_pasted_image",
      expect.objectContaining({
        docPath: "/vault/notes/doc.md",
        ext: "png",
        bytes: expect.any(Array),
      }),
    );
  });

  it("invokes save_pasted_image with ext 'jpg' for image/jpeg", async () => {
    const dt = makeDataTransfer(makeItem("image/jpeg"));
    await handleImagePaste(dt);
    expect(invokeMock).toHaveBeenCalledWith(
      "save_pasted_image",
      expect.objectContaining({ ext: "jpg" }),
    );
  });

  it("invokes save_pasted_image with ext 'gif' for image/gif", async () => {
    const dt = makeDataTransfer(makeItem("image/gif"));
    await handleImagePaste(dt);
    expect(invokeMock).toHaveBeenCalledWith(
      "save_pasted_image",
      expect.objectContaining({ ext: "gif" }),
    );
  });

  it("invokes save_pasted_image with ext 'webp' for image/webp", async () => {
    const dt = makeDataTransfer(makeItem("image/webp"));
    await handleImagePaste(dt);
    expect(invokeMock).toHaveBeenCalledWith(
      "save_pasted_image",
      expect.objectContaining({ ext: "webp" }),
    );
  });

  it("invokes save_pasted_image with ext 'svg' for image/svg+xml", async () => {
    const dt = makeDataTransfer(makeItem("image/svg+xml"));
    await handleImagePaste(dt);
    expect(invokeMock).toHaveBeenCalledWith(
      "save_pasted_image",
      expect.objectContaining({ ext: "svg" }),
    );
  });

  it("returns standard markdown ![](relPath) from the Rust-returned relative path", async () => {
    invokeMock.mockResolvedValue(".images/screenshot.png");
    const dt = makeDataTransfer(makeItem("image/png"));
    const md = await handleImagePaste(dt);
    expect(md).toBe("![](.images/screenshot.png)");
  });

  it("bytes passed to invoke are a plain Array (not Uint8Array) of numbers", async () => {
    const dt = makeDataTransfer(makeItem("image/png"));
    await handleImagePaste(dt);
    const callArgs = invokeMock.mock.calls[0][1];
    expect(Array.isArray(callArgs.bytes)).toBe(true);
    expect(typeof callArgs.bytes[0]).toBe("number");
  });

  it("passes the correct docPath for a document in a nested folder", async () => {
    mockDocPath = "/vault/projects/2024/notes.md";
    invokeMock.mockResolvedValue(".images/img.png");
    const dt = makeDataTransfer(makeItem("image/png"));
    await handleImagePaste(dt);
    expect(invokeMock).toHaveBeenCalledWith(
      "save_pasted_image",
      expect.objectContaining({ docPath: "/vault/projects/2024/notes.md" }),
    );
  });

  // ── Mixed clipboard: only the first image is processed ─────────────────────

  it("uses the first image item when clipboard has both text and image", async () => {
    const textItem = makeItem("text/plain", "string");
    const imgItem = makeItem("image/png");
    const dt = makeDataTransfer(textItem, imgItem);
    invokeMock.mockResolvedValue(".images/img.png");
    const md = await handleImagePaste(dt);
    expect(md).toBe("![](.images/img.png)");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("uses the first supported image when multiple images are in the clipboard", async () => {
    const firstImg = makeItem("image/png");
    const secondImg = makeItem("image/jpeg");
    const dt = makeDataTransfer(firstImg, secondImg);
    invokeMock.mockResolvedValue(".images/first.png");
    const md = await handleImagePaste(dt);
    expect(md).toBe("![](.images/first.png)");
    // Only one save_pasted_image call for the first image.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "save_pasted_image",
      expect.objectContaining({ ext: "png" }),
    );
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it("shows an error toast and returns null when save_pasted_image throws", async () => {
    invokeMock.mockRejectedValue(new Error("disk full"));
    const dt = makeDataTransfer(makeItem("image/png"));
    const result = await handleImagePaste(dt);
    expect(result).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Could not save pasted image"),
    );
  });

  it("error toast message includes the underlying error string", async () => {
    invokeMock.mockRejectedValue(new Error("permission denied"));
    const dt = makeDataTransfer(makeItem("image/png"));
    await handleImagePaste(dt);
    const call = toastErrorMock.mock.calls[0][0] as string;
    expect(call).toContain("permission denied");
  });

  it("shows an error toast when invoke rejects with a non-Error object", async () => {
    invokeMock.mockRejectedValue("write failed");
    const dt = makeDataTransfer(makeItem("image/png"));
    const result = await handleImagePaste(dt);
    expect(result).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("write failed"));
  });

  it("does not throw to the caller when the Rust command fails", async () => {
    invokeMock.mockRejectedValue(new Error("FS error"));
    const dt = makeDataTransfer(makeItem("image/png"));
    await expect(handleImagePaste(dt)).resolves.toBeNull();
  });

  // ── No side effects on non-image pastes ────────────────────────────────────

  it("does not call toast when there is no image to paste", async () => {
    const dt = makeDataTransfer(makeItem("text/html", "string"));
    await handleImagePaste(dt);
    expect(toastInfoMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  // ── Return value is correctly formed markdown ───────────────────────────────

  it("markdown wraps the relative path verbatim including subdirectories", async () => {
    invokeMock.mockResolvedValue("assets/2024/screenshot-01.webp");
    const dt = makeDataTransfer(makeItem("image/webp"));
    const md = await handleImagePaste(dt);
    expect(md).toBe("![](assets/2024/screenshot-01.webp)");
  });

  it("markdown works for paths with spaces (URL-encoded by the Rust side)", async () => {
    invokeMock.mockResolvedValue(".images/my%20image.png");
    const dt = makeDataTransfer(makeItem("image/png"));
    const md = await handleImagePaste(dt);
    expect(md).toBe("![](.images/my%20image.png)");
  });

  it("markdown alt text is empty (positional cursor insert, not a titled image)", async () => {
    invokeMock.mockResolvedValue(".images/img.png");
    const dt = makeDataTransfer(makeItem("image/png"));
    const md = await handleImagePaste(dt);
    // The spec format is ![](path) — no alt text.
    expect(md).toMatch(/^!\[\]\(/);
  });
});

// ── handleImagePasteWithSettings ──────────────────────────────────────────────

import {
  expectedSavePath,
  handleImagePasteWithSettings,
  pasteImageFilename,
} from "./pasteImage";

describe("handleImagePasteWithSettings — doc-relative mode", () => {
  beforeEach(() => {
    mockDocPath = "/vault/notes/doc.md";
    invokeMock.mockReset();
    toastInfoMock.mockReset();
    toastErrorMock.mockReset();
    invokeMock.mockResolvedValue("assets/image.png");
  });

  it("calls save_pasted_image (not the downloads variant) in doc-relative mode", async () => {
    const dt = makeDataTransfer(makeItem("image/png"));
    await handleImagePasteWithSettings(dt, "doc-relative");
    expect(invokeMock).toHaveBeenCalledWith("save_pasted_image", expect.any(Object));
    expect(invokeMock).not.toHaveBeenCalledWith(
      "save_pasted_image_to_downloads",
      expect.any(Object),
    );
  });

  it("returns ![](relPath) from the relative path returned by Rust", async () => {
    invokeMock.mockResolvedValue("assets/screenshot.png");
    const dt = makeDataTransfer(makeItem("image/png"));
    const md = await handleImagePasteWithSettings(dt, "doc-relative");
    expect(md).toBe("![](assets/screenshot.png)");
  });

  it("returns null and shows info toast when doc path is null in doc-relative mode", async () => {
    mockDocPath = null;
    const dt = makeDataTransfer(makeItem("image/png"));
    const result = await handleImagePasteWithSettings(dt, "doc-relative");
    expect(result).toBeNull();
    expect(toastInfoMock).toHaveBeenCalledWith(expect.stringContaining("Save the document"));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns null for null DataTransfer", async () => {
    expect(await handleImagePasteWithSettings(null, "doc-relative")).toBeNull();
  });

  it("shows error toast when Rust save fails in doc-relative mode", async () => {
    invokeMock.mockRejectedValue(new Error("no space left"));
    const dt = makeDataTransfer(makeItem("image/png"));
    const result = await handleImagePasteWithSettings(dt, "doc-relative");
    expect(result).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("no space left"));
  });
});

describe("handleImagePasteWithSettings — downloads mode", () => {
  beforeEach(() => {
    mockDocPath = null; // downloads mode does NOT need a saved doc
    invokeMock.mockReset();
    toastInfoMock.mockReset();
    toastErrorMock.mockReset();
    invokeMock.mockResolvedValue("/Users/user/Downloads/mdopener-paste/image.png");
  });

  it("calls save_pasted_image_to_downloads (not save_pasted_image) in downloads mode", async () => {
    const dt = makeDataTransfer(makeItem("image/png"));
    await handleImagePasteWithSettings(dt, "downloads");
    expect(invokeMock).toHaveBeenCalledWith(
      "save_pasted_image_to_downloads",
      expect.any(Object),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("save_pasted_image", expect.any(Object));
  });

  it("does NOT require a saved document in downloads mode", async () => {
    mockDocPath = null;
    const dt = makeDataTransfer(makeItem("image/png"));
    const result = await handleImagePasteWithSettings(dt, "downloads");
    expect(result).not.toBeNull();
    expect(toastInfoMock).not.toHaveBeenCalled();
  });

  it("returns ![](absPath) from the absolute path returned by Rust", async () => {
    invokeMock.mockResolvedValue("/Users/user/Downloads/mdopener-paste/img.png");
    const dt = makeDataTransfer(makeItem("image/png"));
    const md = await handleImagePasteWithSettings(dt, "downloads");
    expect(md).toBe("![](/Users/user/Downloads/mdopener-paste/img.png)");
  });

  it("passes bytes and ext but NOT docPath to the downloads Rust command", async () => {
    const dt = makeDataTransfer(makeItem("image/webp"));
    await handleImagePasteWithSettings(dt, "downloads");
    const [cmd, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe("save_pasted_image_to_downloads");
    expect(args).toHaveProperty("bytes");
    expect(args).toHaveProperty("ext", "webp");
    expect(args).not.toHaveProperty("docPath");
  });

  it("shows error toast and returns null when downloads Rust command fails", async () => {
    invokeMock.mockRejectedValue(new Error("Downloads folder missing"));
    const dt = makeDataTransfer(makeItem("image/png"));
    const result = await handleImagePasteWithSettings(dt, "downloads");
    expect(result).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Downloads folder missing"),
    );
  });

  it("returns null when no image is in clipboard regardless of mode", async () => {
    const dt = makeDataTransfer(makeItem("text/plain", "string"));
    expect(await handleImagePasteWithSettings(dt, "downloads")).toBeNull();
  });
});

// ── expectedSavePath ──────────────────────────────────────────────────────────

describe("expectedSavePath", () => {
  it("returns a downloads path when target is 'downloads'", () => {
    const p = expectedSavePath("/vault/notes/doc.md", "img.png", "downloads");
    expect(p).toBe("~/Downloads/mdopener-paste/img.png");
  });

  it("downloads path is independent of docPath", () => {
    const p1 = expectedSavePath("/a/b/doc.md", "x.jpg", "downloads");
    const p2 = expectedSavePath(null, "x.jpg", "downloads");
    expect(p1).toBe(p2);
  });

  it("doc-relative path includes the doc's directory and assets/ subfolder", () => {
    const p = expectedSavePath("/vault/notes/doc.md", "img.png", "doc-relative");
    expect(p).toBe("/vault/notes/assets/img.png");
  });

  it("doc-relative path with nested doc directory", () => {
    const p = expectedSavePath("/vault/projects/2024/notes.md", "shot.webp", "doc-relative");
    expect(p).toBe("/vault/projects/2024/assets/shot.webp");
  });

  it("doc-relative fallback when docPath is null", () => {
    const p = expectedSavePath(null, "img.png", "doc-relative");
    expect(p).toBe("assets/img.png");
  });
});

// ── pasteImageFilename ────────────────────────────────────────────────────────

describe("pasteImageFilename", () => {
  it("generates a filename with the correct extension", () => {
    const name = pasteImageFilename("png", "TOKEN");
    expect(name).toBe("image-TOKEN.png");
  });

  it("uses the supplied token verbatim", () => {
    expect(pasteImageFilename("jpg", "ABCD1234")).toBe("image-ABCD1234.jpg");
  });

  it("generates a filename without a token (non-deterministic, sanity check)", () => {
    const name = pasteImageFilename("webp");
    expect(name).toMatch(/^image-.+\.webp$/);
  });

  it("two auto-generated filenames with no token are different", () => {
    // The random suffix should prevent collisions in practice.
    const a = pasteImageFilename("gif");
    const b = pasteImageFilename("gif");
    // Very unlikely to collide; if this flakes, the random suffix logic is broken.
    expect(a).not.toBe(b);
  });
});
