// Shortcut labels in the UI come from formatShortcut, so they show ⌘ on
// macOS and Ctrl elsewhere and name the shortcut that really does the job.
// Tooltips and hints used to hard-code mac glyphs (Windows and Linux saw
// "⌘S to save"), and the AI sidebar's close button said ⌘K, the command
// palette's shortcut, instead of the AI assistant's.

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { AISidebar } from "./components/ai/AISidebar";
import { getCommands } from "./lib/commands";
import { formatShortcut } from "./lib/keymap";
import { useAIStore } from "./store/aiStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sources = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./test-setup.ts", "!./lib/keymap.ts"],
  { query: "?raw", import: "default", eager: true },
);

const GLYPH = /[⌘⌥⇧]/;

/** "file:line: text" for each string, template or JSX text with a mac glyph. */
function glyphStrings(file: string, src: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)) &&
      GLYPH.test(node.text)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${file}:${line + 1}: ${node.text.trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("shortcut labels", () => {
  it("no UI string hard-codes a mac modifier glyph", () => {
    expect(Object.keys(sources)).toContain("./components/layout/TitleBar.tsx");
    const found = Object.entries(sources).flatMap(([f, src]) => glyphStrings(f, src));
    expect(found).toEqual([]);
  });

  it("the AI sidebar's close button names the AI assistant's shortcut", async () => {
    const aiToggle = getCommands().find((c) => c.id === "ai.toggle");
    expect(aiToggle?.shortcut).toBe("mod+l");

    useAIStore.setState({ open: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(AISidebar)));
    const close = host.querySelector("button[aria-label='Close AI sidebar']");
    expect(close?.getAttribute("title")).toBe(
      `Close AI sidebar (${formatShortcut("mod+l")})`,
    );
    act(() => root.unmount());
    host.remove();
  });
});
