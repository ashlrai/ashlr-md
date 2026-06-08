import { useState } from "react";
import { useMemoryStore } from "../../../store/memoryStore";

/** "What Ashlr remembers" — local AI memory, fully transparent + editable. */
export function MemorySection() {
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
