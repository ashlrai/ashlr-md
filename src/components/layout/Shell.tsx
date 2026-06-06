import { useEffect, useRef } from "react";
import "../../styles/ai.css";
import "../../styles/split.css";
import { linkScroll } from "../../lib/syncScroll";
import { useDocumentStore } from "../../store/documentStore";
import { useUiStore } from "../../store/uiStore";
import { ActivationBanner } from "../ActivationBanner";
import { ActivityDrawer } from "../ActivityDrawer";
import { AISidebar } from "../ai/AISidebar";
import { SelectionPopover } from "../ai/SelectionPopover";
import { CommandPalette } from "../CommandPalette";
import { DefaultHandlerBanner } from "../DefaultHandlerBanner";
import { DigestCard } from "../DigestCard";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import { SourceEditor } from "../editor/SourceEditor";
import { ExportDialog } from "../export/ExportDialog";
import { FindBar } from "../find/FindBar";
import { Outline } from "../Outline";
import { ReviewPanel } from "../review/ReviewPanel";
import { SearchPanel } from "../search/SearchPanel";
import { SettingsPanel } from "../settings/SettingsPanel";
import { Toast } from "../Toast";
import { Renderer } from "../viewer/Renderer";
import { Welcome } from "../Welcome";
import { Breadcrumb } from "./Breadcrumb";
import { ExternalChangeBanner } from "./ExternalChangeBanner";
import { StatusBar } from "./StatusBar";
import { TabBar } from "./TabBar";
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
  const splitView = useDocumentStore((s) => s.splitView);
  const zenMode = useUiStore((s) => s.zenMode);
  const reloadNonce = useDocumentStore((s) => s.reloadNonce);
  const externalChange = useDocumentStore((s) => s.externalChange);
  const exportOpen = useUiStore((s) => s.exportOpen);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const findOpen = useUiStore((s) => s.findOpen);
  // The TabBar only renders with 2+ docs; when it does, the side docks must
  // start below it so they don't cover the leftmost/rightmost tabs.
  const hasTabs = useDocumentStore((s) => s.tabs.length >= 2);
  const contentRef = useRef<HTMLElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

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

  // Synchronize editor↔preview scrolling (proportional) while split is active.
  // The editor manages its own internal scroller, which may mount asynchronously
  // (Milkdown), so retry briefly until it appears. `docKey` re-attaches on
  // file/version change.
  useEffect(() => {
    if (!(splitView && viewMode !== "read")) return;
    const container = splitRef.current;
    const preview = previewRef.current;
    if (!container || !preview) return;
    let cleanup: (() => void) | undefined;
    let timer = 0;
    let tries = 0;
    const attach = () => {
      const editorScroller = container.querySelector<HTMLElement>(
        ".split-editor .cm-scroller, .split-editor .milkdown, .split-editor .ProseMirror",
      );
      if (editorScroller) {
        cleanup = linkScroll(editorScroller, preview);
      } else if (tries++ < 12) {
        timer = window.setTimeout(attach, 120);
      }
    };
    timer = window.setTimeout(attach, 0);
    return () => {
      window.clearTimeout(timer);
      cleanup?.();
    };
  }, [splitView, viewMode, docKey]);

  return (
    <div
      className={`app-shell${dragOver ? " drag-over" : ""}${hasTabs ? " has-tabs" : ""}${zenMode ? " zen" : ""}`}
    >
      <TitleBar />
      {/* Renders nothing unless 2+ docs are open — single-doc layout unchanged. */}
      <TabBar />
      {externalChange && <ExternalChangeBanner />}
      <DefaultHandlerBanner />
      <ActivationBanner />
      <DigestCard />
      {path && <Breadcrumb />}
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
          splitView && viewMode !== "read" ? (
            <div className="split-view" ref={splitRef}>
              <div className="split-pane split-editor">
                {viewMode === "source" ? (
                  <SourceEditor key={docKey} initialContent={content} />
                ) : (
                  <MarkdownEditor key={docKey} initialContent={content} />
                )}
              </div>
              <div className="split-pane split-preview" ref={previewRef}>
                <article className="reading-surface">
                  <Renderer content={content} />
                </article>
              </div>
            </div>
          ) : viewMode === "edit" ? (
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
      <ActivityDrawer />
      <Outline />
      <SearchPanel />
      {findOpen && path && viewMode === "read" && <FindBar />}
      <AISidebar />
      <SelectionPopover />
      {exportOpen && <ExportDialog />}
      {settingsOpen && <SettingsPanel />}
      <CommandPalette />
      <ReviewPanel />
      <Toast />
    </div>
  );
}
