// Site freshness: landing/index.html is generated from
// landing/index.template.html by landing/freshness.mjs, which bakes in facts
// from the repo's sources of truth (version, MCP tools, connect commands,
// themes, export formats, shortcuts). The first test runs the generator's
// --check so CI fails when the committed page is stale; the rest re-derive
// the same facts independently, so a bad extraction cannot hide behind a
// consistent regeneration.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import changelog from "../CHANGELOG.md?raw";
import landingHtml from "../landing/index.html?raw";
import templateHtml from "../landing/index.template.html?raw";
import pkgJson from "../package.json?raw";
import mdopenCargo from "../src-tauri/bins/mdopen/Cargo.toml?raw";
import afmMain from "../src-tauri/bins/mdopener-afm/Sources/mdopener-afm/main.swift?raw";
import mcpLib from "../src-tauri/bins/mdopener-mcp/src/lib.rs?raw";
import agentSetup from "../src-tauri/src/agent_setup.rs?raw";
import tauriConf from "../src-tauri/tauri.conf.json?raw";
import macosConf from "../src-tauri/tauri.macos.conf.json?raw";
import settingsPanel from "./components/settings/SettingsPanel.tsx?raw";
import commandsSrc from "./lib/commands.ts?raw";
import settingsStore from "./store/settingsStore.ts?raw";

const all = (re: RegExp, text: string): string[] =>
  [...text.matchAll(re)].map((m) => m[1]);

/** The body of the Rust item starting at `start`, up to the next top-level `}`. */
function rustBody(src: string, start: string): string {
  const at = src.indexOf(start);
  if (at < 0) throw new Error(`source no longer contains ${start}`);
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end < 0 ? undefined : end);
}

/** `program + add` for an AgentCli const in agent_setup.rs, e.g. CLAUDE_CLI. */
function agentAddCommand(constName: string): string {
  const block = agentSetup.split(`const ${constName}: AgentCli`)[1] ?? "";
  const program = block.match(/program: "([^"]+)"/)?.[1];
  const args = all(/"([^"]+)"/g, block.match(/add: &\[([^\]]+)\]/)?.[1] ?? "");
  if (!program || args.length === 0) {
    throw new Error(`agent_setup.rs no longer defines ${constName}`);
  }
  return `${program} ${args.join(" ")}`;
}

const { version, productName } = JSON.parse(tauriConf) as {
  version: string;
  productName: string;
};
const tools = all(
  /ToolDef \{\s*name: "([a-z_]+)"/g,
  rustBody(mcpLib, "pub fn tool_registry()"),
);

describe("site freshness: the generated page is committed", () => {
  it("landing/index.html equals what freshness.mjs renders", () => {
    const r = spawnSync("node", ["landing/freshness.mjs", "--check"], {
      cwd: resolve(__dirname, ".."),
      encoding: "utf8",
    });
    expect(r.status, `${r.stderr || r.stdout}\nrun: node landing/freshness.mjs`).toBe(
      0,
    );
  });

  it("the template still has placeholders and the output has none", () => {
    expect(templateHtml).toMatch(/\{\{[A-Z_]+\}\}/);
    expect(landingHtml).not.toMatch(/\{\{|\}\}/);
  });
});

describe("site freshness: version and release", () => {
  it("shows the version both manifests agree on, marked for machines", () => {
    const pkg = JSON.parse(pkgJson) as { version: string };
    expect(pkg.version).toBe(version);
    expect(landingHtml).toContain(`data-app-version="${version}"`);
    expect(landingHtml).toContain(`v${version}`);
  });

  it("marks the release date the CHANGELOG records for that version", () => {
    const esc = version.replaceAll(".", "\\.");
    const heading = changelog.match(
      new RegExp(`^## \\[${esc}\\](?:\\s+\\u2014\\s+(.+))?$`, "m"),
    );
    expect(heading, `CHANGELOG.md has no [${version}] entry`).not.toBeNull();
    const date = heading?.[1] === "Unreleased" ? "" : (heading?.[1] ?? "");
    expect(landingHtml).toContain(`data-release-date="${date}"`);
  });
});

describe("site freshness: MCP", () => {
  it("states the registry's tool count and names, in registry order", () => {
    expect(landingHtml).toContain(`data-mcp-tool-count="${tools.length}"`);
    expect(landingHtml).toContain(`data-mcp-tools="${tools.join(" ")}"`);
    expect(landingHtml).toContain(`${tools.length} tools available`);
  });

  it("shows the real connect commands and the bundled sidecar path", () => {
    expect(macosConf).toContain('"target/release/mdopener-mcp"');
    const sidecar = `/Applications/${productName}.app/Contents/Resources/mdopener-mcp`;
    for (const cmd of [agentAddCommand("CLAUDE_CLI"), agentAddCommand("CODEX_CLI")]) {
      expect(landingHtml, `${cmd} is not on the page`).toContain(cmd);
      expect(landingHtml).toContain(`"${sidecar}"`);
    }
  });

  it("names the Settings section the terminal comment points at", () => {
    const label = settingsPanel.match(/title="(AI agents[^"]*)"/)?.[1];
    expect(label, "SettingsPanel has no AI agents section").toBeTruthy();
    expect(landingHtml).toContain(`→ ${label} →`);
  });
});

describe("site freshness: app facts", () => {
  it("names the real CLI binary and deep-link scheme", () => {
    const bin = mdopenCargo.match(/^name = "([^"]+)"$/m)?.[1];
    expect(bin).toBe("mdopen");
    expect(landingHtml).toContain(`${bin} PLAN.md`);
    const { plugins } = JSON.parse(tauriConf) as {
      plugins: { "deep-link": { desktop: { schemes: string[] } } };
    };
    expect(landingHtml).toContain(`${plugins["deep-link"].desktop.schemes[0]}://`);
  });

  it("lists exactly the export formats the app and MCP server support", () => {
    const mcpFormats = all(
      /"([a-z]+)"/g,
      mcpLib.match(/pub const EXPORT_FORMATS: \[&str; \d+\] = \[([^\]]*)\]/)?.[1] ?? "",
    );
    const appFormats = all(/id: "file\.export\.([a-z]+)"/g, commandsSrc).filter(
      (f) => f !== "dialog",
    );
    expect([...appFormats].sort()).toEqual([...mcpFormats].sort());
    expect(landingHtml).toContain(`data-export-formats="${mcpFormats.join(" ")}"`);
    for (const f of mcpFormats) {
      expect(landingHtml).toContain(
        `<b>${f === "docx" ? "Word" : f.toUpperCase()}</b>`,
      );
    }
  });

  it("names every theme in the store, in order", () => {
    const block =
      settingsStore.match(/export const THEMES[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? "";
    const themes = [...block.matchAll(/\{ id: "([^"]+)", label: "([^"]+)" \}/g)].map(
      (m) => ({ id: m[1], label: m[2] }),
    );
    expect(themes.length).toBeGreaterThan(1);
    expect(landingHtml).toContain(
      `const order = [${themes.map((t) => `"${t.id}"`).join(", ")}];`,
    );
    expect(landingHtml).toContain(`data-theme="${themes[0].id}"`);
    for (const t of themes) {
      expect(landingHtml).toContain(`data-t="${t.id}" title="${t.label}"`);
    }
  });

  it("states the real on-device AI macOS floor", () => {
    const floor = afmMain.match(/@available\(macOS (\d+)/)?.[1];
    expect(floor, "mdopener-afm's @available floor is gone").toBeTruthy();
    expect(landingHtml).toContain(`macOS ${floor}+`);
  });

  it("keeps the shortcut grid generator-owned", () => {
    // docFacts.test.ts proves the kbd list equals the registry's shortcuts;
    // the regen check above proves the page is generator output. Together
    // they keep the grid honest, so the template must keep its placeholder.
    expect(templateHtml).toContain("{{SHORTCUT_ROWS}}");
    expect(landingHtml).not.toContain("{{SHORTCUT_ROWS}}");
  });
});
