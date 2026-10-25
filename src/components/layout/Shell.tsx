import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from "react";
import "../../styles/ai.css";
import "../../styles/split.css";
import { linkScroll } from "../../lib/syncScroll";
import { useAIStore } from "../../store/aiStore";
import { useDocumentStore } from "../../store/documentStore";
import { useUiStore } from "../../store/uiStore";
import { ActivationBanner } from "../ActivationBanner";
import { ActivityDrawer } from "../ActivityDrawer";
import { SelectionPopover } from "../ai/SelectionPopover";
import { CanvasViewer } from "../canvas/CanvasViewer";
import { DefaultHandlerBanner } from "../DefaultHandlerBanner";
import { DigestCard } from "../DigestCard";
import { FindBar } from "../find/FindBar";
import { Outline } from "../Outline";
import { ReviewPanel } from "../review/ReviewPanel";
import { ShortcutSheet } from "../ShortcutSheet";
import { SearchPanel } from "../search/SearchPanel";
import { SettingsPanel } from "../settings/SettingsPanel";
import { Toast } from "../Toast";
import { Renderer } from "../viewer/Renderer";
import { Welcome } from "../Welcome";
import { Breadcrumb } from "./Breadcrumb";
import { ExternalChangeBanner } from "./ExternalChangeBanner";
import { MissingFileBanner } from "./MissingFileBanner";
import { StatusBar } from "./StatusBar";
import { DOCUMENT_PANEL_ID, TabBar, tabElementId } from "./TabBar";
import { TitleBar } from "./TitleBar";

// Heavy editors — lazy-loaded so they split into their own on-demand chunks.
const MarkdownEditor = lazy(() =>
  import("../editor/MarkdownEditor").then((m) => ({ default: m.MarkdownEditor })),
);
const SourceEditor = lazy(() =>
  import("../editor/SourceEditor").then((m) => ({ default: m.SourceEditor })),
);

// Heavy dialogs / sidebars — lazy-loaded; each gated on its open-state flag.
const AISidebar = lazy(() =>
  import("../ai/AISidebar").then((m) => ({ default: m.AISidebar })),
);
const CommandPalette = lazy(() =>
  import("../CommandPalette").then((m) => ({ default: m.CommandPalette })),
);
const ExportDialog = lazy(() =>
  import("../export/ExportDialog").then((m) => ({ default: m.ExportDialog })),
);

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
  const missing = useDocumentStore((s) => s.missing);
  const exportOpen = useUiStore((s) => s.exportOpen);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const shortcutsOpen = useUiStore((s) => s.shortcutsOpen);
  const findOpen = useUiStore((s) => s.findOpen);
  const aiOpen = useAIStore((s) => s.open);
  const commandPaletteOpen = useUiStore((s) => s.commandPaletteOpen);
  // The TabBar only renders with 2+ docs; when it does, the side docks must
  // start below it so they don't cover the leftmost/rightmost tabs.
  const hasTabs = useDocumentStore((s) => s.tabs.length >= 2);
  const activeId = useDocumentStore((s) => s.activeId);
  // `.canvas` files render in the read-only Canvas viewer, not the MD editor.
  const isCanvas = path?.toLowerCase().endsWith(".canvas") ?? false;
  const contentRef = useRef<HTMLElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // Where each tab's read view was scrolled to, and the tab shown, so that
  // switching back to a tab returns to the place it was read at: every
  // switch scrolled to the top, losing the place in a long document.
  const readScroll = useRef(new Map<string, number>());
  const shownTab = useRef<string | null>(null);

  // In read mode, focus the scroller for keyboard scrolling and reset to top
  // whenever a new document loads or is reloaded. reloadNonce is a deliberate
  // trigger so the reset re-runs after an external reload. A tab switched
  // back to goes to where it was. Before paint, and before the scroll event
  // the new document's height may cause, so that event is the new tab's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce is a deliberate trigger
  useLayoutEffect(() => {
    const switched = activeId !== shownTab.current;
    shownTab.current = activeId;
    if (path && viewMode === "read" && contentRef.current) {
      const back = switched && activeId ? readScroll.current.get(activeId) : undefined;
      contentRef.current.scrollTo({ top: back ?? 0 });
      contentRef.current.focus({ preventScroll: true });
    }
  }, [path, viewMode, reloadNonce, activeId]);

  // Editors remount (fresh initial content) when the file or disk version changes.
  const docKey = `${path}-${reloadNonce}`;
  // Canvas manages its own pan surface — the outer <main> must not scroll.
  const scrolls = viewMode === "read" && !isCanvas;

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
      {missing && !externalChange && <MissingFileBanner />}
      <DefaultHandlerBanner />
      <ActivationBanner />
      <DigestCard />
      {path && <Breadcrumb />}
      <main
        id={DOCUMENT_PANEL_ID}
        className={`app-content${scrolls ? "" : " no-scroll"}`}
        ref={contentRef}
        onScroll={(e) => {
          if (scrolls && shownTab.current) {
            readScroll.current.set(shownTab.current, e.currentTarget.scrollTop);
          }
        }}
        tabIndex={-1}
        // With tabs shown, this is the panel the active tab controls.
        role={hasTabs ? "tabpanel" : undefined}
        aria-labelledby={hasTabs && activeId ? tabElementId(activeId) : undefined}
      >
        {error ? (
          <div className="error-state">{error}</div>
        ) : isLoading ? (
          <div className="loading-state">Opening…</div>
        ) : path && isCanvas ? (
          <CanvasViewer content={content} />
        ) : path ? (
          splitView && viewMode !== "read" ? (
            <div className="split-view" ref={splitRef}>
              <div className="split-pane split-editor">
                <Suspense
                  fallback={<div className="loading-state">Loading editor…</div>}
                >
                  {viewMode === "source" ? (
                    <SourceEditor key={docKey} initialContent={content} />
                  ) : (
                    <MarkdownEditor key={docKey} initialContent={content} />
                  )}
                </Suspense>
              </div>
              <div className="split-pane split-preview" ref={previewRef}>
                <article className="reading-surface">
                  <Renderer content={content} />
                </article>
              </div>
            </div>
          ) : viewMode === "edit" ? (
            <Suspense fallback={<div className="loading-state">Loading editor…</div>}>
              <MarkdownEditor key={docKey} initialContent={content} />
            </Suspense>
          ) : viewMode === "source" ? (
            <Suspense fallback={<div className="loading-state">Loading editor…</div>}>
              <SourceEditor key={docKey} initialContent={content} />
            </Suspense>
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
      {findOpen && path && viewMode === "read" && !isCanvas && <FindBar />}
      {aiOpen && (
        <Suspense fallback={null}>
          <AISidebar />
        </Suspense>
      )}
      <SelectionPopover />
      {exportOpen && (
        <Suspense fallback={null}>
          <ExportDialog />
        </Suspense>
      )}
      {settingsOpen && <SettingsPanel />}
      {shortcutsOpen && <ShortcutSheet />}
      {commandPaletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      )}
      <ReviewPanel />
      <Toast />
    </div>
  );
}
