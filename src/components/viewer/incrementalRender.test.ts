import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useDocumentStore } from "../../store/documentStore";
import { Renderer } from "./Renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("updates classification and task counts after cached prose edits", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const prose = "Ordinary prose with **formatting**.\n\n".repeat(80);
  let content = `# Plan\n\n${prose}- [ ] one\n- [ ] two\n`;
  const render = async () => {
    await act(async () => {
      useDocumentStore.setState({ content });
      root.render(createElement(Renderer, { content }));
    });
  };
  try {
    await render();
    const paragraph = host.querySelector("p");
    const checkbox = host.querySelector("input.task-checkbox");
    content = content.replace("Ordinary prose", "Edited prose");
    await render();
    expect(host.querySelector("p")).toBe(paragraph);
    expect(host.querySelector("input.task-checkbox")).toBe(checkbox);
    expect(host.querySelector(".markdown-body")?.getAttribute("data-doc-kind")).toBe(
      "plan",
    );
    expect(host.querySelector(".doc-kind-badge-progress")?.textContent).toBe("0/2");
    content = content.replace("- [ ] one", "- [x] one");
    await render();
    expect(host.querySelector(".doc-kind-badge-progress")?.textContent).toBe("1/2");
    content = content.replace("# Plan", "Plain title");
    await render();
    expect(host.querySelector(".markdown-body")?.getAttribute("data-doc-kind")).toBe(
      "generic",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it("detects new review findings and updates existing severities after word edits", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  let content = `${"Ordinary prose.\n\n".repeat(80)}High: first finding\n\nOrdinary: second finding\n`;
  const render = async () => {
    await act(async () => root.render(createElement(Renderer, { content })));
  };
  try {
    await render();
    expect(host.querySelector(".review-card")).toBeNull();
    content = content.replace("Ordinary prose", "Changed prose");
    await render();
    expect(host.querySelector(".review-card")).toBeNull();
    content = content.replace("Ordinary: second", "Low: second");
    await render();
    expect(host.querySelector(".review-card__total")?.textContent).toBe("2 findings");
    expect(host.querySelector('.review-badge[data-severity="low"]')).not.toBeNull();
    content = content.replace("Low: second", "Critical: second");
    await render();
    expect(host.querySelector('.review-badge[data-severity="low"]')).toBeNull();
    expect(
      host.querySelector('.review-badge[data-severity="critical"]'),
    ).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
