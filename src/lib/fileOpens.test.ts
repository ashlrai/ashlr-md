import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
let fileOpened: ((e: { payload: string[] }) => void) | undefined;
const unlistenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: string[] }) => void) => {
    fileOpened = cb;
    return unlistenMock;
  }),
}));

import { useDocumentStore } from "../store/documentStore";
import { listenForOpenedFiles, openOpenedFiles } from "./fileOpens";

/** Let the queued opens run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("listenForOpenedFiles", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    fileOpened = undefined;
  });

  it("opens a file that arrived after the mount drain but before the listener", async () => {
    const opened: string[] = [];
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "pending_files_listening" ? ["/late.md"] : null,
    );
    const unlisten = await listenForOpenedFiles(async (p) => {
      opened.push(p);
    });
    await settle();
    expect(invokeMock).toHaveBeenCalledWith("pending_files_listening");
    expect(opened).toEqual(["/late.md"]);
    expect(unlisten).toBe(unlistenMock);
  });

  it("does not open again a file the listener heard before the drain returned", async () => {
    const opened: string[] = [];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd !== "pending_files_listening") return null;
      fileOpened?.({ payload: ["/both.md"] });
      return ["/both.md"];
    });
    await listenForOpenedFiles(async (p) => {
      opened.push(p);
    });
    await settle();
    expect(opened).toEqual(["/both.md"]);
  });

  it("opens live files once the listener is registered", async () => {
    const opened: string[] = [];
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "pending_files_listening" ? [] : null,
    );
    await listenForOpenedFiles(async (p) => {
      opened.push(p);
    });
    fileOpened?.({ payload: ["/live.md"] });
    await settle();
    expect(opened).toEqual(["/live.md"]);
  });
});

describe("openOpenedFiles", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("opens every file of one event in order and takes each one's link requests", async () => {
    const opened: string[] = [];
    invokeMock.mockResolvedValue(null);
    await openOpenedFiles(["/a.md", "/b.md", "/c.md"], async (p) => {
      opened.push(p);
    });
    expect(opened).toEqual(["/a.md", "/b.md", "/c.md"]);
    for (const path of ["/a.md", "/b.md", "/c.md"]) {
      expect(invokeMock).toHaveBeenCalledWith("take_link_view_mode", { path });
      expect(invokeMock).toHaveBeenCalledWith("take_link_export", { path });
    }
  });

  it("applies a link's mode to its own file while it is active", async () => {
    useDocumentStore.setState({ path: null, viewMode: "read" });
    const modes: Record<string, string> = {};
    invokeMock.mockImplementation(async (cmd: string, args: { path: string }) =>
      cmd === "take_link_view_mode" && args.path === "/a.md" ? "edit" : null,
    );
    await openOpenedFiles(["/a.md", "/b.md"], async (p) => {
      if (p === "/b.md") modes["/a.md"] = useDocumentStore.getState().viewMode;
      useDocumentStore.setState({ path: p, viewMode: "read" });
    });
    expect(modes["/a.md"]).toBe("edit");
  });
});
