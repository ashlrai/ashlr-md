/**
 * The AI sidebar's retry toast and its buttons (Retry, Open Preferences,
 * the Add credit link, dismiss) had no CSS, so they rendered as bare
 * browser controls. Every class they use now has a rule, and the editors'
 * Add credit link loses its underline like their buttons.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

describe("retry toast styles", () => {
  it("styles every class the sidebar's retry toast uses", () => {
    const tsx = read("AISidebar.tsx");
    const css = read("../../styles/ai.css");
    const classes = new Set(
      [...tsx.matchAll(/className="(ai-retry[\w-]*)"/g)].map((m) => m[1]),
    );
    expect([...classes].sort()).toEqual([
      "ai-retry-btn",
      "ai-retry-dismiss",
      "ai-retry-toast",
      "ai-retry-toast__msg",
    ]);
    for (const c of classes) expect(css, c).toMatch(new RegExp(`\\.${c}\\s*\\{`));
    expect(css).toMatch(/:root\[data-theme="midnight"\] \.ai-retry-toast/);
  });

  it("styles the editors' Add credit link like their buttons", () => {
    expect(read("../../styles/editor.css")).toMatch(
      /a\.inline-ai-retry\s*\{[^}]*text-decoration:\s*none/,
    );
  });
});
