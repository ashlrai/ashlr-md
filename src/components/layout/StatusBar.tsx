import { useMemo } from "react";
import { computeDocStats } from "../../lib/wordcount";
import { useDocumentStore } from "../../store/documentStore";
import { THEMES, useSettingsStore } from "../../store/settingsStore";

export function StatusBar() {
  const path = useDocumentStore((s) => s.path);
  const content = useDocumentStore((s) => s.content);
  const isDirty = useDocumentStore((s) => s.isDirty);
  const theme = useSettingsStore((s) => s.theme);
  const themeLabel = THEMES.find((t) => t.id === theme)?.label ?? "";

  const stats = useMemo(() => computeDocStats(content), [content]);

  if (!path) {
    return (
      <footer className="statusbar">
        <span className="spacer" />
        <span className="status-item">{themeLabel}</span>
      </footer>
    );
  }

  return (
    <footer className="statusbar">
      <span className="status-item">{stats.words.toLocaleString()} words</span>
      <span className="status-item">{stats.minutes} min read</span>
      <span className="spacer" />
      <span className="status-item">{isDirty ? "Unsaved — ⌘S to save" : "Saved"}</span>
      <span className="status-item">{themeLabel}</span>
    </footer>
  );
}
