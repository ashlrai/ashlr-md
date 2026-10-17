// Doc facts: the agent-facing docs state counts and lists that come from code
// (MCP tools, prompts, resources, export formats, protocol revisions, mdopen
// flags). This test reads the Rust sources as text and fails, naming the doc
// line to fix, when a doc drifts. CI runs `bun run test`, not `cargo test`, so
// the Rust-side check in mdopener-mcp/tests/integration.rs does not gate PRs.

import { describe, expect, it } from "vitest";
import agentsDoc from "../docs/AGENTS.md?raw";
import phantomDoc from "../docs/PHANTOM.md?raw";
import roadmap from "../ROADMAP.md?raw";
import mdopenIpc from "../src-tauri/bins/mdopen/src/ipc.rs?raw";
import mdopenMain from "../src-tauri/bins/mdopen/src/main.rs?raw";
import mcpLib from "../src-tauri/bins/mdopener-mcp/src/lib.rs?raw";

const AGENTS = "docs/AGENTS.md";
const ROADMAP = "ROADMAP.md";

/** "docs/AGENTS.md:210" for the first line containing `needle`. */
function where(file: string, doc: string, needle: string | RegExp): string {
  const lines = doc.split("\n");
  const i = lines.findIndex((l) =>
    typeof needle === "string" ? l.includes(needle) : needle.test(l),
  );
  return i < 0 ? `${file} (no line matches ${String(needle)})` : `${file}:${i + 1}`;
}

/** The body of the Rust item starting at `start`, up to the next top-level `}`. */
function rustBody(src: string, start: string): string {
  const at = src.indexOf(start);
  if (at < 0) throw new Error(`mdopener-mcp lib.rs no longer contains ${start}`);
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end < 0 ? undefined : end);
}

function all(re: RegExp, text: string): string[] {
  return [...text.matchAll(re)].map((m) => m[1]);
}

function strArrayConst(name: string): string[] {
  const m = mcpLib.match(
    new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`),
  );
  if (!m) throw new Error(`mdopener-mcp lib.rs no longer defines ${name}`);
  return all(/"([^"]+)"/g, m[1]);
}

const sorted = (xs: string[]) => [...xs].sort();

// ── Source of truth ───────────────────────────────────────────────────────────

const tools = all(
  /ToolDef \{\s*name: "([a-z_]+)"/g,
  rustBody(mcpLib, "pub fn tool_registry()"),
);
const prompts = all(
  /\{ "name": "([a-z_]+)"/g,
  rustBody(mcpLib, "pub fn prompts_list()"),
);
const resources = all(
  /"uri": "([^"]+)"/g,
  rustBody(mcpLib, "pub fn handle_resources_list("),
);
const exportFormats = strArrayConst("EXPORT_FORMATS");
const protocols = strArrayConst("SUPPORTED_PROTOCOLS");
const defaultProtocol = mcpLib.match(
  /pub const DEFAULT_PROTOCOL: &str = "([^"]+)"/,
)?.[1];
const mdopenCode = mdopenMain.split("#[cfg(test)]")[0];
const mdopenLongFlags = [...new Set(all(/"(--[a-z]+)"/g, mdopenCode))];

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

describe("doc facts: source of truth parses", () => {
  it("finds the registries in the Rust sources", () => {
    expect(tools.length).toBeGreaterThan(10);
    expect(prompts.length).toBeGreaterThan(0);
    expect(resources.length).toBeGreaterThan(0);
    expect(exportFormats.length).toBeGreaterThan(0);
    expect(protocols).toContain(defaultProtocol);
    expect(mdopenLongFlags).toEqual(
      expect.arrayContaining(["--edit", "--read", "--hook", "--help", "--version"]),
    );
  });
});

describe(`doc facts: ${AGENTS}`, () => {
  it("states the real MCP tool count", () => {
    const m = agentsDoc.match(/exposes \*\*(\d+)\*\* tools/);
    expect(m, `${AGENTS}: missing "exposes **N** tools"`).not.toBeNull();
    expect(
      Number(m?.[1]),
      `fix the tool count at ${where(AGENTS, agentsDoc, "exposes **")}`,
    ).toBe(tools.length);
  });

  it("tool table lists exactly the registered tools", () => {
    const section = agentsDoc.slice(agentsDoc.indexOf("## MCP tool reference"));
    const table = section.slice(
      0,
      section.indexOf("\n\n", section.indexOf("| Tool |")),
    );
    const rows = all(/^\| `([a-z_]+)` \|/gm, table);
    for (const t of tools) {
      expect(
        rows,
        `add a \`${t}\` row to the tool table near ${where(AGENTS, agentsDoc, "| Tool |")}`,
      ).toContain(t);
    }
    for (const r of rows) {
      expect(
        tools,
        `remove the \`${r}\` row at ${where(AGENTS, agentsDoc, `| \`${r}\` |`)}: not a registered tool`,
      ).toContain(r);
    }
  });

  it("export row lists the real formats", () => {
    const row = agentsDoc.split("\n").find((l) => l.startsWith("| `export` |")) ?? "";
    const listed = all(/"([a-z]+)"/g, row.match(/`format: ([^`]*)`/)?.[1] ?? "");
    expect(
      sorted(listed),
      `fix the format list at ${where(AGENTS, agentsDoc, "| `export` |")}`,
    ).toEqual(sorted(exportFormats));
  });

  it("names the supported protocol revisions and the default", () => {
    const at = where(AGENTS, agentsDoc, "protocol revisions");
    expect(agentsDoc, `fix the revision count at ${at}`).toContain(
      `one of ${NUMBER_WORDS[protocols.length]} protocol revisions`,
    );
    for (const p of protocols) {
      expect(agentsDoc, `add **\`${p}\`** near ${at}`).toContain(`**\`${p}\`**`);
    }
    expect(agentsDoc, `mark the default near ${at}`).toContain(
      `**\`${defaultProtocol}\`** (default)`,
    );
  });

  it("resources reference lists every advertised resource", () => {
    const at = where(AGENTS, agentsDoc, "## Resources reference");
    for (const uri of resources) {
      expect(
        agentsDoc,
        `add **\`${uri}…\`** to the resources reference at ${at}`,
      ).toContain(`**\`${uri}`);
    }
  });

  it("prompts table lists exactly the served prompts", () => {
    const section = agentsDoc.slice(agentsDoc.indexOf("## Prompts reference"));
    const table = section.slice(
      0,
      section.indexOf("\n\n", section.indexOf("| Prompt |")),
    );
    const rows = all(/^\| `([a-z_]+)` \|/gm, table);
    expect(
      sorted(rows),
      `fix the prompts table at ${where(AGENTS, agentsDoc, "| Prompt |")}`,
    ).toEqual(sorted(prompts));
  });

  it("mdopen usage shows every long flag the CLI accepts", () => {
    const at = where(AGENTS, agentsDoc, "### Usage");
    for (const f of mdopenLongFlags) {
      expect(
        agentsDoc,
        `add \`mdopen ${f}\` to the mdopen usage block at ${at}`,
      ).toMatch(new RegExp(`^mdopen (?:.* )?${f}(?: |$)`, "m"));
    }
  });
});

describe("doc facts: mdopen exit status", () => {
  // How long mdopen waits for the running app's answer before it exits 1
  // without trying the URL scheme. docs/PHANTOM.md's exit table, which
  // Phantom reads, used to leave that case out.
  const m = mdopenIpc.match(
    /const IO_TIMEOUT: Duration = Duration::from_secs\((\d+)\);/,
  );
  const secs = m?.[1];

  it("finds the IPC answer timeout in mdopen's ipc.rs", () => {
    expect(secs, "mdopen ipc.rs no longer defines IO_TIMEOUT in seconds").toBeDefined();
  });

  it("help and docs state the timeout after which mdopen exits 1", () => {
    // HELP and docs wrap their lines, so whitespace may split the words.
    expect(mdopenMain, "fix the EXIT STATUS in mdopen's HELP").toMatch(
      new RegExp(`did not\\s+answer within ${secs}s`),
    );
    for (const [file, doc] of [
      [AGENTS, agentsDoc],
      ["docs/PHANTOM.md", phantomDoc],
    ] as const) {
      expect(
        doc,
        `say mdopen exits 1 after ${secs} s without an answer in ${file}`,
      ).toMatch(new RegExp(`did not\\s+answer\\s+within\\s+${secs} s`));
    }
  });
});

describe(`doc facts: ${ROADMAP}`, () => {
  const line = roadmap.split("\n").find((l) => l.includes("A real MCP server")) ?? "";
  const at = where(ROADMAP, roadmap, "A real MCP server");

  it("MCP server line states the real tool count and names real tools", () => {
    const m = line.match(/(\d+) tools including (.*)$/);
    expect(m, `${at}: missing "N tools including ..."`).not.toBeNull();
    expect(Number(m?.[1]), `fix the tool count at ${at}`).toBe(tools.length);
    for (const t of all(/`([a-z_]+)`/g, m?.[2] ?? "")) {
      expect(tools, `\`${t}\` at ${at} is not a registered tool`).toContain(t);
    }
  });

  it("MCP server line lists the real prompts", () => {
    const m = line.match(/\*\*prompts\*\* \(([^)]*)\)/);
    expect(m, `${at}: missing "**prompts** (...)"`).not.toBeNull();
    expect(
      sorted(all(/`([a-z_]+)`/g, m?.[1] ?? "")),
      `fix the prompt list at ${at}`,
    ).toEqual(sorted(prompts));
  });
});
