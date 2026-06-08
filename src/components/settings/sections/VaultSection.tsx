import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "../../../store/settingsStore";

/** Obsidian vault root — explicit override, else auto-detected from `.obsidian/`. */
export function VaultSection() {
  const vaultRoot = useSettingsStore((s) => s.vaultRoot);
  const setVaultRoot = useSettingsStore((s) => s.setVaultRoot);

  async function pick() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") setVaultRoot(selected);
  }

  return (
    <div className="settings-cli">
      <p className="settings-description">
        Your vault root. Wikilinks like{" "}
        <code className="settings-inline-code">[[note]]</code> and “ask your vault”
        resolve across this folder. By default Ashlr MD auto-detects it from the open
        file's <code className="settings-inline-code">.obsidian/</code> marker.
      </p>
      <div className="settings-cli-row">
        <button type="button" className="settings-action-btn" onClick={pick}>
          {vaultRoot ? "Change vault folder…" : "Choose vault folder…"}
        </button>
        {vaultRoot ? (
          <span className="settings-cli-result settings-result-ok">
            <code className="settings-inline-code">{vaultRoot}</code>
          </span>
        ) : (
          <span className="settings-cli-result settings-description-muted">
            Auto-detecting from <code className="settings-inline-code">.obsidian/</code>
          </span>
        )}
      </div>
      {vaultRoot && (
        <button
          type="button"
          className="settings-memory-clear"
          onClick={() => setVaultRoot(null)}
        >
          Use auto-detect instead
        </button>
      )}
    </div>
  );
}
