import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useDocumentStore } from "../store/documentStore";
import { useSessionStore } from "../store/sessionStore";
import { restoreSession } from "./session";

/** A disk of readable `files`; `unreadable` exist but fail to read. */
function disk(files: Record<string, string>, unreadable: string[] = []) {
  invokeMock.mockImplementation(
    (cmd: string, args?: { path?: string; paths?: string[] }) => {
      if (cmd === "filter_existing") {
        return Promise.resolve(
          (args?.paths ?? []).filter((p) => p in files || unreadable.includes(p)),
        );
      }
      if (cmd === "read_markdown_file") {
        const p = args?.path ?? "";
        if (!(p in files))
          return Promise.reject("Could not read: not valid UTF-8 text");
        return Promise.resolve({
          path: p,
          file_name: p.split("/").pop(),
          content: files[p],
          size: files[p].length,
          version: "v",
          canonical_path: p,
        });
      }
      return Promise.resolve();
    },
  );
}

describe("restoreSession", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useDocumentStore.setState({ tabs: [], activeId: null, path: null, error: null });
    useSessionStore.getState().clear();
  });

  it("skips a file it cannot open, without changing another tab", async () => {
    // The failed file's view mode was applied to the tab active before it,
    // it counted as reopened, and its error covered the restored document.
    disk({ "/v/a.md": "A" }, ["/v/bad.md"]);
    useSessionStore.getState().save(
      [
        { path: "/v/a.md", viewMode: "source" },
        { path: "/v/bad.md", viewMode: "edit" },
      ],
      "/v/a.md",
    );
    expect(await restoreSession()).toBe(1);
    const s = useDocumentStore.getState();
    expect(s.tabs.map((t) => t.path)).toEqual(["/v/a.md"]);
    expect(s.viewMode).toBe("source");
    expect(s.tabs[0].viewMode).toBe("source");
    expect(s.error).toBeNull();
  });

  it("reads a damaged session safely: bad entries dropped, unknown view modes read", async () => {
    disk({ "/v/a.md": "A", "/v/b.md": "B" });
    useSessionStore.setState({
      savedTabs: [
        { path: "/v/a.md", viewMode: "split" },
        null,
        { path: 7 },
        { path: "/v/a.md", viewMode: "edit" },
        { path: "/v/b.md", viewMode: "edit" },
      ] as never,
      activePath: 3 as never,
    });
    expect(await restoreSession()).toBe(2);
    const s = useDocumentStore.getState();
    expect(s.tabs.map((t) => [t.path, t.viewMode])).toEqual([
      ["/v/a.md", "read"],
      ["/v/b.md", "edit"],
    ]);

    useSessionStore.setState({ savedTabs: { not: "a list" } as never });
    await expect(restoreSession()).resolves.toBe(0);
  });
});
