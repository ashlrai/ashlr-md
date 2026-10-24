/**
 * A link to a file that is not there. The click read the file, and its
 * error replaced the document holding the link: the read view showed only
 * "Could not read …" until another tab was chosen, and with one tab open the
 * document could not be got back. It now stays in view and a toast says why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import type { MouseEvent } from "react";
import { useDocumentStore } from "../../store/documentStore";
import { useToastStore } from "../../store/toastStore";
import { followLink } from "./Renderer";

const MISSING = "Could not read /notes/gone.md: No such file or directory (os error 2)";

function click() {
  const a = document.createElement("a");
  document.body.appendChild(a);
  return {
    preventDefault: vi.fn(),
    currentTarget: a,
  } as unknown as MouseEvent<HTMLAnchorElement>;
}

describe("a link to a missing file", () => {
  beforeEach(async () => {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd !== "read_markdown_file") return Promise.resolve();
      if (args?.path === "/notes/a.md") {
        return Promise.resolve({
          path: "/notes/a.md",
          file_name: "a.md",
          content: "# A\n\n[gone](gone.md)\n",
          size: 20,
        });
      }
      return Promise.reject(MISSING);
    });
    useToastStore.setState({ toasts: [] });
    await useDocumentStore.getState().openPath("/notes/a.md");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    for (const t of useDocumentStore.getState().tabs) {
      useDocumentStore.getState().closeTab(t.id);
    }
  });

  it("keeps the document in view and says why in a toast", async () => {
    const e = click();
    followLink(e, "gone.md", "/notes/a.md");
    expect(e.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));
    const s = useDocumentStore.getState();
    expect(s.error).toBeNull();
    expect(s.isLoading).toBe(false);
    expect(s.path).toBe("/notes/a.md");
    expect(s.content).toContain("[gone](gone.md)");
    const t = useToastStore.getState().toasts[0];
    expect(t.kind).toBe("error");
    expect(t.message).toBe(`Could not open the link to gone.md: ${MISSING}`);
  });

  it("still shows a read error in place when nothing asks to keep the view", async () => {
    const error = await useDocumentStore.getState().openPath("/notes/gone.md");
    expect(error).toBe(MISSING);
    expect(useDocumentStore.getState().error).toBe(MISSING);
  });
});
