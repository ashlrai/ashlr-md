// Doc facts: the agent-facing docs state counts and lists that come from code
// (MCP tools, prompts, resources, export formats, protocol revisions, mdopen
// flags). This test reads the Rust sources as text and fails, naming the doc
// line to fix, when a doc drifts. CI runs `bun run test`, not `cargo test`, so
// the Rust-side check in mdopener-mcp/tests/integration.rs does not gate PRs.

import { describe, expect, it } from "vitest";
import agentsDoc from "../docs/AGENTS.md?raw";
import installDoc from "../docs/INSTALL.md?raw";
import phantomDoc from "../docs/PHANTOM.md?raw";
import landingHtml from "../landing/index.html?raw";
import readme from "../README.md?raw";
import roadmap from "../ROADMAP.md?raw";
import mdopenIpc from "../src-tauri/bins/mdopen/src/ipc.rs?raw";
import mdopenMain from "../src-tauri/bins/mdopen/src/main.rs?raw";
import mcpLib from "../src-tauri/bins/mdopener-mcp/src/lib.rs?raw";
import sidecarPath from "../src-tauri/src/sidecar_path.rs?raw";
import tauriConf from "../src-tauri/tauri.conf.json?raw";
import markdownEditor from "./components/editor/MarkdownEditor.tsx?raw";
import commandsSrc from "./lib/commands.ts?raw";

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
const mdopenShortFlags = [...new Set(all(/"(-[a-zA-Z])"/g, mdopenCode))];
const mdopenHelp = mdopenCode.match(/const HELP: &str = "([^"]*)";/)?.[1] ?? "";

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

describe("doc facts: mdopen --help and docs/AGENTS.md", () => {
  const helpFlags = mdopenHelp.split("FLAGS:\n")[1]?.split("\n\n")[0] ?? "";
  const usage = agentsDoc.split("### Usage")[1]?.split("```")[1] ?? "";

  it("parses the help and the usage block", () => {
    expect(helpFlags, "mdopen's HELP has no FLAGS section").toContain("--edit");
    expect(usage, `${AGENTS} has no mdopen usage block`).toContain("mdopen");
    expect(mdopenShortFlags).toEqual(expect.arrayContaining(["-e", "-r", "-h", "-V"]));
  });

  it("help FLAGS lists every flag the CLI accepts, and only those", () => {
    // The flag column only: "--read, -r" before the description.
    const listed = helpFlags
      .split("\n")
      .flatMap((l) => (l.trim().split(/\s{2,}/)[0] ?? "").split(", "))
      .filter(Boolean);
    expect(sorted(listed)).toEqual(sorted([...mdopenLongFlags, ...mdopenShortFlags]));
  });

  it("the usage block names every short flag", () => {
    const at = where(AGENTS, agentsDoc, "### Usage");
    for (const f of mdopenShortFlags) {
      expect(usage, `name \`${f}\` in the mdopen usage block at ${at}`).toMatch(
        new RegExp(`\\(${f} also works`),
      );
    }
  });

  it("the usage block's comments line up", () => {
    const cols = usage
      .split("\n")
      .filter((l) => l.startsWith("mdopen") || l.startsWith("cat"))
      .map((l) => l.indexOf("#"));
    expect(new Set(cols).size, `align the comments in ${AGENTS}'s mdopen usage`).toBe(
      1,
    );
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

// ── Windows install folder ────────────────────────────────────────────────────
// The NSIS installer (the recommended Windows download) installs per user to
// $LOCALAPPDATA\<productName> unless bundle.windows.nsis.installMode says
// otherwise (Tauri v2's installer template). The docs once disagreed: two said
// %LOCALAPPDATA%\Programs\Ashlr MD\, a folder the installer never uses.

describe("doc facts: Windows install folder", () => {
  const conf = JSON.parse(tauriConf) as {
    productName: string;
    bundle?: { windows?: { nsis?: { installMode?: string } } };
  };
  const product = conf.productName;
  const docs: [string, string][] = [
    ["README.md", readme],
    [AGENTS, agentsDoc],
    ["docs/INSTALL.md", installDoc],
    ["docs/PHANTOM.md", phantomDoc],
  ];
  const LOCAL =
    /(%LOCALAPPDATA%|\$env:LOCALAPPDATA|AppData\\{1,2}Local)((?:\\{1,2}[^\\`"\n]+)+)/g;

  it("the NSIS installer installs per user", () => {
    expect(product).toBe("Ashlr MD");
    const mode = conf.bundle?.windows?.nsis?.installMode ?? "currentUser";
    expect(mode).toBe("currentUser");
  });

  it("every doc names %LOCALAPPDATA%\\<productName>", () => {
    let seen = 0;
    for (const [file, doc] of docs) {
      for (const m of doc.matchAll(LOCAL)) {
        seen++;
        const folder = m[2].split(/\\+/).filter(Boolean)[0];
        expect(folder, `${where(file, doc, m[0])}: ${m[0]}`).toBe(product);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(4);
  });

  it("the install guide says where the Windows CLI and MCP server are", () => {
    // The Linux section said where the .deb puts mdopen and that it is not on
    // PATH; the Windows section said nothing about either sidecar.
    const windows = installDoc.split("\n## Windows")[1]?.split("\n## ")[0] ?? "";
    for (const needle of [
      "`mdopen.exe`",
      "`mdopener-mcp.exe`",
      "Install mdopen",
      "`PATH`",
    ]) {
      expect(
        windows,
        `docs/INSTALL.md's Windows section must name ${needle}`,
      ).toContain(needle);
    }
  });

  it("the Settings placeholder in sidecar_path.rs uses the same folder", () => {
    expect(sidecarPath).toContain(`"{base}\\\\${product}\\\\{}"`);
  });
});

describe("doc facts: uninstalling", () => {
  it("the uninstall section names what an uninstall leaves behind", () => {
    // It listed only the preferences folder, so ~/.mdopener (the IPC token
    // and agents' conversation memory) and an AppImage's scheme handler,
    // which points at the deleted file, stayed behind unmentioned.
    const section = installDoc.split("\n## Uninstalling")[1] ?? "";
    for (const needle of [
      "`~/.mdopener/`",
      "`sessions/`",
      "md-opener-handler.desktop",
    ]) {
      expect(
        section,
        `docs/INSTALL.md's Uninstalling section must name ${needle}`,
      ).toContain(needle);
    }
  });
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
// The README's shortcut table and the landing page's shortcut grid list every
// registered shortcut (src/lib/commands.ts) plus the inline AI rewrite, which
// the WYSIWYG editor binds itself. Both used to miss ⌘⇧C and ⌘⇧T.

/** "mod+shift+t" (any modifier order) in one canonical order. */
function canonShortcut(s: string): string {
  const parts = s.toLowerCase().split("+");
  const key = parts.filter((p) => !["mod", "alt", "shift"].includes(p)).join("+");
  return ["mod", "alt", "shift"]
    .filter((m) => parts.includes(m))
    .concat(key)
    .join("+");
}

/** "⌘⌥F" as a canonical shortcut string ("mod+alt+f"). */
function fromGlyphs(g: string): string {
  const mods: string[] = [];
  let key = "";
  for (const ch of g) {
    if (ch === "⌘") mods.push("mod");
    else if (ch === "⌥") mods.push("alt");
    else if (ch === "⇧") mods.push("shift");
    else key += ch.toLowerCase();
  }
  return canonShortcut([...mods, key].join("+"));
}

const registryShortcuts = [
  ...commandsSrc.matchAll(/shortcut: ("(?:[^"\\]|\\.)*")/g),
].map((m) => canonShortcut(JSON.parse(m[1]) as string));
const EDITOR_SHORTCUTS = ["mod+i"];
const documentedShortcuts = sorted([
  ...new Set([...registryShortcuts, ...EDITOR_SHORTCUTS]),
]);

describe("doc facts: keyboard shortcuts", () => {
  it("parses the registry and the editor's own binding", () => {
    expect(registryShortcuts.length).toBeGreaterThan(15);
    expect(registryShortcuts).toContain("mod+\\");
    // MarkdownEditor binds mod+I itself, outside the registry.
    expect(markdownEditor).toMatch(/e\.key === "i"/);
  });

  it("README's table lists exactly the real shortcuts", () => {
    const section = readme.slice(readme.indexOf("## Keyboard shortcuts"));
    const table = section.slice(0, section.indexOf("\n## ", 1));
    const listed = table
      .split("\n")
      .filter((l) => l.startsWith("| ") && l.includes("`"))
      .flatMap((l) => all(/`([^`]+)`/g, l.split("|")[2] ?? ""))
      .map(fromGlyphs);
    expect(sorted([...new Set(listed)]), "fix README.md's shortcut table").toEqual(
      documentedShortcuts,
    );
  });

  it("the landing page's grid lists exactly the real shortcuts", () => {
    const at = landingHtml.indexOf('<section id="shortcuts">');
    expect(at, "landing/index.html has no #shortcuts section").toBeGreaterThan(-1);
    const section = landingHtml.slice(at, landingHtml.indexOf("</section>", at));
    const listed = all(/<kbd[^>]*>([^<]*)<\/kbd>/g, section)
      .flatMap((k) => k.trim().split(/\s+/))
      .map(fromGlyphs);
    expect(
      sorted([...new Set(listed)]),
      "fix the shortcut grid in landing/index.html",
    ).toEqual(documentedShortcuts);
  });
});
