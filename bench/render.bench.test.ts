import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useDocumentStore } from "../src/store/documentStore";
import { IncrementalMarkdown } from "../src/render/incremental";
import { largeDocument } from "./document";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { Renderer } from "../src/components/viewer/Renderer";

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
    p95: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

it("parses edits to a 10k-line document below 100 ms at p95", () => {
  const source = largeDocument();
  expect(source.split("\n")).toHaveLength(10000);
  const engine = new IncrementalMarkdown();
  const start = performance.now();
  engine.render(source);
  const cold = performance.now() - start;
  const samples: number[] = [];
  for (let n = 0; n < 35; n++) {
    const index = (n * 137) % 500;
    const content = source.replace(`Paragraph ${index} with`, `Updated ${index} with`);
    const start = performance.now();
    engine.render(content);
    const elapsed = performance.now() - start;
    expect(engine.stats.parsedChunks).toBeLessThanOrEqual(4);
    if (n >= 5) samples.push(elapsed);
  }
  const result = summary(samples);
  console.log(
    JSON.stringify(
      {
        stage: "parse + React elements",
        lines: 10000,
        bytes: new TextEncoder().encode(source).length,
        samples: samples.length,
        coldMs: Number(cold.toFixed(2)),
        incrementalMs: result,
      },
      null,
      2,
    ),
  );
  expect(result.p95).toBeLessThan(100);
});

it("renders local edits to a 10k-line document below 100 ms at p95", async () => {
  const source = largeDocument();
  expect(source.split("\n")).toHaveLength(10000);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  // Match the app's store-driven parent so one edit is one React update.
  function DocumentView() {
    const content = useDocumentStore((state) => state.content);
    return createElement(Renderer, { content });
  }
  let mounted = false;
  const render = async (content: string) => {
    const start = performance.now();
    flushSync(() => {
      useDocumentStore.setState({ content });
      if (!mounted) {
        root.render(createElement(DocumentView));
        mounted = true;
      }
    });
    await Promise.resolve();
    return performance.now() - start;
  };
  try {
    const cold = await render(source);
    console.log("cold Renderer DOM ms", cold);
    const samples: number[] = [];
    // Every iteration changes content at a different document location.
    for (let n = 0; n < 35; n++) {
      const index = (n * 137) % 500;
      const content = source.replace(
        `Paragraph ${index} with`,
        `Updated ${index} with`,
      );
      const elapsed = await render(content);
      expect(host.querySelectorAll("h2")).toHaveLength(500);
      expect(
        host.querySelector<HTMLInputElement>("input.task-checkbox")?.disabled,
      ).toBe(false);
      expect(host.textContent).toContain(`Updated ${index} with`);
      if (n >= 5) samples.push(elapsed);
    }
    const result = summary(samples);
    console.log(
      JSON.stringify(
        {
          stage: "Renderer + DOM commit",
          lines: 10000,
          samples: samples.length,
          coldMs: Number(cold.toFixed(2)),
          incrementalMs: result,
        },
        null,
        2,
      ),
    );
    expect(result.p95).toBeLessThan(100);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});
