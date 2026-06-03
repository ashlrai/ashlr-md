import { useEffect, useRef } from "react";
import "../../styles/ai.css";
import { useDocumentStore } from "../../store/documentStore";
import { useUiStore } from "../../store/uiStore";
import { AISidebar } from "../ai/AISidebar";
import { SelectionPopover } from "../ai/SelectionPopover";
import { DefaultHandlerBanner } from "../DefaultHandlerBanner";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import { SourceEditor } from "../editor/SourceEditor";
import { ExportDialog } from "../export/ExportDialog";
import { SettingsPanel } from "../settings/SettingsPanel";
import { Renderer } from "../viewer/Renderer";
import { Welcome } from "../Welcome";
import { ExternalChangeBanner } from "./ExternalChangeBanner";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";

interface ShellProps {
  dragOver: boolean;
}

export function Shell({ dragOver }: ShellProps) {
  const path = useDocumentStore((s) => s.path);
  const content = useDocumentStore((s) => s.content);
  const error = useDocumentStore((s) => s.error);
  const isLoading = useDocumentStore((s) => s.isLoading);
  const viewMode = useDocumentStore((s) => s.viewMode);
  const reloadNonce = useDocumentStore((s) => s.reloadNonce);
  const externalChange = useDocumentStore((s) => s.externalChange);
  const exportOpen = useUiStore((s) => s.exportOpen);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const contentRef = useRef<HTMLElement>(null);

  // In read mode, focus the scroller for keyboard scrolling and reset to top
  // whenever a new document loads or is reloaded. reloadNonce is a deliberate
  // trigger so the reset re-runs after an external reload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce is a deliberate trigger
  useEffect(() => {
    if (path && viewMode === "read" && contentRef.current) {
      contentRef.current.scrollTo({ top: 0 });
      contentRef.current.focus({ preventScroll: true });
    }
  }, [path, viewMode, reloadNonce]);

  // Editors remount (fresh initial content) when the file or disk version changes.
  const docKey = `${path}-${reloadNonce}`;
  const scrolls = viewMode === "read";

  return (
    <div className={`app-shell${dragOver ? " drag-over" : ""}`}>
      <TitleBar />
      {externalChange && <ExternalChangeBanner />}
      <DefaultHandlerBanner />
      <main
        className={`app-content${scrolls ? "" : " no-scroll"}`}
        ref={contentRef}
        tabIndex={-1}
      >
        {error ? (
          <div className="error-state">{error}</div>
        ) : isLoading ? (
          <div className="loading-state">Opening…</div>
        ) : path ? (
          viewMode === "edit" ? (
            <MarkdownEditor key={docKey} initialContent={content} />
          ) : viewMode === "source" ? (
            <SourceEditor key={docKey} initialContent={content} />
          ) : (
            <article className="reading-surface">
              <Renderer content={content} />
            </article>
          )
        ) : (
          <Welcome />
        )}
      </main>
      <StatusBar />
      <AISidebar />
      <SelectionPopover />
      {exportOpen && <ExportDialog />}
      {settingsOpen && <SettingsPanel />}
    </div>
  );
}
