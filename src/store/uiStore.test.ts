import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./uiStore";

function reset() {
  useUiStore.setState({
    exportOpen: false,
    settingsOpen: false,
    commandPaletteOpen: false,
    activityOpen: false,
    outlineOpen: false,
    searchOpen: false,
    findOpen: false,
    zenMode: false,
  });
}

describe("uiStore", () => {
  beforeEach(reset);

  // ── Settings panel ──────────────────────────────────────────────────────

  it("openSettings / closeSettings toggle the settings panel", () => {
    expect(useUiStore.getState().settingsOpen).toBe(false);
    useUiStore.getState().openSettings();
    expect(useUiStore.getState().settingsOpen).toBe(true);
    useUiStore.getState().closeSettings();
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });

  // ── Find bar ────────────────────────────────────────────────────────────

  it("openFind / closeFind toggle the in-document find bar", () => {
    useUiStore.getState().openFind();
    expect(useUiStore.getState().findOpen).toBe(true);
    useUiStore.getState().closeFind();
    expect(useUiStore.getState().findOpen).toBe(false);
  });

  it("toggleFind flips the find bar open/closed", () => {
    useUiStore.getState().toggleFind();
    expect(useUiStore.getState().findOpen).toBe(true);
    useUiStore.getState().toggleFind();
    expect(useUiStore.getState().findOpen).toBe(false);
  });

  // ── Activity / Outline / Search mutual exclusion ────────────────────────

  it("openActivity closes outline and search", () => {
    useUiStore.setState({ outlineOpen: true, searchOpen: true });
    useUiStore.getState().openActivity();
    const s = useUiStore.getState();
    expect(s.activityOpen).toBe(true);
    expect(s.outlineOpen).toBe(false);
    expect(s.searchOpen).toBe(false);
  });

  it("openOutline closes activity and search", () => {
    useUiStore.setState({ activityOpen: true, searchOpen: true });
    useUiStore.getState().openOutline();
    const s = useUiStore.getState();
    expect(s.outlineOpen).toBe(true);
    expect(s.activityOpen).toBe(false);
    expect(s.searchOpen).toBe(false);
  });

  it("openSearch closes activity and outline", () => {
    useUiStore.setState({ activityOpen: true, outlineOpen: true });
    useUiStore.getState().openSearch();
    const s = useUiStore.getState();
    expect(s.searchOpen).toBe(true);
    expect(s.activityOpen).toBe(false);
    expect(s.outlineOpen).toBe(false);
  });

  it("toggleActivity closes sibling panels when opening", () => {
    useUiStore.setState({ outlineOpen: true });
    useUiStore.getState().toggleActivity();
    expect(useUiStore.getState().activityOpen).toBe(true);
    expect(useUiStore.getState().outlineOpen).toBe(false);
  });

  it("closeActivity closes only the activity panel", () => {
    useUiStore.setState({ activityOpen: true, outlineOpen: false });
    useUiStore.getState().closeActivity();
    expect(useUiStore.getState().activityOpen).toBe(false);
  });

  // ── Zen mode ────────────────────────────────────────────────────────────

  it("toggleZen flips distraction-free mode", () => {
    expect(useUiStore.getState().zenMode).toBe(false);
    useUiStore.getState().toggleZen();
    expect(useUiStore.getState().zenMode).toBe(true);
    useUiStore.getState().toggleZen();
    expect(useUiStore.getState().zenMode).toBe(false);
  });

  it("openZen / closeZen set zen mode unconditionally", () => {
    useUiStore.getState().openZen();
    expect(useUiStore.getState().zenMode).toBe(true);
    useUiStore.getState().closeZen();
    expect(useUiStore.getState().zenMode).toBe(false);
  });

  // ── Command palette ─────────────────────────────────────────────────────

  it("toggleCommandPalette flips the command palette", () => {
    useUiStore.getState().toggleCommandPalette();
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);
    useUiStore.getState().toggleCommandPalette();
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });
});
