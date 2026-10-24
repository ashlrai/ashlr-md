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
