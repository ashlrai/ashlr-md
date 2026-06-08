import { useEffect, useState } from "react";
import type { DefaultHandlerStatus } from "../../../lib/defaultHandler";
import { SpinnerIcon } from "../icons";
import type { InstallStatus } from "../types";

/** "Set as default Markdown app" — tri-state, mirrors the top banner. */
export function DefaultHandlerSection() {
  const [status, setStatus] = useState<InstallStatus>({ kind: "idle" });
  const [handler, setHandler] = useState<DefaultHandlerStatus | null>(null);

  // Re-check on open AND on window focus, so confirming in System Settings is
  // reflected here without reopening the panel.
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      import("../../../lib/defaultHandler").then(({ defaultHandlerStatus }) =>
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
        "../../../lib/defaultHandler"
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
    const { openDefaultAppsHelp } = await import("../../../lib/defaultHandler");
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
