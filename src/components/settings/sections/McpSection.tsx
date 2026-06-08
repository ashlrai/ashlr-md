import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, SpinnerIcon } from "../icons";

/** Tracks whether the "Copy" button for the MCP command has been clicked. */
type CopyStatus = "idle" | "copied";

type ConnectStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

/** One-click "connect to your agent" setup + manual MCP command. */
export function McpSection() {
  const [agentClis, setAgentClis] = useState<{
    claude: boolean;
    codex: boolean;
    cursor: boolean;
  } | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<ConnectStatus>({ kind: "idle" });
  const [cursorStatus, setCursorStatus] = useState<ConnectStatus>({ kind: "idle" });
  const [codexStatus, setCodexStatus] = useState<ConnectStatus>({ kind: "idle" });
  const [hookStatus, setHookStatus] = useState<ConnectStatus>({ kind: "idle" });
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
    cmd:
      | "connect_claude_code"
      | "connect_cursor"
      | "connect_codex"
      | "install_claude_hook",
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
  const codexBusy = codexStatus.kind === "busy";
  const hookBusy = hookStatus.kind === "busy";

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
        <button
          type="button"
          className="settings-action-btn"
          onClick={() => connect("connect_codex", setCodexStatus)}
          disabled={codexBusy || agentClis?.codex === false}
          aria-busy={codexBusy}
          title={
            agentClis?.codex === false
              ? "Codex CLI not found"
              : "Register ashlr-md in Codex (~/.codex/config.toml)"
          }
        >
          {codexBusy && <SpinnerIcon />}
          Connect to Codex
        </button>
      </div>
      <Result status={claudeStatus} />
      <Result status={cursorStatus} />
      <Result status={codexStatus} />

      <p
        className="settings-description settings-description-muted"
        style={{ marginTop: "14px" }}
      >
        Auto-open: when Claude Code writes or edits a Markdown file, open it here for
        review — installs a PostToolUse hook in <code>~/.claude/settings.json</code>.
      </p>
      <div className="settings-cli-row">
        <button
          type="button"
          className="settings-action-btn"
          onClick={() => connect("install_claude_hook", setHookStatus)}
          disabled={hookBusy}
          aria-busy={hookBusy}
          title="Install the Claude Code auto-open hook"
        >
          {hookBusy && <SpinnerIcon />}
          Auto-open agent Markdown
        </button>
      </div>
      <Result status={hookStatus} />

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
