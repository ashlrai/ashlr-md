import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { SpinnerIcon } from "../icons";
import type { InstallStatus } from "../types";

/** Installs the `mdopen` CLI companion via Tauri IPC. */
export function CliSection() {
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
