/**
 * The Hosted AI section showed the first 6 characters of the saved token
 * followed by dots. It now says only whether a token is saved, as the
 * Anthropic key section does.
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

import { useAIStore } from "../../../store/aiStore";
import { AiProviderSection } from "./AiProviderSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "hZq7xWk9Rp2Lm4Vt8NyQ";

describe("Preferences: Hosted AI token", () => {
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
    useAIStore.setState({ hostedToken: null });
  });

  it("says a token is saved and shows none of it", async () => {
    useAIStore.setState({ hostedToken: TOKEN });
    await act(async () => root.render(createElement(AiProviderSection)));
    const text = host.textContent ?? "";
    expect(text).toContain("A token is saved.");
    for (let n = 4; n <= TOKEN.length; n++) {
      for (let i = 0; i + n <= TOKEN.length; i++) {
        expect(text).not.toContain(TOKEN.slice(i, i + n));
      }
    }
    expect(text).not.toContain("•");
    expect(
      host.querySelector('button[aria-label="Remove hosted AI token"]'),
    ).not.toBeNull();
  });

  it("offers to add a token when none is saved", async () => {
    useAIStore.setState({ hostedToken: null });
    await act(async () => root.render(createElement(AiProviderSection)));
    expect(host.textContent).not.toContain("A token is saved.");
    expect(
      host.querySelector('button[aria-label="Add hosted AI token"]'),
    ).not.toBeNull();
  });
});
