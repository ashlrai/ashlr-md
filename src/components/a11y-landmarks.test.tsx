import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const files = vi.hoisted(() =>
  ["a", "b"].map((name) => ({
    name: `${name}.md`,
    path: `/${name}.md`,
    dir: "/",
    mtimeMs: 0,
    size: 1,
  })),
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === "scan_markdown_files" ? { files, scanCut: false } : undefined,
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
const detection = vi.hoisted(() => ({ id: "test", cached: false }));
vi.mock("../ai/registry", () => {
  const provider = () => ({ id: detection.id, capabilities: { tier: 1 } });
  return {
    NOOP_PROVIDER_ID: "noop",
    getCachedProvider: () => (detection.cached ? provider() : null),
    detectProvider: vi.fn(async () => provider()),
  };
});
vi.mock("../lib/commands", () => ({
  COMMAND_GROUPS: ["Test"],
  getCommands: () =>
    ["First", "Second"].map((title) => ({
      id: title,
      title,
      group: "Test",
      run: vi.fn(),
    })),
}));
vi.mock("./ai/RelatedNotes", () => ({ RelatedNotes: () => null }));

import { useActivityStore } from "../store/activityStore";
import { useAIStore } from "../store/aiStore";
import { useDocumentStore } from "../store/documentStore";
import { useUiStore } from "../store/uiStore";
import { ActivityDrawer } from "./ActivityDrawer";
import { AISidebar } from "./ai/AISidebar";
import { CommandPalette } from "./CommandPalette";
import { TabBar } from "./layout/TabBar";
import { Outline } from "./Outline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  detection.id = "test";
  detection.cached = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({
    outlineOpen: false,
    activityOpen: false,
    commandPaletteOpen: false,
  });
  useDocumentStore.setState({
    path: "/a.md",
    content: "# First\n## Second",
    viewMode: "source",
    tabs: [],
    activeId: null,
  });
  useActivityStore.setState({
    watchedDir: null,
    files: [],
    lastError: null,
    unseen: [],
  });
  useAIStore.setState({
    open: false,
    messages: [],
    busy: false,
    provider: null,
    providerId: null,
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
// Native aside/ul semantics are intentional: these are landmarks and lists, not trees.
function byRole(role: string, name: string): HTMLElement {
  const native = role === "complementary" ? ",aside" : role === "list" ? ",ul" : "";
  const matches = [
    ...host.querySelectorAll<HTMLElement>(`[role="${role}"]${native}`),
  ].filter((el) => el.getAttribute("aria-label") === name && !el.closest("[inert]"));
  expect(matches).toHaveLength(1);
  return matches[0];
}
function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}
function traverse(list: HTMLElement, next: string, previous: string) {
  const buttons = [...list.querySelectorAll<HTMLButtonElement>("button")];
  act(() => buttons[0].focus());
  for (const [key, index] of [
    [next, 1],
    ["End", buttons.length - 1],
    [next, 0],
    [previous, buttons.length - 1],
    ["Home", 0],
  ] as const) {
    expect(press(document.activeElement as HTMLElement, key).defaultPrevented).toBe(
      true,
    );
    expect(document.activeElement).toBe(buttons[index]);
  }
  expect(press(buttons[0], next, { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(press(buttons[0], next, { isComposing: true }).defaultPrevented).toBe(false);
}
it("names the outline and navigates headings without activating them or capturing filter keys", () => {
  act(() => root.render(<Outline />));
  act(() => useUiStore.setState({ outlineOpen: true }));
  const panel = byRole("complementary", "Document outline");
  traverse(byRole("list", "Headings"), "ArrowDown", "ArrowUp");
  expect(useDocumentStore.getState().viewMode).toBe("source");
  const filter = panel.querySelector("input")!;
  expect(press(filter, "ArrowDown").defaultPrevented).toBe(false);
  act(() => useUiStore.setState({ outlineOpen: false }));
  expect(panel.hasAttribute("inert")).toBe(true);
});
it("names agent activity and navigates files without opening them", async () => {
  useActivityStore.setState({
    watchedDir: "/",
    files,
  });
  await act(async () => root.render(<ActivityDrawer />));
  act(() => useUiStore.setState({ activityOpen: true }));
  expect(byRole("complementary", "Agent Activity")).toBeDefined();
  traverse(byRole("list", "Recent file activity"), "ArrowDown", "ArrowUp");
  expect(useDocumentStore.getState().tabs).toHaveLength(0);
});
it("names the sidebar and gives its toolbar one Tab stop and horizontal arrow navigation", async () => {
  useAIStore.setState({ open: true });
  await act(async () => root.render(<AISidebar />));
  const sidebar = byRole("complementary", "AI assistant");
  const toolbar = byRole("toolbar", "Quick actions");
  traverse(toolbar, "ArrowRight", "ArrowLeft");
  expect(
    [...toolbar.querySelectorAll("button")].filter((b) => b.tabIndex === 0),
  ).toHaveLength(1);
  const input = sidebar.querySelector("textarea")!;
  expect(press(input, "ArrowLeft").defaultPrevented).toBe(false);
  expect(useAIStore.getState().messages).toHaveLength(0);
});
it.each([
  [false, false, "test", ".ai-input"],
  [true, true, "test", ".ai-stop-btn"],
  [true, false, "noop", ".ai-recheck-btn"],
] as const)("sidebar restores focus (cached=%s, busy=%s, provider=%s)", async (cached, busy, id, selector) => {
  detection.cached = cached;
  detection.id = id;
  await act(async () =>
    root.render(
      <>
        <button type="button">Trigger</button>
        <AISidebar />
      </>,
    ),
  );
  const trigger = host.querySelector("button")!;
  trigger.focus();
  await act(async () => useAIStore.setState({ open: true, busy }));
  const sidebar = byRole("complementary", "AI assistant");
  expect(document.activeElement).toBe(sidebar.querySelector(selector));
  act(() => useAIStore.setState({ open: false }));
  expect(document.activeElement).toBe(trigger);
  expect(sidebar.hasAttribute("inert")).toBe(true);
});
it("names the palette and moves accessible focus through options while retaining query focus", () => {
  useUiStore.setState({ commandPaletteOpen: true });
  act(() => root.render(<CommandPalette />));
  expect(byRole("dialog", "Command palette")).toBeDefined();
  const input = byRole("combobox", "Search commands");
  const options = byRole("listbox", "Commands").querySelectorAll('[role="option"]');
  for (const [key, index] of [
    ["ArrowDown", 1],
    ["ArrowDown", 0],
    ["ArrowUp", 1],
  ] as const) {
    press(input, key);
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-activedescendant")).toBe(options[index].id);
    expect(options[index].getAttribute("aria-selected")).toBe("true");
  }
});
it("names the document tabs and moves focus with automatic selection", () => {
  for (const fileName of ["First", "Second"]) {
    useDocumentStore
      .getState()
      .openRecovered({ path: `/${fileName}.md`, fileName, content: fileName });
  }
  act(() => root.render(<TabBar />));
  const tabs = byRole("tablist", "Open documents").querySelectorAll<HTMLElement>(
    '[role="tab"]',
  );
  tabs[0].focus();
  press(tabs[0], "ArrowRight");
  expect(document.activeElement).toBe(tabs[1]);
  expect(tabs[1].getAttribute("aria-selected")).toBe("true");
  press(tabs[1], "ArrowLeft");
  expect(document.activeElement).toBe(tabs[0]);
});
