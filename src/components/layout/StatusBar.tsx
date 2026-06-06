import { useMemo } from "react";
import { detectDocKind } from "../../lib/agent-detect";
import { parseCanvas } from "../../lib/canvas";
import { computeDocStats } from "../../lib/wordcount";
import { useDocumentStore } from "../../store/documentStore";
import { THEMES, useSettingsStore } from "../../store/settingsStore";

export function StatusBar() {
  const path = useDocumentStore((s) => s.path);
  const content = useDocumentStore((s) => s.content);
  const isDirty = useDocumentStore((s) => s.isDirty);
  const theme = useSettingsStore((s) => s.theme);
  const themeLabel = THEMES.find((t) => t.id === theme)?.label ?? "";

  const isCanvas = path?.toLowerCase().endsWith(".canvas") ?? false;
  const stats = useMemo(() => computeDocStats(content), [content]);
  // Surface live task progress for agent plan/checklist docs (instant payoff).
  const tasks = useMemo(() => detectDocKind(content), [content]);
  // For a canvas, word count is meaningless — show node/edge counts instead.
  const canvasInfo = useMemo(() => {
    if (!isCanvas) return null;
    const r = parseCanvas(content);
    return r.ok ? { nodes: r.canvas.nodes.length, edges: r.canvas.edges.length } : null;
  }, [isCanvas, content]);

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
      {isCanvas ? (
        <span className="status-item">
          Canvas
          {canvasInfo ? ` · ${canvasInfo.nodes} nodes · ${canvasInfo.edges} edges` : ""}
        </span>
      ) : (
        <>
          <span className="status-item">{stats.words.toLocaleString()} words</span>
          <span className="status-item">{stats.minutes} min read</span>
          {tasks.taskTotal > 0 && (
            <span className="status-item" title="Checklist progress in this document">
              {tasks.taskDone} / {tasks.taskTotal} tasks
            </span>
          )}
        </>
      )}
      <span className="spacer" />
      <span className="status-item">{isDirty ? "Unsaved — ⌘S to save" : "Saved"}</span>
      <span className="status-item">{themeLabel}</span>
    </footer>
  );
}
