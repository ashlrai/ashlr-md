/**
 * An `![[note]]` embed read its note once and never again: the wikilink
 * cache was dropped when a file changed on disk, but the embed did not
 * listen, so an embed of a note deleted or rewritten since kept its old
 * text. It now resolves and reads the note again.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let planText: string | null = "# Plan\n\nFirst draft.\n";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { invalidateWikilinkCache } from "../../lib/wikilink";
import { useDocumentStore } from "../../store/documentStore";
import { useSettingsStore } from "../../store/settingsStore";
import { WikiEmbed } from "./WikiEmbed";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class {
  observe() {}
  disconnect() {}
  unobserve() {}
};

describe("an embed of a note changed or deleted since it was read", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    planText = "# Plan\n\nFirst draft.\n";
    invalidateWikilinkCache();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "resolve_wikilink") return planText === null ? null : "/v/plan.md";
      if (cmd === "read_markdown_file") {
        if (planText === null) throw "Could not read /v/plan.md: gone";
        return { path: "/v/plan.md", file_name: "plan.md", content: planText, size: 1 };
      }
      return undefined;
    });
    useSettingsStore.setState({ vaultRoot: "/v" });
    useDocumentStore.setState({ path: "/v/a.md" });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(WikiEmbed, { target: "plan" })));
    await vi.waitFor(() => expect(host.textContent).toContain("First draft."));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows the note's new text after it changes on disk", async () => {
    planText = "# Plan\n\nSecond draft.\n";
    await act(async () => invalidateWikilinkCache());
    await vi.waitFor(() => expect(host.textContent).toContain("Second draft."));
    expect(host.textContent).not.toContain("First draft.");
  });

  it("shows as missing once the note is deleted", async () => {
    planText = null;
    await act(async () => invalidateWikilinkCache());
    await vi.waitFor(() => expect(host.textContent).toContain("Can't embed “plan”"));
    expect(host.textContent).not.toContain("First draft.");
  });
});
