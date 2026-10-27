/**
 * Every Appearance control has an accessible name of its own. The row
 * captions in SettingsPanel were bare <label>s pointing at nothing (Biome
 * noLabelWithoutControl), so they named no control; the notifications switch
 * had no name but its long title. Part of #27.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useSettingsStore } from "../../../store/settingsStore";
import {
  ContentWidthStepper,
  FontSizeStepper,
  NotificationToggle,
  RemoteImagesToggle,
  ThemePicker,
} from "./AppearanceControls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Appearance controls have accessible names", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it.each([
    [ThemePicker, '[role="radiogroup"]', "Theme"],
    [FontSizeStepper, '[role="group"]', "Font size"],
    [ContentWidthStepper, '[role="group"]', "Content width"],
    [NotificationToggle, '[role="switch"]', "Agent notifications"],
    [RemoteImagesToggle, '[role="switch"]', "Load remote images"],
  ])("%o is named", (component, selector, name) => {
    act(() => root.render(createElement(component)));
    expect(host.querySelector(selector)?.getAttribute("aria-label")).toBe(name);
  });
});

describe("the theme radio group", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useSettingsStore.setState({ theme: "paper" });
    act(() => root.render(createElement(ThemePicker)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const radios = () => Array.from(host.querySelectorAll<HTMLElement>('[role="radio"]'));
  const press = (el: HTMLElement, key: string) =>
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });

  it("is one Tab stop, the chosen theme", () => {
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves to and chooses a theme with the arrow keys, wrapping", () => {
    radios()[0].focus();
    press(radios()[0], "ArrowRight");
    expect(useSettingsStore.getState().theme).toBe("sepia");
    expect(document.activeElement).toBe(radios()[1]);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    press(radios()[1], "ArrowDown");
    expect(useSettingsStore.getState().theme).toBe("midnight");
    press(radios()[2], "ArrowRight");
    expect(useSettingsStore.getState().theme).toBe("paper");
    press(radios()[0], "ArrowLeft");
    expect(useSettingsStore.getState().theme).toBe("midnight");
    press(radios()[2], "Home");
    expect(useSettingsStore.getState().theme).toBe("paper");
    expect(document.activeElement).toBe(radios()[0]);
  });
});
