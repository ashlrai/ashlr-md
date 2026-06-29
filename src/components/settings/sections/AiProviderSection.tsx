// Settings section — Hosted AI provider (Tier 3) token management.
//
// Lets the user add or remove their Ashlr MD Cloud bearer token.
// The token is stored in the OS keychain via aiStore.setHostedToken().

import { useRef, useState } from "react";
import { useAIStore } from "../../../store/aiStore";

type SaveStatus = "idle" | "saved" | "error";

export function AiProviderSection() {
  const hostedToken = useAIStore((s) => s.hostedToken);
  const setHostedToken = useAIStore((s) => s.setHostedToken);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft("");
    setSaveStatus("idle");
    setEditing(true);
    // Focus the input on next tick.
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft("");
    setSaveStatus("idle");
  }

  function saveToken() {
    const trimmed = draft.trim();
    if (!trimmed) {
      setSaveStatus("error");
      return;
    }
    setHostedToken(trimmed);
    setSaveStatus("saved");
    setEditing(false);
    setDraft("");
  }

  function removeToken() {
    setHostedToken(null);
    setSaveStatus("idle");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") saveToken();
    if (e.key === "Escape") cancelEdit();
  }

  return (
    <div className="settings-ai-provider">
      <p className="settings-description">
        Add an Ashlr MD Cloud token to enable the hosted AI tier. The token is stored
        securely in your OS keychain and used as a fallback when Anthropic key is absent.
      </p>

      {hostedToken ? (
        <div className="settings-cli-row">
          <span className="settings-label" style={{ flex: 1 }}>
            Token:{" "}
            <code style={{ opacity: 0.7 }}>
              {hostedToken.slice(0, 6)}{"•".repeat(Math.min(hostedToken.length - 6, 24))}
            </code>
          </span>
          <button
            type="button"
            className="settings-action-btn"
            onClick={removeToken}
            aria-label="Remove hosted AI token"
          >
            Remove token
          </button>
        </div>
      ) : editing ? (
        <div className="settings-cli-row" style={{ flexWrap: "wrap", gap: "8px" }}>
          <input
            ref={inputRef}
            type="password"
            className="settings-text-input"
            placeholder="Paste bearer token…"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSaveStatus("idle");
            }}
            onKeyDown={handleKeyDown}
            aria-label="Hosted AI bearer token"
            autoComplete="off"
            style={{ flex: 1, minWidth: "200px" }}
          />
          <button
            type="button"
            className="settings-action-btn"
            onClick={saveToken}
            disabled={!draft.trim()}
          >
            Save
          </button>
          <button
            type="button"
            className="settings-action-btn settings-action-btn-secondary"
            onClick={cancelEdit}
          >
            Cancel
          </button>
          {saveStatus === "error" && (
            <p className="settings-cli-result settings-result-error">
              Token cannot be empty.
            </p>
          )}
        </div>
      ) : (
        <div className="settings-cli-row">
          <button
            type="button"
            className="settings-action-btn"
            onClick={startEdit}
            aria-label="Add hosted AI token"
          >
            Add token
          </button>
        </div>
      )}

      {saveStatus === "saved" && !editing && (
        <p className="settings-cli-result settings-result-ok">
          Token saved to keychain.
        </p>
      )}
    </div>
  );
}
