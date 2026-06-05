import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { DefaultHandlerStatus } from "../../lib/defaultHandler";
import {
  type EmbedStatus,
  embedIndex,
  embedStatus,
  invalidateEmbedAvailable,
} from "../../lib/embedSearch";
import { useActivityStore } from "../../store/activityStore";
import { useMemoryStore } from "../../store/memoryStore";
import { useRecentStore } from "../../store/recentStore";
import { THEMES, useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import "../../styles/settings.css";

// ─── Icon components ──────────────────────────────────────────────────────────

function CloseIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M2 2l10 10M12 2 2 12"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 7h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M7 3v8M3 7h8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect
        x="2"
        y="4"
        width="16"
        height="12"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M5.5 7.5 8 10l-2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 12.5h4.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M10 3v1.5M10 15.5V17M3 10h1.5M15.5 10H17"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="5"
        y="5"
        width="8"
        height="9"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 8.5l3.5 3.5 6.5-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      className="settings-spinner"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="20 18"
      />
    </svg>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Tracks the async state of the `install_cli` Tauri command.
 * `idle`    — not yet invoked
 * `busy`    — invocation in flight
 * `ok`      — succeeded; `path` holds the install location
 * `error`   — failed; `message` describes why
 */
type InstallStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; path: string }
  | { kind: "error"; message: string };

/**
 * Tracks whether the "Copy" button for the MCP command has been clicked.
 * Resets after 2 s so it's re-clickable.
 */
type CopyStatus = "idle" | "copied";

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="settings-section-header">
      <span className="settings-section-icon">{icon}</span>
      <h3 className="settings-section-title">{title}</h3>
    </div>
  );
}

// ─── Theme swatch row ─────────────────────────────────────────────────────────

/**
 * Three-swatch segmented control for theme selection.
 * Each swatch shows a tiny colour preview so the choice is visually obvious.
 */
const THEME_SWATCHES: Record<string, { bg: string; text: string; accent: string }> = {
  paper: { bg: "#ffffff", text: "#1f2328", accent: "#0969da" },
  sepia: { bg: "#f5edda", text: "#43382a", accent: "#9a5b34" },
  midnight: { bg: "#16181d", text: "#e6e8eb", accent: "#6ba8ff" },
};

function ThemePicker() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  return (
    <div className="settings-theme-picker" role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => {
        const swatch = THEME_SWATCHES[t.id];
        const active = theme === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            className={`settings-theme-btn${active ? " active" : ""}`}
            onClick={() => setTheme(t.id)}
            title={`Switch to ${t.label} theme`}
          >
            {/* Mini colour preview */}
            <span
              className="settings-theme-swatch"
              style={{ background: swatch.bg }}
              aria-hidden="true"
            >
              <span
                className="settings-theme-swatch-text"
                style={{ color: swatch.text }}
              />
              <span
                className="settings-theme-swatch-accent"
                style={{ background: swatch.accent }}
              />
            </span>
            <span className="settings-theme-label">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Font-size stepper ────────────────────────────────────────────────────────

const FONT_MIN = 13;
const FONT_MAX = 24;

function FontSizeStepper() {
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setFontSize = useSettingsStore((s) => s.setFontSize);

  return (
    <div className="settings-stepper" role="group" aria-label="Font size">
      <button
        type="button"
        className="settings-stepper-btn"
        onClick={() => setFontSize(fontSize - 1)}
        disabled={fontSize <= FONT_MIN}
        aria-label="Decrease font size"
      >
        <MinusIcon />
      </button>
      <span className="settings-stepper-value" aria-live="polite" aria-atomic="true">
        {fontSize}
        <span className="settings-stepper-unit">px</span>
      </span>
      <button
        type="button"
        className="settings-stepper-btn"
        onClick={() => setFontSize(fontSize + 1)}
        disabled={fontSize >= FONT_MAX}
        aria-label="Increase font size"
      >
        <PlusIcon />
      </button>
    </div>
  );
}

// ─── Notifications toggle ─────────────────────────────────────────────────────

function NotificationToggle() {
  const enabled = useSettingsStore((s) => s.notificationsEnabled);
  const setEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className={`settings-switch${enabled ? " on" : ""}`}
      onClick={() => setEnabled(!enabled)}
      title={
        enabled
          ? "Notify me when an agent writes files while Ashlr isn't focused"
          : "Native notifications are off"
      }
    >
      <span className="settings-switch-knob" aria-hidden="true" />
      <span className="settings-switch-label">{enabled ? "On" : "Off"}</span>
    </button>
  );
}

// ─── CLI install section ──────────────────────────────────────────────────────

function CliSection() {
  const [status, setStatus] = useState<InstallStatus>({ kind: "idle" });

  async function install() {
    setStatus({ kind: "busy" });
    try {
      const path = await invoke<string>("install_cli");
      setStatus({ kind: "ok", path });
    } catch (e) {
      const msg = typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
      setStatus({ kind: "error", message: msg });
    }
  }

  const busy = status.kind === "busy";

  return (
    <div className="settings-cli">
      <p className="settings-description">
        <code className="settings-inline-code">mdopen</code> is a CLI companion that
        opens any Markdown file directly in Ashlr MD from your terminal.
      </p>
      <div className="settings-cli-row">
        <button
          type="button"
          className="settings-action-btn"
          onClick={install}
          disabled={busy}
          aria-busy={busy}
        >
          {busy && <SpinnerIcon />}
          Install <code>mdopen</code>
        </button>
        {status.kind === "ok" && (
          <span className="settings-cli-result settings-result-ok">
            Installed at <code className="settings-inline-code">{status.path}</code>
          </span>
        )}
        {status.kind === "error" && (
          <span className="settings-cli-result settings-result-error">
            {status.message}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Default Markdown app ─────────────────────────────────────────────────────

function LinkIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M8.5 11.5a4.5 4.5 0 0 0 6.364 0l1.768-1.768a4.5 4.5 0 0 0-6.364-6.364L9.5 4.136"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M11.5 8.5a4.5 4.5 0 0 0-6.364 0L3.368 10.268a4.5 4.5 0 0 0 6.364 6.364l.768-.768"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** "Set as default Markdown app" — tri-state, mirrors the top banner. */
function DefaultHandlerSection() {
  const [status, setStatus] = useState<InstallStatus>({ kind: "idle" });
  const [handler, setHandler] = useState<DefaultHandlerStatus | null>(null);

  // Re-check on open AND on window focus, so confirming in System Settings is
  // reflected here without reopening the panel.
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      import("../../lib/defaultHandler").then(({ defaultHandlerStatus }) =>
        defaultHandlerStatus().then((s) => {
          if (!cancelled) setHandler(s);
        }),
      );
    };
    check();
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  async function makeDefault() {
    setStatus({ kind: "busy" });
    try {
      const { setDefaultMdHandler, defaultHandlerStatus } = await import(
        "../../lib/defaultHandler"
      );
      await setDefaultMdHandler();
      setHandler(await defaultHandlerStatus());
      setStatus({ kind: "ok", path: "" });
    } catch (e) {
      const msg = typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
      setStatus({ kind: "error", message: msg });
    }
  }

  async function showHelp() {
    const { openDefaultAppsHelp } = await import("../../lib/defaultHandler");
    void openDefaultAppsHelp();
  }

  const busy = status.kind === "busy";
  const isDefault = handler?.state === "default";
  const isUnknown = handler?.state === "unknown";
  const canSet = handler?.canSet ?? false;

  return (
    <div className="settings-cli">
      <p className="settings-description">
        Make Ashlr MD the app that opens when you double-click a{" "}
        <code className="settings-inline-code">.md</code> file in Finder.
      </p>
      <div className="settings-cli-row">
        {isDefault ? (
          <span className="settings-cli-result settings-result-ok">
            ✓ Ashlr MD is your default
          </span>
        ) : isUnknown ? (
          <>
            <button type="button" className="settings-action-btn" onClick={showHelp}>
              Open system settings…
            </button>
            <span className="settings-cli-result settings-description-muted">
              Couldn't determine the current default.
            </span>
          </>
        ) : (
          <button
            type="button"
            className="settings-action-btn"
            onClick={canSet ? makeDefault : showHelp}
            disabled={busy}
            aria-busy={busy}
          >
            {busy && <SpinnerIcon />}
            {canSet ? "Set as default" : "Show me how"}
          </button>
        )}
        {status.kind === "error" && (
          <span className="settings-cli-result settings-result-error">
            {status.message}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── AI memory section ────────────────────────────────────────────────────────

function MemoryIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 3.5c-2.2 0-4 1.6-4 3.6 0 .5.1 1 .3 1.4C5.5 9 5 9.9 5 11c0 1.7 1.5 3 3.3 3 .4 0 .8-.07 1.1-.2v1.7M10 3.5c2.2 0 4 1.6 4 3.6 0 .5-.1 1-.3 1.4 1.1.5 1.6 1.4 1.6 2.5 0 1.7-1.5 3-3.3 3-.4 0-.8-.07-1.1-.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "What Ashlr remembers" — local AI memory, fully transparent + editable. */
function MemorySection() {
  const items = useMemoryStore((s) => s.items);
  const add = useMemoryStore((s) => s.add);
  const remove = useMemoryStore((s) => s.remove);
  const clear = useMemoryStore((s) => s.clear);
  const [draft, setDraft] = useState("");

  const submit = () => {
    if (!draft.trim()) return;
    add(draft, "user");
    setDraft("");
  };

  return (
    <div className="settings-memory">
      <p className="settings-description">
        Facts the AI remembers about you and your projects — injected into every chat so
        it gets more useful over time. Stored locally; never leaves your device.
      </p>
      <div className="settings-cli-row">
        <input
          className="settings-memory-input"
          placeholder="e.g. I prefer concise answers and TypeScript"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button
          type="button"
          className="settings-action-btn"
          onClick={submit}
          disabled={!draft.trim()}
        >
          Remember
        </button>
      </div>
      {items.length === 0 ? (
        <p className="settings-description settings-description-muted">
          Nothing remembered yet.
        </p>
      ) : (
        <ul className="settings-memory-list">
          {items.map((i) => (
            <li key={i.id} className="settings-memory-item">
              <span className="settings-memory-text">{i.text}</span>
              <button
                type="button"
                className="settings-memory-del"
                onClick={() => remove(i.id)}
                aria-label="Forget this"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <button type="button" className="settings-memory-clear" onClick={() => clear()}>
          Forget everything
        </button>
      )}
    </div>
  );
}

// ─── MCP / agent setup section ───────────────────────────────────────

/** Tracks the async state of a one-click agent-connect command. */
function DatabaseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <ellipse cx="10" cy="5" rx="6" ry="2.4" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M4 5v10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V5M4 10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** On-device semantic search status + manual reindex. */
function EmbedSection() {
  const [status, setStatus] = useState<EmbedStatus | null>(null);
  const [indexing, setIndexing] = useState(false);

  useEffect(() => {
    embedStatus().then(setStatus);
  }, []);

  async function reindex() {
    setIndexing(true);
    try {
      invalidateEmbedAvailable(); // a model may have just been pulled
      const paths = new Set<string>();
      for (const r of useRecentStore.getState().recents) paths.add(r.path);
      for (const f of useActivityStore.getState().files) paths.add(f.path);
      await embedIndex(Array.from(paths), true); // full reindex — prune stale files
      setStatus(await embedStatus());
    } finally {
      setIndexing(false);
    }
  }

  if (!status) {
    return <p className="settings-description settings-description-muted">Checking…</p>;
  }

  if (!status.available) {
    return (
      <p className="settings-description settings-description-muted">
        Semantic search needs a local embedding model. Run{" "}
        <code className="settings-inline-code">ollama pull nomic-embed-text</code> to
        upgrade your “My library” chat answers from keyword to semantic — fully
        on-device.
      </p>
    );
  }

  return (
    <div className="settings-cli">
      <p className="settings-description">
        “My library” chat answers are grounded in semantic search over your Markdown,
        fully on-device via <code className="settings-inline-code">{status.model}</code>
        .
      </p>
      <div className="settings-cli-row">
        <button
          type="button"
          className="settings-action-btn"
          onClick={reindex}
          disabled={indexing}
          aria-busy={indexing}
        >
          {indexing && <SpinnerIcon />}
          {indexing ? "Indexing…" : "Reindex library"}
        </button>
        <span className="settings-cli-result settings-description-muted">
          {status.chunkCount} chunks · {status.fileCount} files
        </span>
      </div>
    </div>
  );
}

type ConnectStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

function McpSection() {
  const [agentClis, setAgentClis] = useState<{
    claude: boolean;
    codex: boolean;
    cursor: boolean;
  } | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<ConnectStatus>({ kind: "idle" });
  const [cursorStatus, setCursorStatus] = useState<ConnectStatus>({ kind: "idle" });
  const [mcpCmd, setMcpCmd] = useState<string>(
    "claude mcp add ashlr-md /Applications/Ashlr\\ MD.app/Contents/MacOS/mdopener-mcp",
  );
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");

  useEffect(() => {
    invoke<{ claude: boolean; codex: boolean; cursor: boolean }>("detect_agent_clis")
      .then(setAgentClis)
      .catch(() => setAgentClis({ claude: false, codex: false, cursor: false }));
    invoke<string>("mcp_command_string")
      .then(setMcpCmd)
      .catch(() => {});
  }, []);

  async function connect(
    cmd: "connect_claude_code" | "connect_cursor",
    set: (s: ConnectStatus) => void,
  ) {
    set({ kind: "busy" });
    try {
      const msg = await invoke<string>(cmd);
      set({ kind: "ok", message: msg });
    } catch (e) {
      const msg = typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
      set({ kind: "error", message: msg });
    }
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(mcpCmd);
      setCopyStatus("copied");
      setTimeout(() => setCopyStatus("idle"), 2000);
    } catch {
      // Clipboard unavailable in some sandbox configs — fail silently.
    }
  }

  function Result({ status }: { status: ConnectStatus }) {
    if (status.kind === "ok") {
      return <p className="settings-cli-result settings-result-ok">{status.message}</p>;
    }
    if (status.kind === "error") {
      return (
        <p className="settings-cli-result settings-result-error">{status.message}</p>
      );
    }
    return null;
  }

  const claudeBusy = claudeStatus.kind === "busy";
  const cursorBusy = cursorStatus.kind === "busy";

  return (
    <div className="settings-mcp">
      <p className="settings-description">
        Connect Ashlr MD to your AI coding agent so it can open, read, and edit the
        current document without leaving the coding environment.
      </p>

      <div className="settings-cli-row" style={{ flexWrap: "wrap", gap: "8px" }}>
        <button
          type="button"
          className="settings-action-btn"
          onClick={() => connect("connect_claude_code", setClaudeStatus)}
          disabled={claudeBusy || agentClis?.claude === false}
          aria-busy={claudeBusy}
          title={
            agentClis?.claude === false
              ? "Claude Code CLI not found"
              : "Register ashlr-md in Claude Code"
          }
        >
          {claudeBusy && <SpinnerIcon />}
          Connect to Claude Code
        </button>
        <button
          type="button"
          className="settings-action-btn"
          onClick={() => connect("connect_cursor", setCursorStatus)}
          disabled={cursorBusy || agentClis?.cursor === false}
          aria-busy={cursorBusy}
          title={
            agentClis?.cursor === false
              ? "Cursor not detected"
              : "Write ashlr-md to ~/.cursor/mcp.json"
          }
        >
          {cursorBusy && <SpinnerIcon />}
          Connect to Cursor
        </button>
      </div>
      <Result status={claudeStatus} />
      <Result status={cursorStatus} />

      <p
        className="settings-description settings-description-muted"
        style={{ marginTop: "14px" }}
      >
        For Codex or manual setup — run once in your terminal:
      </p>
      <div className="settings-mcp-command-row">
        <code className="settings-mcp-command">{mcpCmd}</code>
        <button
          type="button"
          className={`settings-copy-btn${copyStatus === "copied" ? " copied" : ""}`}
          onClick={copyCommand}
          aria-label={copyStatus === "copied" ? "Copied!" : "Copy command"}
          title={copyStatus === "copied" ? "Copied!" : "Copy to clipboard"}
        >
          {copyStatus === "copied" ? <CheckIcon /> : <CopyIcon />}
          <span>{copyStatus === "copied" ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <p className="settings-mcp-note">
        Buttons are disabled when the tool isn't detected. See{" "}
        <a
          href="https://github.com/ashlrai/ashlr-md/blob/main/docs/AGENTS.md"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--accent)" }}
        >
          docs/AGENTS.md
        </a>{" "}
        for Codex setup.
      </p>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Full-screen Preferences modal.
 *
 * Rendered at the Shell level so it floats above all app chrome.
 * Visibility is controlled by `useUiStore.settingsOpen`.
 *
 * Sections:
 *   1. Appearance  — theme picker + font-size stepper
 *   2. Command-line tool — installs the `mdopen` CLI via Tauri IPC
 *   3. AI agents (MCP) — one-time `claude mcp add` setup command
 */
export function SettingsPanel() {
  const close = useUiStore((s) => s.closeSettings);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape (capture phase so it beats inner key handlers).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  // Trap focus: move to first focusable element on open.
  useEffect(() => {
    const first = panelRef.current?.querySelector<HTMLElement>(
      "button:not(:disabled), [tabindex='0']",
    );
    first?.focus();
  }, []);

  return (
    /* Backdrop — click outside to close */
    <div
      className="settings-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-panel-title"
        ref={panelRef}
      >
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="settings-header">
          <h2 className="settings-title" id="settings-panel-title">
            Preferences
          </h2>
          <button
            type="button"
            className="settings-close-btn"
            onClick={close}
            aria-label="Close preferences"
          >
            <CloseIcon />
          </button>
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="settings-body">
          {/* 1 · Appearance */}
          <section className="settings-section">
            <SectionHeader
              icon={
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <circle
                    cx="10"
                    cy="10"
                    r="7"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <path
                    d="M10 3v1.5M10 15.5V17M3 10h1.5M15.5 10H17M5.1 5.1l1.06 1.06M13.84 13.84l1.06 1.06M5.1 14.9l1.06-1.06M13.84 6.16l1.06-1.06"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                </svg>
              }
              title="Appearance"
            />

            <div className="settings-row">
              <label className="settings-label">Theme</label>
              <ThemePicker />
            </div>

            <div className="settings-row">
              <label className="settings-label">Font size</label>
              <FontSizeStepper />
            </div>

            <div className="settings-row">
              <label className="settings-label">Agent notifications</label>
              <NotificationToggle />
            </div>
          </section>

          <div className="settings-divider" />

          {/* 2 · Command-line tool */}
          <section className="settings-section">
            <SectionHeader icon={<TerminalIcon />} title="Command-line tool" />
            <CliSection />
          </section>

          <div className="settings-divider" />

          {/* 3 · Default Markdown app */}
          <section className="settings-section">
            <SectionHeader icon={<LinkIcon />} title="Default Markdown app" />
            <DefaultHandlerSection />
          </section>

          <div className="settings-divider" />

          {/* 4 · AI memory */}
          <section className="settings-section">
            <SectionHeader icon={<MemoryIcon />} title="AI memory" />
            <MemorySection />
          </section>

          <div className="settings-divider" />

          {/* 5 · Semantic search */}
          <section className="settings-section">
            <SectionHeader icon={<DatabaseIcon />} title="Semantic search" />
            <EmbedSection />
          </section>

          <div className="settings-divider" />

          {/* 6 · AI agents (MCP) */}
          <section className="settings-section">
            <SectionHeader icon={<AgentIcon />} title="AI agents (MCP)" />
            <McpSection />
          </section>
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <div className="settings-footer">
          <button type="button" className="settings-done-btn" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
