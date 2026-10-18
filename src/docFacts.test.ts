// Doc facts: the agent-facing docs state counts and lists that come from code
// (MCP tools, prompts, resources, export formats, protocol revisions, mdopen
// flags). This test reads the Rust sources as text and fails, naming the doc
// line to fix, when a doc drifts. CI runs `bun run test`, not `cargo test`, so
// the Rust-side check in mdopener-mcp/tests/integration.rs does not gate PRs.

import { describe, expect, it } from "vitest";
import releaseWorkflow from "../.github/workflows/release.yml?raw";
import agentsDoc from "../docs/AGENTS.md?raw";
import installDoc from "../docs/INSTALL.md?raw";
import phantomDoc from "../docs/PHANTOM.md?raw";
import releasingDoc from "../docs/RELEASING.md?raw";
import obsidianReadme from "../integrations/obsidian/README.md?raw";
import vscodeReadme from "../integrations/vscode/README.md?raw";
import landingHtml from "../landing/index.html?raw";
import readme from "../README.md?raw";
import roadmap from "../ROADMAP.md?raw";
import mdopenIpc from "../src-tauri/bins/mdopen/src/ipc.rs?raw";
import mdopenMain from "../src-tauri/bins/mdopen/src/main.rs?raw";
import mcpLib from "../src-tauri/bins/mdopener-mcp/src/lib.rs?raw";
import agentSetup from "../src-tauri/src/agent_setup.rs?raw";
import sidecarPath from "../src-tauri/src/sidecar_path.rs?raw";
import tauriConf from "../src-tauri/tauri.conf.json?raw";
import linuxConf from "../src-tauri/tauri.linux.conf.json?raw";
import markdownEditor from "./components/editor/MarkdownEditor.tsx?raw";
import mcpSection from "./components/settings/sections/McpSection.tsx?raw";
import commandsSrc from "./lib/commands.ts?raw";
import mcpEditHandlers from "./mcp/handlers/edit.ts?raw";

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

  it("tool table rows are in tools/list order", () => {
    const section = agentsDoc.slice(agentsDoc.indexOf("## MCP tool reference"));
    const table = section.slice(
      0,
      section.indexOf("\n\n", section.indexOf("| Tool |")),
    );
    expect(
      all(/^\| `([a-z_]+)` \|/gm, table),
      `put the tool table near ${where(AGENTS, agentsDoc, "| Tool |")} in tool_registry() order`,
    ).toEqual(tools);
  });

  it("lists the destructive tools last in tools/list", () => {
    const registry = rustBody(mcpLib, "pub fn tool_registry()");
    const tiers = all(/tier: ToolTier::([A-Za-z]+)/g, registry);
    expect(tiers.length).toBe(tools.length);
    const first = tiers.indexOf("Destructive");
    expect(first).toBeGreaterThan(0);
    expect(
      tiers.slice(first).every((t) => t === "Destructive"),
      `tool_registry() lists ${tools[tiers.findIndex((t, i) => i > first && t !== "Destructive")]} after a destructive tool`,
    ).toBe(true);
    expect(tools.indexOf("edit_document")).toBeLessThan(tools.indexOf("set_content"));
  });

  it("edit rows quote the app's no-document-open refusal", () => {
    const msg = mcpEditHandlers.match(/const NO_DOCUMENT_OPEN = "([^"]+)"/)?.[1];
    expect(
      msg,
      "src/mcp/handlers/edit.ts no longer defines NO_DOCUMENT_OPEN",
    ).toBeTruthy();
    for (const tool of [
      "set_content",
      "edit_document",
      "stream_edit",
      "stream_edit_apply",
    ]) {
      const row =
        agentsDoc.split("\n").find((l) => l.startsWith(`| \`${tool}\` |`)) ?? "";
      expect(
        row,
        `quote "${msg}" at ${where(AGENTS, agentsDoc, `| \`${tool}\` |`)}`,
      ).toContain(msg);
    }
    for (const tool of ["edit_document", "stream_edit", "stream_edit_apply"]) {
      const desc = rustBody(mcpLib, "pub fn tool_registry()").match(
        new RegExp(`name: "${tool}",\\s*description: "((?:[^"\\\\]|\\\\[\\s\\S])*)"`),
      )?.[1];
      // A `\` line continuation in the Rust literal joins its lines with
      // the next line's leading whitespace dropped.
      const text = desc?.replace(/\\\n\s*/g, "").replaceAll('\\"', '"');
      expect(text, `${tool}'s description`).toContain(msg);
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
  it("the uninstall table removes the .deb and .rpm by their package name", () => {
    // The table had no .rpm row. Tauri names both packages after productName
    // in kebab case ("Ashlr MD" is `ashlr-md`, checked against a built
    // .deb's control file and .rpm's header).
    const { productName } = JSON.parse(tauriConf) as { productName: string };
    const pkg = productName.toLowerCase().replace(/\s+/g, "-");
    expect(pkg).toBe("ashlr-md");
    const section = installDoc.split("\n## Uninstalling")[1] ?? "";
    for (const [row, cmd] of [
      ["| Linux .deb |", `\`sudo apt remove ${pkg}\``],
      ["| Linux .rpm |", `\`sudo dnf remove ${pkg}\``],
    ]) {
      const line = section.split("\n").find((l) => l.startsWith(row)) ?? "";
      expect(line, `docs/INSTALL.md's uninstall table needs a "${row}" row`).toContain(
        cmd,
      );
    }
  });

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

describe("doc facts: README quick start", () => {
  it("says how mdopen gets on PATH before telling you to run it", () => {
    // Step 2 said "run `mdopen notes.md`", but no installer puts mdopen on
    // PATH, so a new user got "command not found".
    const start = readme.split("## 30-second start")[1]?.split("\n## ")[0] ?? "";
    const step = start.split("\n").find((l) => l.includes("`mdopen ")) ?? "";
    expect(step, "README.md: the 30-second start no longer runs mdopen").not.toBe("");
    expect(
      step,
      `name Install mdopen at ${where("README.md", readme, step)}`,
    ).toContain("Install mdopen");
  });
});

describe("doc facts: download links", () => {
  // The VS Code and Obsidian READMEs sent "download here" to md.ashlr.ai,
  // the landing page, while every other doc (and its own Download button)
  // goes to GitHub Releases, where the installers are.
  const RELEASES = "https://github.com/ashlrai/ashlr-md/releases";
  const docs: [string, string][] = [
    ["README.md", readme],
    ["docs/INSTALL.md", installDoc],
    ["integrations/obsidian/README.md", obsidianReadme],
    ["integrations/vscode/README.md", vscodeReadme],
  ];

  it("the landing page's download button goes to GitHub Releases", () => {
    const section = landingHtml.split('id="download"')[1] ?? "";
    expect(section).toContain(`href="${RELEASES}`);
  });

  it("every download or install link goes to GitHub Releases", () => {
    let seen = 0;
    for (const [file, doc] of docs) {
      for (const m of doc.matchAll(/([^\n]{0,40})\[([^\]]+)\]\((https?:[^)\s]+)\)/g)) {
        const around = `${m[1]} ${m[2]}`;
        if (!/download|install ashlr md from|releases/i.test(around)) continue;
        seen++;
        expect(m[3], `${where(file, doc, m[0])}: ${m[0]}`).toMatch(
          new RegExp(`^${RELEASES.replaceAll(".", "\\.")}(/|$)`),
        );
      }
    }
    expect(seen).toBeGreaterThanOrEqual(4);
  });
});

// ── AppImage MCP server path ──────────────────────────────────────────────────
// An AppImage mounts itself at a new /tmp/.mount_* directory each launch.
// The app's Connect and Copy resolve the server through Tauri's resource_dir,
// which for an AppImage is $APPDIR/usr/lib/<productName>, inside that mount.
// docs/AGENTS.md said to "use the resource dir inside the mount", a path that
// stops working when the app quits. Round 47 documented a manual extract
// instead; the app now copies the sidecars to <app local data dir>/bin and
// registers that copy, and the doc names that folder.

describe("doc facts: AppImage MCP server path", () => {
  const { productName, identifier } = JSON.parse(tauriConf) as {
    productName: string;
    identifier: string;
  };
  const inAppImage = `usr/lib/${productName}/mdopener-mcp`;
  const stableDir = `~/.local/share/${identifier}/bin/`;
  const manual = agentsDoc.split("### Manual")[1]?.split("```")[1] ?? "";

  it("Connect resolves the server through the resource dir", () => {
    expect(linuxConf).toContain('"target/release/mdopener-mcp": "./"');
    expect(agentSetup).toContain("app.path().resource_dir()");
  });

  it("from an AppImage, Connect registers a copy in the app's local data dir", () => {
    expect(agentSetup).toContain('std::env::var_os("APPIMAGE")');
    expect(agentSetup).toContain(
      'app.path().app_local_data_dir().ok().map(|d| d.join("bin"))',
    );
    expect(agentSetup).toContain("appimage_sidecar::apply(&bundled, plan)");
  });

  it("never tells the reader to use a path inside the mount", () => {
    expect(agentsDoc, where(AGENTS, agentsDoc, /resource dir/)).not.toMatch(
      /resource dir(ectory)? inside the mount|AppImage resource directory/,
    );
    expect(agentsDoc).not.toMatch(
      /register that in-mount path|button writes the `mdopen` inside/,
    );
  });

  it("the manual fallback copies the server out of the AppImage and registers the copy", () => {
    const lines = manual.split("\n");
    const extract = lines.find((l) => l.includes("--appimage-extract")) ?? "";
    expect(extract, `${AGENTS}: no --appimage-extract step`).toContain(
      `"${inAppImage}"`,
    );
    const copy = lines.find((l) => l.startsWith("install -D")) ?? "";
    expect(copy).toContain(`"squashfs-root/${inAppImage}"`);
    const dest = copy.split(" ").at(-1) ?? "";
    expect(dest).toBe("~/.local/bin/mdopener-mcp");
    const add = lines.filter((l) => l.startsWith("claude mcp add")).at(-1) ?? "";
    expect(add).toBe(`claude mcp add --scope user ashlr-md ${dest}`);
  });

  it("says Connect, Copy and the hook button register the stable copy", () => {
    const at = where(AGENTS, agentsDoc, "/tmp/.mount_");
    expect(agentsDoc, at).toContain(`\`${stableDir}\``);
    const hook = agentsDoc.split("### One-click install")[1]?.split("\n---")[0] ?? "";
    expect(hook, `${AGENTS} One-click install`).toContain(`${stableDir}mdopen`);
  });
});

// ── One-click setup buttons ───────────────────────────────────────────────────
// docs/AGENTS.md told readers to click "Install auto-open hook", a button the
// AI agents (MCP) section does not have (it is "Auto-open agent Markdown"),
// and said every button there is enabled only for detected tools, which the
// hook button is not.

describe("doc facts: one-click setup buttons", () => {
  const quick =
    agentsDoc.split("## Quick start: one-click setup (in-app)")[1]?.split("\n---")[0] ??
    "";
  const buttonText = (label: string) =>
    new RegExp(
      `\\n\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\s*</button>`,
    );

  it("every button the quick start lists is a button in the MCP section", () => {
    const labels = [...quick.matchAll(/^- \*\*([^*]+)\*\*:/gm)].map((m) => m[1]);
    expect(labels.length).toBe(4);
    for (const label of labels) {
      expect(mcpSection, `${AGENTS}: no "${label}" button`).toMatch(buttonText(label));
    }
  });

  it("every button the doc names under Preferences → AI agents (MCP) exists", () => {
    for (const m of agentsDoc.matchAll(/AI agents \(MCP\) → ([^*]+)\*\*/g)) {
      expect(mcpSection, `${AGENTS}: no "${m[1]}" button`).toMatch(buttonText(m[1]));
    }
  });

  it("only the Connect buttons wait for a detected tool", () => {
    expect(mcpSection).toMatch(/disabled=\{hookBusy\}/);
    expect(quick).toContain(
      "The **Connect** buttons are only enabled for tools detected",
    );
  });
});

// ── Release asset names ───────────────────────────────────────────────────────
// The Tauri bundler names each installer after productName, space included
// (`Ashlr MD_0.4.0_amd64.deb`, `Ashlr MD-0.4.0-1.x86_64.rpm`), and
// release.yml uploads them as workflow artifacts under those names without
// publishing anything. The published release renames them (`Ashlr_MD_…`),
// which every download link uses: uploaded as built, GitHub would turn the
// space into a dot and the links would 404. RELEASING.md said the workflow
// produced the `Ashlr_MD_` names and never listed the .rpm or the rename.

describe("doc facts: release asset names", () => {
  const { productName } = JSON.parse(tauriConf) as { productName: string };
  const pub = productName.replaceAll(" ", "_");
  const v = "X.Y.Z";
  // [what the bundler writes, what the release publishes]
  const assets: [string, string][] = [
    [`${productName}_${v}_aarch64.dmg`, `${pub}_${v}_aarch64.dmg`],
    [`${productName}_${v}_x64.dmg`, `${pub}_${v}_x64.dmg`],
    [`${productName}_${v}_amd64.deb`, `${pub}_${v}_amd64.deb`],
    [`${productName}-${v}-1.x86_64.rpm`, `${pub}_${v}_x86_64.rpm`],
    [`${productName}_${v}_amd64.AppImage`, `${pub}_${v}_amd64.AppImage`],
    [`${productName}_${v}_x64-setup.exe`, `${pub}_${v}_x64-setup.exe`],
    [`${productName}_${v}_x64_en-US.msi`, `${pub}_${v}_x64_en-US.msi`],
  ];
  const RELEASING = "docs/RELEASING.md";

  it("release.yml uploads the bundles as built and publishes nothing", () => {
    const steps = releaseWorkflow
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(steps).toContain("src-tauri/target/release/bundle/**/*");
    expect(steps).not.toMatch(/^\s*(tagName|releaseName|releaseId):/m);
    expect(steps).not.toMatch(/gh release (create|upload)/);
  });

  it("RELEASING.md maps every bundler output to its published name", () => {
    for (const [built, published] of assets) {
      const row =
        releasingDoc.split("\n").find((l) => l.includes(`\`${built}\``)) ?? "";
      expect(row, `${RELEASING}: no table row names \`${built}\``).not.toBe("");
      expect(row, `${where(RELEASING, releasingDoc, built)}`).toContain(
        `\`${published}\``,
      );
    }
  });

  it("RELEASING.md says to rename the bundles before attaching them", () => {
    const publish = releasingDoc.split("\n## 4.")[1]?.split("\n## ")[0] ?? "";
    expect(publish, `${RELEASING} §4`).toMatch(/Rename each bundle/);
    expect(publish, `${RELEASING} §4`).toContain(`\`${pub}_${v}_x86_64.rpm\``);
  });

  it("the install guide downloads only published names", () => {
    for (const [built, published] of assets) {
      expect(installDoc, "docs/INSTALL.md names a bundler output").not.toContain(built);
      if (published.endsWith("_x64.dmg")) continue; // no Intel build is published yet
      expect(installDoc, `docs/INSTALL.md does not name ${published}`).toContain(
        published,
      );
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
