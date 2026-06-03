import { pickAndOpen } from "../../lib/openFile";
import { useAIStore } from "../../store/aiStore";
import { useDocumentStore, type ViewMode } from "../../store/documentStore";
import { THEMES, useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.25" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.5v1.25M8 13.25V14.5M1.5 8h1.25M13.25 8H14.5M3.4 3.4l.88.88M11.72 11.72l.88.88M3.4 12.6l.88-.88M11.72 4.28l.88-.88"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2v8M5 7l3 3 3-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.75 11v1.5c0 .414.336.75.75.75h9a.75.75 0 0 0 .75-.75V11"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AIIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5.5 8.5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}

function ThemeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 2.75v10.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 2.75a5.25 5.25 0 0 1 0 10.5z" fill="currentColor" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3l1.5 1.75h5.5c.69 0 1.25.56 1.25 1.25v6c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25v-7.75z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MODES: { id: ViewMode; label: string; title: string }[] = [
  { id: "read", label: "Read", title: "Rendered view" },
  { id: "edit", label: "Edit", title: "WYSIWYG editor" },
  { id: "source", label: "Source", title: "Raw Markdown source" },
];

function ModeToggle() {
  const viewMode = useDocumentStore((s) => s.viewMode);
  const setViewMode = useDocumentStore((s) => s.setViewMode);
  return (
    <div className="mode-toggle">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`mode-btn${viewMode === m.id ? " active" : ""}`}
          onClick={() => setViewMode(m.id)}
          title={m.title}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

export function TitleBar() {
  const path = useDocumentStore((s) => s.path);
  const fileName = useDocumentStore((s) => s.fileName);
  const isDirty = useDocumentStore((s) => s.isDirty);
  const theme = useSettingsStore((s) => s.theme);
  const cycleTheme = useSettingsStore((s) => s.cycleTheme);
  const themeLabel = THEMES.find((t) => t.id === theme)?.label ?? "Theme";
  const openExport = useUiStore((s) => s.openExport);
  const openSettings = useUiStore((s) => s.openSettings);
  const aiOpen = useAIStore((s) => s.open);
  const toggleAI = useAIStore((s) => s.toggle);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left">{path && <ModeToggle />}</div>
      <div className="titlebar-title" data-tauri-drag-region>
        {fileName || "Ashlr MD"}
        {isDirty && (
          <span
            className="dirty-dot"
            role="img"
            title="Unsaved changes"
            aria-label="Unsaved changes"
          />
        )}
      </div>
      <div className="titlebar-actions">
        {path && (
          <button
            className="tb-btn"
            type="button"
            onClick={() => openExport()}
            title="Export document (⌘E)"
          >
            <ExportIcon />
            Export
          </button>
        )}
        <button
          className={`tb-btn${aiOpen ? " active" : ""}`}
          type="button"
          onClick={() => toggleAI()}
          title="AI assistant (⌘K)"
        >
          <AIIcon />
          AI
        </button>
        <button
          className="tb-btn"
          type="button"
          onClick={() => openSettings()}
          title="Preferences (⌘,)"
        >
          <GearIcon />
        </button>
        <button
          className="tb-btn"
          type="button"
          onClick={cycleTheme}
          title={`Theme: ${themeLabel} (⌘⇧L)`}
        >
          <ThemeIcon />
        </button>
        <button
          className="tb-btn"
          type="button"
          onClick={() => pickAndOpen()}
          title="Open a Markdown file (⌘O)"
        >
          <OpenIcon />
          Open
        </button>
      </div>
    </header>
  );
}
