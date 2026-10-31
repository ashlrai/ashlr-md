import { frontmatterText } from "../frontmatter";
import { atxHeadings } from "../outline";
import { taskMarks } from "../tasklist";
import { parseReview } from "./review-renderer";
import { parseRunbook } from "./runbook-renderer";
import { parseSpec } from "./spec-renderer";

const renderers = {
  plan: taskMarks,
  review: parseReview,
  spec: parseSpec,
  runbook: parseRunbook,
};

export interface KindDefinition {
  name: string;
  renderer: keyof typeof renderers;
  frontmatter: Record<string, string>;
  /** Custom H2 heading -> built-in section heading; source order is preserved. */
  sections: Record<string, string>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !/[\r\n]/.test(value);
}

function textMap(value: unknown): value is Record<string, string> {
  return (
    record(value) && Object.entries(value).every(([key, val]) => text(key) && text(val))
  );
}

/**
 * Load a JSON array, e.g. [{"name":"audit","renderer":"review",
 * "frontmatter":{"kind":"audit"},"sections":{"Verdict":"Summary"}}].
 * Pass the result as Renderer.kindRegistry, or call render(content) for parsed data.
 * All frontmatter entries must match exactly; the first matching kind wins.
 * Invalid JSON/schema rejects the entire registry. No match renders plain Markdown.
 * JSON supplies only data: renderer implementations are exclusively allowlisted here.
 */
export function loadKindRegistry(json: string) {
  let kinds: KindDefinition[] = [];
  try {
    const entries: unknown = JSON.parse(json);
    const names = new Set<string>();
    if (!Array.isArray(entries)) throw new Error("Expected an array");
    for (const entry of entries) {
      if (
        !record(entry) ||
        Object.keys(entry).length !== 4 ||
        !text(entry.name) ||
        names.has(entry.name) ||
        !text(entry.renderer) ||
        !Object.hasOwn(renderers, entry.renderer) ||
        !textMap(entry.frontmatter) ||
        Object.keys(entry.frontmatter).length === 0 ||
        !textMap(entry.sections)
      )
        throw new Error("Invalid kind definition");
      names.add(entry.name);
    }
    kinds = entries as KindDefinition[];
  } catch {
    // Fail atomically: a broken registration must not partially change rendering.
  }
  return {
    render(content: string) {
      const kind = kinds.find((entry) =>
        Object.entries(entry.frontmatter).every(
          ([key, value]) => frontmatterText(content, key) === value,
        ),
      );
      if (!kind) return { name: null, renderer: "plain" as const, content, data: null };
      if (kind.renderer === "plan") {
        // Task marks include character offsets, so parse their original source.
        return {
          name: kind.name,
          renderer: kind.renderer,
          content,
          data: taskMarks(content),
        };
      }
      const aliases = new Map(Object.entries(kind.sections));
      const lines = content.split("\n");
      for (const heading of atxHeadings(content)) {
        const canonical = aliases.get(heading.text);
        if (heading.depth === 2 && canonical)
          lines[heading.line - 1] = `## ${canonical}`;
      }
      // Normalize only parser input. Display/source text and write-back lines stay intact.
      return {
        name: kind.name,
        renderer: kind.renderer,
        content,
        data: renderers[kind.renderer](lines.join("\n")),
      };
    },
  };
}

export type KindRegistry = ReturnType<typeof loadKindRegistry>;
