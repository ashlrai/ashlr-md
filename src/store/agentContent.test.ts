import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { useDocumentStore } from "./documentStore";

it("publishes external text and its active-tab refresh signal atomically, ignoring no-ops", () => {
  useDocumentStore.setState({ tabs: [], activeId: null, path: null, reloadNonce: 0 });
  useDocumentStore
    .getState()
    .openRecovered({ path: "/a.md", fileName: "a.md", content: "a" });
  const inactive = useDocumentStore.getState().tabs[0];
  useDocumentStore
    .getState()
    .openRecovered({ path: "/b.md", fileName: "b.md", content: "b" });
  const before = useDocumentStore.getState();
  const observe = vi.fn();
  const unsubscribe = useDocumentStore.subscribe(observe);
  try {
    before.replaceContent("b");
    expect(observe).not.toHaveBeenCalled();
    before.replaceContent("agent");
    expect(observe).toHaveBeenCalledTimes(1);
    const after = useDocumentStore.getState();
    expect(after).toMatchObject({
      content: "agent",
      isDirty: true,
      reloadNonce: before.reloadNonce + 1,
    });
    expect(after.tabs.find((tab) => tab.id === after.activeId)).toMatchObject({
      content: "agent",
      isDirty: true,
      reloadNonce: after.reloadNonce,
    });
    expect(after.tabs.find((tab) => tab.id === inactive.id)).toEqual(inactive);
    expect(after.diskContent).toBe(before.diskContent);
  } finally {
    unsubscribe();
  }
});
