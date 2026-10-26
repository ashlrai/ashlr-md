#!/usr/bin/env node
/**
 * landing/freshness.mjs: regenerate landing/index.html from
 * landing/index.template.html, substituting facts read from the repo's
 * sources of truth so the page cannot drift from the code it describes.
 *
 *   node landing/freshness.mjs          rewrite landing/index.html
 *   node landing/freshness.mjs --check  exit 1 when the committed page is stale
 *
 * Sources of truth:
 *   version, productName, deep-link scheme  package.json + src-tauri/tauri.conf.json
 *   release date                            CHANGELOG.md's heading for that version
 *   MCP tool names and count                tool_registry() in bins/mdopener-mcp
 *   agent connect commands                  CLAUDE_CLI / CODEX_CLI in agent_setup.rs
 *   bundled sidecar name + macOS path       resources in tauri.macos.conf.json
 *   view modes, export formats, shortcuts   the command registry in src/lib/commands.ts
 *   editor-owned bindings                   EDITOR_SHORTCUTS in src/lib/shortcutSheet.ts
 *   theme ids and labels                    THEMES in src/store/settingsStore.ts
 *   MCP Settings section label              SettingsPanel.tsx
 *   CLI binary name                         bins/mdopen/Cargo.toml
 *   Apple on-device AI floor                @available in mdopener-afm's main.swift
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const all = (re, text) => [...text.matchAll(re)].map((m) => m[1]);

/** The body of the Rust item starting at `start`, up to the next top-level `}`. */
function rustBody(src, start) {
  const at = src.indexOf(start);
  if (at < 0) throw new Error(`Rust source no longer contains ${start}`);
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end < 0 ? undefined : end);
}

function need(value, what) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`freshness: could not read ${what} from the repo sources`);
  }
  return value;
}

// ── Scalar facts ─────────────────────────────────────────────────────────────

function collectVersion() {
  const pkg = JSON.parse(read("package.json"));
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  if (pkg.version !== tauri.version) {
    throw new Error(
      `version mismatch: package.json has ${pkg.version}, tauri.conf.json has ${tauri.version}`,
    );
  }
  const version = need(pkg.version, "version");
  const changelog = read("CHANGELOG.md");
  const heading = changelog.match(
    new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\](?:\\s+\\u2014\\s+(.+))?$`, "m"),
  );
  if (!heading) {
    throw new Error(`CHANGELOG.md has no "## [${version}]" entry`);
  }
  const releaseDate = (heading[1] ?? "").trim();
  return {
    version,
    releaseDate: releaseDate === "Unreleased" ? "" : releaseDate,
    productName: need(tauri.productName, "productName"),
    scheme: need(tauri.plugins?.["deep-link"]?.desktop?.schemes?.[0], "deep-link scheme"),
  };
}

function collectMcp() {
  const lib = read("src-tauri/bins/mdopener-mcp/src/lib.rs");
  const tools = all(
    /ToolDef \{\s*name: "([a-z_]+)"/g,
    rustBody(lib, "pub fn tool_registry()"),
  );
  if (tools.length === 0) throw new Error("tool_registry() parsed to zero tools");
  const exportFormats = all(
    /"([a-z]+)"/g,
    need(
      lib.match(/pub const EXPORT_FORMATS: \[&str; \d+\] = \[([^\]]*)\]/)?.[1],
      "EXPORT_FORMATS",
    ),
  );
  const setup = read("src-tauri/src/agent_setup.rs");
  const cli = (name) => {
    const block = setup.split(`const ${name}: AgentCli`)[1] ?? "";
    const program = need(block.match(/program: "([^"]+)"/)?.[1], `${name} program`);
    const add = all(
      /"([^"]+)"/g,
      need(block.match(/add: &\[([^\]]+)\]/)?.[1], `${name} add args`),
    );
    return `${program} ${add.join(" ")}`;
  };
  const claude = cli("CLAUDE_CLI");
  const codex = cli("CODEX_CLI");
  const bin = need(
    read("src-tauri/tauri.macos.conf.json").match(
      /"target\/release\/(mdopener-mcp)"/,
    )?.[1],
    "bundled MCP sidecar name",
  );
  return { tools, exportFormats, claude, codex, bin };
}

function collectCommands() {
  const src = read("src/lib/commands.ts");
  const commands = new Map();
  for (const m of src.matchAll(/\{\s*\n\s*id: "([^"]+)",([\s\S]*?)\n\s*\},/g)) {
    const [, id, body] = m;
    const title = body.match(/title: "((?:[^"\\]|\\.)*)"/);
    const shortcut = body.match(/shortcut: "((?:[^"\\]|\\.)*)"/);
    commands.set(id, {
      title: title && JSON.parse(`"${title[1]}"`),
      shortcut: shortcut && JSON.parse(`"${shortcut[1]}"`),
    });
  }
  if (commands.size < 20) throw new Error("commands.ts parsed to too few commands");
  const sheet = read("src/lib/shortcutSheet.ts");
  const editorShortcuts = [
    ...sheet.matchAll(/\{ title: "([^"]+)", keys: \[([^\]]+)\] \}/g),
  ].map((m) => ({ title: m[1], keys: all(/"([^"]+)"/g, m[2]) }));
  return { commands, editorShortcuts };
}

function collectThemes() {
  const src = read("src/store/settingsStore.ts");
  const block = need(
    src.match(/export const THEMES[^=]*=\s*\[([\s\S]*?)\];/)?.[1],
    "THEMES",
  );
  const themes = [...block.matchAll(/\{ id: "([^"]+)", label: "([^"]+)" \}/g)].map(
    (m) => ({ id: m[1], label: m[2] }),
  );
  if (themes.length === 0) throw new Error("THEMES parsed to zero themes");
  return themes;
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

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

const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

/** keymap.ts's formatKey: single chars upper-case, named keys get a glyph. */
function formatKey(key) {
  switch (key) {
    case ",":
      return ",";
    case "arrowup":
      return "↑";
    case "arrowdown":
      return "↓";
    case "enter":
      return "↵";
    case "escape":
      return "Esc";
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

/** keymap.ts's formatShortcut on macOS: "mod+shift+l" -> "⇧⌘L". */
function glyph(shortcut) {
  const parts = shortcut.split("+");
  const key = parts.pop();
  let out = "";
  if (parts.includes("alt")) out += "⌥";
  if (parts.includes("shift")) out += "⇧";
  if (parts.includes("mod")) out += "⌘";
  return out + formatKey(key);
}

/** Rows of the site's shortcut grid: label -> command ids in src/lib/commands.ts. */
const SHORTCUT_ROWS = [
  ["Command palette", ["app.commandPalette"]],
  ["AI assistant", ["ai.toggle"]],
  ["Inline AI rewrite (in editor)", ["editor:Inline AI rewrite"]],
  ["Agent activity drawer", ["view.activity.toggle"]],
  ["Outline / table of contents", ["view.outline.toggle"]],
  ["Cycle theme", ["theme.cycle"]],
  ["Read / Edit / Source", ["view.read", "view.edit", "view.source"]],
  ["Switch · close tabs", ["tab.next", "tab.prev", "tab.close"]],
  ["Open · Save · Export", ["file.open", "file.save", "file.export.dialog"]],
  ["Find · Replace · Search", ["find.document", "find.replace", "view.search.toggle"]],
  ["Split preview · Zen mode", ["view.split.toggle", "view.zen.toggle"]],
  ["Copy as rich text", ["edit.copyRichText"]],
  ["Insert table", ["edit.insertTable"]],
  ["Settings", ["app.settings"]],
  ["All shortcuts (cheat sheet)", ["help.shortcuts"]],
];

const ROW_STYLE =
  'display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 16px;background:var(--surface);border:1px solid var(--line);border-radius:11px;box-shadow:var(--shadow-sm)';
const KBD_STYLE =
  "font-family:var(--mono);font-size:13px;font-weight:600;color:var(--accent-deep);background:var(--accent-soft);padding:3px 9px;border-radius:7px";

function shortcutRows(commands, editorShortcuts) {
  const keysFor = (ref) => {
    if (ref.startsWith("editor:")) {
      const title = ref.slice("editor:".length);
      const row = editorShortcuts.find((r) => r.title === title);
      if (!row) {
        throw new Error(`EDITOR_SHORTCUTS no longer has "${title}"; update SHORTCUT_ROWS`);
      }
      return row.keys;
    }
    const cmd = commands.get(ref);
    if (!cmd?.shortcut) {
      throw new Error(`command "${ref}" has no shortcut; update SHORTCUT_ROWS`);
    }
    return [cmd.shortcut];
  };
  const covered = new Set(SHORTCUT_ROWS.flatMap(([, refs]) => refs.flatMap(keysFor)));
  for (const [id, cmd] of commands) {
    if (cmd.shortcut && !covered.has(cmd.shortcut)) {
      throw new Error(
        `command "${id}" binds "${cmd.shortcut}" but no SHORTCUT_ROWS row shows it; add a row`,
      );
    }
  }
  for (const row of editorShortcuts) {
    for (const k of row.keys) {
      if (!covered.has(k)) {
        throw new Error(
          `editor shortcut "${k}" (${row.title}) is not in SHORTCUT_ROWS; add a row`,
        );
      }
    }
  }
  return SHORTCUT_ROWS.map(
    ([label, refs]) =>
      `<div style="${ROW_STYLE}"><span style="color:var(--ink-soft)">${label}</span><kbd style="${KBD_STYLE}">${refs
        .flatMap(keysFor)
        .map(glyph)
        .join(" ")}</kbd></div>`,
  ).join("\n          ");
}

/** Per-theme card subtitle; a new theme id gets a plain label until curated. */
const THEME_SUBTITLES = { paper: "clean light", sepia: "warm reading", midnight: "true dark" };

function themeCards(themes) {
  return themes
    .map(({ id, label }) => {
      const sub = THEME_SUBTITLES[id];
      const name = sub ? `${label} <small>${sub}</small>` : label;
      return `<div class="theme-card reveal">\n            <div class="tprev ${id}"><div class="ttl">${label}</div><div class="ln a"></div><div class="ln"></div><div class="ln" style="width:80%"></div></div>\n            <div class="tname">${name}</div>\n          </div>`;
    })
    .join("\n          ");
}

const themeButtons = (themes) =>
  themes
    .map(
      ({ id, label }, i) =>
        `<button class="sw-${id}${i === 0 ? " active" : ""}" data-t="${id}" title="${label}"></button>`,
    )
    .join("\n              ");

/** Oxford-comma list of the phrases each export format gets on the card. */
const EXPORT_PHRASES = {
  pdf: "a polished <b>PDF</b>",
  docx: "a <b>Word</b> doc",
  html: "a self-contained <b>HTML</b> page",
  epub: "an <b>EPUB</b>",
};

// ── Render ────────────────────────────────────────────────────────────────────

export function renderLanding() {
  const { version, releaseDate, productName, scheme } = collectVersion();
  const mcp = collectMcp();
  const { commands, editorShortcuts } = collectCommands();
  const themes = collectThemes();

  const exports_ = {
    ids: mcp.exportFormats.join(" "),
    inline: mcp.exportFormats.map((f) => f.toUpperCase()).join(" · "),
    prose: mcp.exportFormats
      .map((f) => EXPORT_PHRASES[f] ?? `a <b>${f.toUpperCase()}</b>`)
      .join(", ")
      .replace(/, ([^,]*)$/, ", or $1"),
  };

  const view = ["view.read", "view.edit", "view.source"].map((id, i) => {
    const title = commands.get(id)?.title ?? "";
    const name = title.match(/^Switch to (\w+) view$/)?.[1];
    if (!name) throw new Error(`"${id}" title is no longer "Switch to <X> view"`);
    return `<span${i === 0 ? ' class="on"' : ""}>${name}</span>`;
  });

  const mcpLabel = need(
    read("src/components/settings/SettingsPanel.tsx").match(
      /title="(AI agents[^"]*)"/,
    )?.[1],
    "AI agents section label",
  );
  const afmMin = need(
    read("src-tauri/bins/mdopener-afm/Sources/mdopener-afm/main.swift").match(
      /@available\(macOS (\d+)/,
    )?.[1],
    "on-device AI macOS floor",
  );
  const mdopen = need(
    read("src-tauri/bins/mdopen/Cargo.toml").match(/^name = "([^"]+)"$/m)?.[1],
    "mdopen bin name",
  );

  const values = {
    VERSION: version,
    RELEASE_DATE: releaseDate,
    MDOPEN: mdopen,
    SCHEME: scheme,
    AFM_MIN_MACOS: afmMin,
    MCP_TOOL_COUNT: String(mcp.tools.length),
    MCP_TOOL_NAMES: mcp.tools.join(" "),
    CLAUDE_MCP_ADD: mcp.claude,
    CODEX_MCP_ADD: mcp.codex,
    MCP_SIDECAR_MACOS: `/Applications/${productName}.app/Contents/Resources/${mcp.bin}`,
    SETTINGS_MCP_LABEL: mcpLabel,
    EXPORT_FORMAT_IDS: exports_.ids,
    EXPORT_FORMATS_INLINE: exports_.inline,
    EXPORT_FORMATS_PROSE: exports_.prose,
    THEME_COUNT_WORD: capitalize(NUMBER_WORDS[themes.length] ?? String(themes.length)),
    THEMES_PROSE: themes.map((t) => t.label).join(", ").replace(/, ([^,]*)$/, ", and $1"),
    THEME_CARDS: themeCards(themes),
    THEME_SWITCH_BUTTONS: themeButtons(themes),
    THEME_FIRST_ID: themes[0].id,
    THEME_ORDER_JS: themes.map((t) => `"${t.id}"`).join(", "),
    VIEW_MODES: view.join(""),
    SHORTCUT_ROWS: shortcutRows(commands, editorShortcuts),
  };

  const template = read("landing/index.template.html");
  const seen = new Set();
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`template asks for unknown {{${key}}}`);
    seen.add(key);
    return values[key];
  });
  const unused = Object.keys(values).filter((k) => !seen.has(k));
  if (unused.length) throw new Error(`generated but unused: ${unused.join(", ")}`);
  if (/\{\{|\}\}/.test(out)) throw new Error("unreplaced placeholder remains");
  return out;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const OUT = "landing/index.html";

export function checkLanding() {
  const expected = renderLanding();
  const actual = read(OUT);
  if (actual === expected) return { ok: true, diff: "" };
  const a = actual.split("\n");
  const e = expected.split("\n");
  const first = a.findIndex((l, i) => l !== e[i]);
  const context = [
    `first difference at ${OUT}:${first + 1}`,
    `  committed: ${a[first]?.slice(0, 160)}`,
    `  generated: ${e[first]?.slice(0, 160)}`,
  ].join("\n");
  return { ok: false, diff: context };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    const { ok, diff } = checkLanding();
    if (!ok) {
      console.error(`${OUT} is stale.\n${diff}\nRun: node landing/freshness.mjs`);
      process.exit(1);
    }
    console.log(`${OUT} is fresh`);
  } else {
    writeFileSync(join(ROOT, OUT), renderLanding());
    console.log(`wrote ${OUT}`);
  }
}
