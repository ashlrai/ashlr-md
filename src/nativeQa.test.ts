import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { Renderer } from "./components/viewer/Renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = readFileSync("scripts/native-qa.py", "utf8");
const script = source.match(/DOM_SCRIPT = r"""\n([\s\S]*?)\n"""/)?.[1];
if (!script) throw new Error("Missing actual native probe DOM script");
const observe = new Function(script) as () => { heading?: string; text?: string };
const heading = "Ashlr native qualification 721b976";
const text = "Native WebView Unicode: café 日本語.";

it("reads actual renderer content without its copy-link control or changing DOM", async () => {
  const host = document.createElement("article");
  host.className = "reading-surface";
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(createElement(Renderer, { content: `# ${heading}\n\n${text}\n` })),
    );
    expect(host.querySelector("h1")?.textContent).toBe(`${heading}#`);
    expect(observe()).toEqual({ heading, text });
    expect(host.querySelector("button.heading-anchor")?.textContent).toBe("#");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("does not accept welcome text, outside paragraphs, or wrong fixture content", () => {
  const host = document.createElement("div");
  document.body.append(host);
  try {
    host.innerHTML = `<h1>${heading}</h1><p>${text}</p>`;
    expect(observe()).toEqual({ heading: undefined, text: undefined });
    host.innerHTML +=
      '<article class="reading-surface"><h1>Wrong<button class="heading-anchor">#</button></h1><p>Wrong</p></article>';
    expect(observe()).toEqual({ heading: "Wrong", text: undefined });
    host.querySelector("article h1")?.prepend("#");
    expect(observe().heading).toBe("#Wrong");
    host.querySelector("article")!.innerHTML =
      `<h1>${heading}<button class="heading-anchor">#</button></h1><p>${text} </p>`;
    expect(observe()).toEqual({ heading, text: undefined });
  } finally {
    host.remove();
  }
});
