// Settings section: the Anthropic API key (Tier 2).
//
// The sidebar's setup nudge was the only place to enter a key, and it shows
// only when no provider is found, so a saved key could never be replaced or
// removed. This section writes through the same path as the nudge
// (aiStore.setApiKey, which persists to the OS keychain). The key value is
// never displayed, logged, or echoed back: the section says only whether one
// is saved.

import { useEffect, useRef, useState } from "react";
import { type AnthropicEnvKeyStatus, anthropicEnvKeyStatus } from "../../../ai/bridge";
import { isActionEnter, isDismissEscape } from "../../../lib/keymap";
import { useAIStore } from "../../../store/aiStore";

type Note = "none" | "saved" | "removed";

export function AnthropicKeySection() {
  const hasKey = useAIStore((s) => !!s.apiKey);
  const setApiKey = useAIStore((s) => s.setApiKey);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<Note>("none");
  const inputRef = useRef<HTMLInputElement>(null);
  const [envKey, setEnvKey] = useState<AnthropicEnvKeyStatus | null>(null);

  useEffect(() => {
    let live = true;
    anthropicEnvKeyStatus().then((s) => {
      if (live) setEnvKey(s);
    });
    return () => {
      live = false;
    };
  }, []);

  function startEdit() {
    setDraft("");
    setNote("none");
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft("");
  }

  function saveKey() {
    const key = draft.trim();
    if (!key) return;
    setApiKey(key);
    setDraft("");
    setEditing(false);
    setNote("saved");
  }

  function removeKey() {
    setApiKey(null);
    setEditing(false);
    setDraft("");
    setNote("removed");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Not a key that commits or ends an IME composition (see keymap.ts).
    if (isActionEnter(e)) saveKey();
    if (isDismissEscape(e)) cancelEdit();
  }

  return (
    <div className="settings-ai-key">
      <p className="settings-description">
        Ashlr MD uses your Anthropic API key for cloud AI when no on-device or local
        model is available. The key is stored in your OS keychain and is never shown
        here.
      </p>

      {envKey?.enabled && (
        <p
          className={`settings-cli-result ${envKey.usable ? "settings-result-ok" : "settings-result-error"}`}
          data-testid="anthropic-env-key"
        >
          {envKey.usable
            ? `ASHLR_MD_ANTHROPIC_KEY_FROM_ENV is on: the AI sidebar uses ANTHROPIC_API_KEY (${envKey.placeholder ? "a phm_ placeholder" : "a key"}) from the environment, not the key saved here.`
            : envKey.problem}
        </p>
      )}

      {editing ? (
        <div className="settings-cli-row" style={{ flexWrap: "wrap", gap: "8px" }}>
          <input
            ref={inputRef}
            type="password"
            className="settings-text-input"
            placeholder="sk-ant-…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="New Anthropic API key"
            autoComplete="off"
            spellCheck={false}
            style={{ flex: 1, minWidth: "200px" }}
          />
          <button
            type="button"
            className="settings-action-btn"
            onClick={saveKey}
            disabled={!draft.trim()}
          >
            Save key
          </button>
          <button
            type="button"
            className="settings-action-btn settings-action-btn-secondary"
            onClick={cancelEdit}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="settings-cli-row">
          <span className="settings-label settings-ai-key-state" style={{ flex: 1 }}>
            {hasKey ? "A key is saved." : "No key saved."}
          </span>
          <button
            type="button"
            className="settings-action-btn"
            onClick={startEdit}
            aria-label={hasKey ? "Replace Anthropic API key" : "Add Anthropic API key"}
          >
            {hasKey ? "Replace key" : "Add key"}
          </button>
          {hasKey && (
            <button
              type="button"
              className="settings-action-btn settings-action-btn-secondary"
              onClick={removeKey}
              aria-label="Remove Anthropic API key"
            >
              Remove key
            </button>
          )}
        </div>
      )}

      {note === "saved" && !editing && (
        <p className="settings-cli-result settings-result-ok">
          Key saved. The AI sidebar uses it from the next request.
        </p>
      )}
      {note === "removed" && !editing && (
        <p className="settings-cli-result settings-result-ok">Key removed.</p>
      )}
    </div>
  );
}
