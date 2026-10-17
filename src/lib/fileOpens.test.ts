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

import { listenForOpenedFiles } from "./fileOpens";

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
